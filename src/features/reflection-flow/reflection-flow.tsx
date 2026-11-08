'use client'

import Link from 'next/link'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { ApprovedLearning, Trip } from '@/domain'
import {
  ClientAuthError,
  initializeAnonymousSession,
  startNewAnonymousSession,
} from '@/lib/auth/client'
import { useSessionScope } from '@/lib/auth/use-session-scope'
import { LearningReview } from '@/features/learning-review/learning-review'

import {
  createFirestoreLearningStore,
  isCompleteList,
  loadReflectionHistory,
  loadSavedLearnings,
  loadSavedTrips,
  sameLearning,
  userMessageOf,
  type LearningList,
  type ReflectionHistory,
} from './api-client'
import { createRequestGate } from './request-gate'
import { bind, valueIn, type Bound, type HeldSession } from './session-bound'

type TripsPhase =
  { kind: 'ready'; trips: Trip[]; warning: string } | { kind: 'error'; message: string }

type HistoryPhase = { tripId: string } & (
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; history: ReflectionHistory }
)

type SavedPhase = { kind: 'ready'; list: LearningList } | { kind: 'error'; message: string }

// 画面の最上部に出す、認証・読み込みの失敗。
// canStartNew は、利用できる認証状態が無い（session_ended）ときだけ true。
// 通信断・保存機能の停止・不正な応答では、新しい利用を始めても直らないため、開始操作を出さない。
type TopError = { message: string; canStartNew: boolean }

const NO_APPROVED: ApprovedLearning[] = []

const SESSION_CHANGED_NOTICE =
  '認証セッションが変わったため、前のセッションの旅行・学び・入力中の内容を破棄し、進行中の保存を中止しました。' +
  '保存済み／未保存／結果不明は、必要に応じて再確認してください。'

// 保存済みの一覧が表すもの。画面上の編集・却下では変わらないことを、事実として示す。
const SAVED_LIST_NOTE =
  'ここに表示しているのは、保存先で承認が有効な学びです。' +
  '上の画面で候補を編集・却下しても、この一覧の承認は取り消されません。' +
  '保存済みの学びを撤回する操作は、まだ提供していません。'

interface ReflectionFlowProps {
  initialTripId?: string
  // トップ画面の中に置くとき。ページの見出し（h1）を持たず、節の見出しとして出す。
  embedded?: boolean
  // 学びの保存を試みたあとに呼ぶ（成功・失敗にかかわらず）。次の旅の学びの選択を読み込み直すために使う。
  onLearningsChanged?: () => void
}

export function ReflectionFlow({
  initialTripId,
  embedded = false,
  onLearningsChanged,
}: ReflectionFlowProps) {
  // トップ画面の中では、見出しをh3・h4にする（トップ画面の旅程の節がh2のため）。
  const SubHeading = embedded ? 'h4' : 'h2'
  const auth = useSessionScope()
  const [bootError, setBootError] = useState<TopError | null>(null)
  // 直近に認証済みだったセッション。認証の確認中・失敗の間も、UIDが同じなら画面の内容を保つ。
  // UIDまたは世代が変わったら、新しいセッションに置き換わり、前のセッションの内容は見えなくなる。
  const [held, setHeld] = useState<HeldSession | null>(null)
  if (auth.status === 'authenticated' && (held === null || held.scope !== auth.scope)) {
    setHeld({ scope: auth.scope, epoch: auth.scopeEpoch })
  }
  const heldSessionKey = held ? JSON.stringify([held.epoch, held.scope.uid]) : ''
  // Auth listener が世代を同期的に進めた時点で、React state更新を待たず古い内容を隠す。
  const visibleHeld = held?.epoch === auth.scopeEpoch ? held : null

  const [tripsBound, setTripsBound] = useState<Bound<TripsPhase> | null>(null)
  const [tripsAttempt, setTripsAttempt] = useState(0)
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)
  // 未保存の承認があるときに、別の旅行へ切り替える前の確認を待っている切り替え先。
  const [pendingTripId, setPendingTripId] = useState<string | null>(null)
  const [historyBound, setHistoryBound] = useState<Bound<HistoryPhase> | null>(null)
  const [reloadAttempt, setReloadAttempt] = useState(0)
  const [savedBound, setSavedBound] = useState<Bound<SavedPhase> | null>(null)
  const [sessionNotice, setSessionNotice] = useState('')
  const bootRequestRef = useRef(0)
  // 保存ストアは認証セッションごとに作る（版の記憶を持つ）ため、通知の関数はrefで持ち、作り直さない。
  const learningsChangedRef = useRef(onLearningsChanged)
  useEffect(() => {
    learningsChangedRef.current = onLearningsChanged
  }, [onLearningsChanged])
  // 取得の種類ごとの札。遅れて届いた古い応答や、別のセッションの応答を採用しない。
  const [tripsGate] = useState(createRequestGate)
  const [historyGate] = useState(createRequestGate)
  const [savedGate] = useState(createRequestGate)
  // いま画面で承認済みの学び（LearningReviewから通知される）。未保存かどうかの判定に使う。
  const approvedRef = useRef<ApprovedLearning[]>(NO_APPROVED)
  const confirmRef = useRef<HTMLDivElement>(null)
  const switchTriggerRef = useRef<HTMLElement | null>(null)

  // セッションが変わったら、選択・確認待ち・読み直しを捨てる（描画中の状態調整）。
  // 取得済みの結果は、セッションと組で持つので、ここで消さなくても別のセッションの画面には見えない。
  const [lastSessionKey, setLastSessionKey] = useState('')
  if (heldSessionKey !== lastSessionKey) {
    setLastSessionKey(heldSessionKey)
    setSelectedTripId(null)
    setPendingTripId(null)
    setReloadAttempt(0)
    setSessionNotice(lastSessionKey !== '' && heldSessionKey !== '' ? SESSION_CHANGED_NOTICE : '')
    // 認証済みのセッションが得られたので、それまでの認証の失敗は解消した。
    if (heldSessionKey !== '') setBootError(null)
  }
  useEffect(() => {
    approvedRef.current = NO_APPROVED
  }, [heldSessionKey])

  const openSession = useCallback(async (newAccount: boolean) => {
    const request = ++bootRequestRef.current
    setBootError(null)
    try {
      if (newAccount) {
        // 過去の匿名UIDを復旧できない可能性を説明したボタンからだけ実行する。
        await startNewAnonymousSession()
      } else {
        await initializeAnonymousSession()
      }
    } catch (error) {
      if (request !== bootRequestRef.current) return
      setBootError({
        message: userMessageOf(error),
        canStartNew: error instanceof ClientAuthError && error.code === 'session_ended',
      })
    }
  }, [])

  useEffect(() => {
    void openSession(false)
    return () => {
      bootRequestRef.current += 1
    }
  }, [openSession])

  // 保存済みの旅行の取得。認証済みのセッションごとに、そのセッションのトークンで取得する。
  useEffect(() => {
    if (!visibleHeld) return
    const ticket = tripsGate.begin()
    loadSavedTrips(visibleHeld.scope, { signal: ticket.signal }).then(
      (list) => {
        if (!ticket.isCurrent()) return
        const warning = isCompleteList(list.listInfo, list.trips.length)
          ? ''
          : '一部の旅程を表示できません。保存データの状態を確認してください。'
        setTripsBound(bind(visibleHeld, { kind: 'ready', trips: list.trips, warning }))
        if (initialTripId && list.trips.some((trip) => trip.id === initialTripId)) {
          setSelectedTripId(initialTripId)
        }
      },
      (error: unknown) => {
        if (!ticket.isCurrent()) return
        setTripsBound(bind(visibleHeld, { kind: 'error', message: userMessageOf(error) }))
      },
    )
    return () => tripsGate.cancel()
  }, [visibleHeld, tripsAttempt, initialTripId, tripsGate])

  const trips = valueIn(tripsBound, visibleHeld)
  const tripsReady = trips?.kind === 'ready'

  // 選んだ旅行と変更履歴の取得。旅行を選び直したときは、古い応答を採用しない。
  useEffect(() => {
    if (!visibleHeld || !selectedTripId || !tripsReady) return
    const tripId = selectedTripId
    const ticket = historyGate.begin()
    setHistoryBound(bind(visibleHeld, { tripId, kind: 'loading' }))
    loadReflectionHistory(visibleHeld.scope, tripId, { signal: ticket.signal }).then(
      (history) => {
        if (ticket.isCurrent())
          setHistoryBound(bind(visibleHeld, { tripId, kind: 'ready', history }))
      },
      (error: unknown) => {
        if (ticket.isCurrent()) {
          setHistoryBound(
            bind(visibleHeld, { tripId, kind: 'error', message: userMessageOf(error) }),
          )
        }
      },
    )
    return () => historyGate.cancel()
  }, [visibleHeld, selectedTripId, tripsReady, reloadAttempt, historyGate])

  const historyValue = valueIn(historyBound, visibleHeld)
  const history = selectedTripId && historyValue?.tripId === selectedTripId ? historyValue : null

  // 保存済みの学びの取得。保存直後の再取得と重なっても、古い応答が新しい一覧を上書きしない。
  const refreshSaved = useCallback(async () => {
    if (!visibleHeld) return
    const ticket = savedGate.begin()
    try {
      const result = await loadSavedLearnings(visibleHeld.scope, { signal: ticket.signal })
      if (!ticket.isCurrent()) return
      setSavedBound(
        bind(
          visibleHeld,
          isCompleteList(result.listInfo, result.learnings.length)
            ? { kind: 'ready', list: result }
            : { kind: 'error', message: '保存済みの学びをすべて確認できませんでした。' },
        ),
      )
    } catch (error) {
      if (!ticket.isCurrent()) return
      setSavedBound(bind(visibleHeld, { kind: 'error', message: userMessageOf(error) }))
    }
  }, [visibleHeld, savedGate])
  // セッションが変わるとき、画面を閉じるときは、進行中の取得を中止し、結果を採用しない。
  useEffect(() => () => savedGate.cancel(), [visibleHeld, savedGate])

  const loadedTripId = history?.kind === 'ready' ? history.history.trip.id : null
  useEffect(() => {
    if (loadedTripId) void refreshSaved()
  }, [loadedTripId, refreshSaved])

  const savedValue = valueIn(savedBound, visibleHeld)
  const saved = savedValue?.kind === 'ready' ? savedValue.list : null
  const savedError = savedValue?.kind === 'error' ? savedValue.message : ''

  // 保存の相手は、画面が結び付いているセッション。セッションごとに作り直し、版の記憶も混ぜない。
  const store = useMemo(
    () =>
      visibleHeld
        ? createFirestoreLearningStore(visibleHeld.scope, () => {
            void refreshSaved()
            learningsChangedRef.current?.()
          })
        : undefined,
    [visibleHeld, refreshSaved],
  )

  const handleApprovedChange = useCallback((approved: ApprovedLearning[]) => {
    approvedRef.current = approved
  }, [])

  // 保存先に同じ内容で保存されていない承認済みの学びの数。保存済みの一覧を確認できないときは、すべて未保存とみなす。
  const countUnsaved = () =>
    approvedRef.current.filter(
      (approved) => !saved?.learnings.some((entry) => sameLearning(entry.learning, approved)),
    ).length

  const switchTrip = (tripId: string) => {
    approvedRef.current = NO_APPROVED
    setPendingTripId(null)
    setSelectedTripId(tripId)
  }

  const requestTrip = (tripId: string, trigger: HTMLElement) => {
    if (tripId === selectedTripId) {
      setPendingTripId(null)
      return
    }
    // 別の旅行へ切り替えると、確認中の候補・承認・入力は消える。未保存の承認があるときは、先に確認する。
    if (history?.kind === 'ready' && countUnsaved() > 0) {
      switchTriggerRef.current = trigger
      setPendingTripId(tripId)
      return
    }
    switchTrip(tripId)
  }

  useEffect(() => {
    if (pendingTripId) confirmRef.current?.focus()
  }, [pendingTripId])

  const cancelSwitch = () => {
    setPendingTripId(null)
    switchTriggerRef.current?.focus()
  }
  const confirmSwitch = () => {
    if (!pendingTripId) return
    switchTrip(pendingTripId)
    switchTriggerRef.current?.focus()
  }
  const onConfirmKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') cancelSwitch()
  }

  // 認証が使えない（復元の失敗・サービス停止）ときの案内と、保存先の失敗は、別の理由として示す。
  const authProblem =
    auth.status === 'session_ended' || auth.status === 'error' ? auth.error : undefined
  const topError: TopError | null =
    bootError ??
    (authProblem
      ? { message: authProblem.message, canStartNew: authProblem.code === 'session_ended' }
      : trips?.kind === 'error'
        ? { message: trips.message, canStartNew: false }
        : null)
  const loading = !topError && !tripsReady
  // 表示中の内容は残したまま、認証を確認し直している間。確認できるまで保存はできない。
  const authPending = held !== null && auth.status === 'restoring'

  const retry = () => {
    setTripsBound(null)
    setTripsAttempt((value) => value + 1)
    void openSession(false)
  }

  const sessionTrips = trips?.kind === 'ready' ? trips.trips : []
  const pendingTrip = sessionTrips.find((trip) => trip.id === pendingTripId)
  const sourceTripLabel = (sourceTripId: string): string => {
    const trip = sessionTrips.find((candidate) => candidate.id === sourceTripId)
    return trip ? trip.region + '（' + trip.date + '）' : '保存済みの旅行の一覧にない旅行'
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        {embedded ? (
          <h3 className="text-lg font-semibold">保存した旅行を振り返る</h3>
        ) : (
          <h1 className="text-2xl font-semibold">保存した旅行を振り返る</h1>
        )}
        <p className="text-sm">
          保存した旅程を選び、感想と変更履歴から次の旅のための学びを作ります。
          学びは本人が確認・承認して保存するまで、次回には使われません。
        </p>
      </header>
      {sessionNotice && (
        <p role="alert" className="rounded border-2 border-current p-3 text-sm">
          {sessionNotice}
        </p>
      )}
      {loading && <p role="status">保存した旅程と認証状態を確認しています…</p>}
      {authPending && (
        <p role="status" className="text-sm">
          認証の状態を確認しています。確認できるまで、保存はできません。
        </p>
      )}
      {topError && (
        <section className="space-y-3 rounded border border-current/40 p-4">
          <p role="alert">{topError.message}</p>
          {topError.canStartNew && (
            <>
              <p className="text-sm">
                認証に失敗しても、別の匿名アカウントを自動作成しません。
                以前の旅程がある場合は、まず同じブラウザで再試行してください。
              </p>
              <p id="new-session-warning" className="text-sm font-medium">
                新しい利用を始めると、これまでの旅行や学びの保存データに戻れないことがあります。
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-current/50 px-4 py-3"
              onClick={retry}
            >
              再試行
            </button>
            {topError.canStartNew && (
              <button
                type="button"
                aria-describedby="new-session-warning"
                className="rounded border border-current/50 px-4 py-3"
                onClick={() => void openSession(true)}
              >
                新しい利用を始める
              </button>
            )}
          </div>
        </section>
      )}
      {trips?.kind === 'ready' && (
        <section className="space-y-3" aria-labelledby="saved-trips-heading">
          <SubHeading id="saved-trips-heading" className="text-lg font-semibold">
            保存済みの旅行
          </SubHeading>
          {trips.warning && (
            <p role="alert" className="text-sm">
              {trips.warning}
            </p>
          )}
          {trips.trips.length === 0 ? (
            <div className="space-y-2 rounded border border-current/30 p-4 text-sm">
              <p>保存された旅行がありません。</p>
              <p>
                旅行計画を作るだけでは保存されません。保存が完了した旅程だけを、振り返りに使えます。
              </p>
              <Link className="underline" href="/">
                旅行計画へ戻る
              </Link>
            </div>
          ) : (
            <ul className="space-y-2">
              {trips.trips.map((trip) => (
                <li key={trip.id}>
                  <button
                    type="button"
                    aria-pressed={selectedTripId === trip.id}
                    onClick={(event) => requestTrip(trip.id, event.currentTarget)}
                    className="w-full rounded border border-current/40 px-4 py-3 text-left aria-pressed:border-2"
                  >
                    <span className="font-medium">{trip.region}</span>
                    <span className="ml-3 text-sm">{trip.date}</span>
                    <span className="block text-sm">
                      {trip.stops.length}地点・保存済み — 振り返る
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pendingTripId && (
            <div
              ref={confirmRef}
              tabIndex={-1}
              role="group"
              aria-labelledby="switch-confirm-heading"
              aria-describedby="switch-confirm-description"
              onKeyDown={onConfirmKeyDown}
              className="space-y-3 rounded border-2 border-current p-4"
            >
              <h3 id="switch-confirm-heading" className="text-base font-semibold">
                まだ保存していない承認済みの学びがあります
              </h3>
              <p id="switch-confirm-description" className="text-sm">
                {pendingTrip ? pendingTrip.region + '（' + pendingTrip.date + '）' : '別の旅行'}
                に切り替えると、保存していない承認済みの学びと、入力した感想・確認中の候補は消えます。
                すでに保存した学びは消えません。
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded border border-current/50 px-4 py-3"
                  onClick={cancelSwitch}
                >
                  この旅行に残る
                </button>
                <button
                  type="button"
                  className="rounded border border-current/50 px-4 py-3"
                  onClick={confirmSwitch}
                >
                  保存せずに切り替える
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      {history?.kind === 'loading' && <p role="status">旅行と変更履歴を読み込んでいます…</p>}
      {history?.kind === 'error' && (
        <section className="space-y-2" role="alert">
          <p>{history.message}</p>
          <p className="text-sm">
            変更履歴が不完全な場合、誤った学びを作らないため振り返りを開始しません。
          </p>
          {selectedTripId && (
            <button
              className="rounded border border-current/50 px-4 py-3"
              type="button"
              onClick={() => setReloadAttempt((value) => value + 1)}
            >
              読み込み直す
            </button>
          )}
        </section>
      )}
      {history?.kind === 'ready' && (
        <section className="space-y-4">
          <p className="rounded border border-current/30 p-3 text-sm">
            {history.history.trip.region}（{history.history.trip.date}
            ）の保存済みデータを表示しています。 保存された修正案は、すべて未承認です。
            未承認の変更や模擬報告は、実際に起きた出来事として学びにしません。
          </p>
          <LearningReview
            // 旅行が変わったら、候補・承認・入力・進行中の保存を捨てて作り直す。
            // セッションが変わったときは、履歴がそのセッションに結び付いていて見えなくなるので、同じく作り直される。
            key={history.history.trip.id}
            trip={history.history.trip}
            scope={visibleHeld?.scope}
            revisions={history.history.revisions}
            store={store}
            canSave={auth.status === 'authenticated' && auth.scope === visibleHeld?.scope}
            saveDisabledLabel={
              auth.status === 'restoring' ? '認証を確認中…' : '認証を確認できません'
            }
            onApprovedChange={handleApprovedChange}
          />
          <section aria-labelledby="saved-learnings-heading" className="space-y-2">
            <SubHeading id="saved-learnings-heading" className="text-lg font-semibold">
              保存済みの学び
            </SubHeading>
            <p id="saved-learnings-note" className="text-sm">
              {SAVED_LIST_NOTE}
            </p>
            <button
              type="button"
              className="rounded border border-current/50 px-3 py-2 text-sm"
              onClick={() => void refreshSaved()}
            >
              保存済みの学びを読み込み直す
            </button>
            {savedError && (
              <p role="alert" className="text-sm">
                {savedError}
              </p>
            )}
            {!savedError && !saved && (
              <p role="status" className="text-sm">
                取得中…
              </p>
            )}
            {saved && saved.learnings.length === 0 && (
              <p className="text-sm">保存済みの学びはありません。</p>
            )}
            {saved && saved.learnings.length > 0 && (
              <ul className="space-y-2">
                {saved.learnings.map(({ learning }) => (
                  <li key={learning.id} className="rounded border border-current/30 p-3 text-sm">
                    <p className="break-words font-medium">{learning.content}</p>
                    <p>
                      適用範囲：
                      {learning.scope.kind === 'all_trips'
                        ? 'すべての旅行'
                        : learning.scope.region + 'の旅行'}
                    </p>
                    <p className="break-words">
                      元の旅行：{sourceTripLabel(learning.sourceTripId)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      )}
    </div>
  )
}
