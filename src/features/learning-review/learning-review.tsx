'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from 'react'

import type { ApprovedLearning, Learning, Revision, Trip } from '@/domain'
import { observeAuthState } from '@/lib/auth/client'
import {
  classifyProtectedHeaderError,
  PROTECTED_FAILURE_MESSAGES,
} from '@/lib/auth/protected-api-errors'
import {
  assertCurrentSessionScopeSync,
  captureSessionScope,
  type SessionScope,
} from '@/lib/auth/session-scope'
import { MAX_LEARNING_CONTENT_LENGTH } from '@/lib/learnings/lifecycle'
import { hasMaterial, isSimulated, revisionMaterialStatus } from '@/lib/learnings/material'

import {
  requestLearningCandidates,
  type CandidatesFailure,
  type CandidatesOptions,
  type CandidatesRequest,
  type CandidatesResult,
} from './api-client'
import { validateIncomingCandidates } from './intake'
import {
  approvedOf,
  initialReviewState,
  reviewReducer,
  type ReviewAction,
  type ReviewItem,
} from './review-model'
import type { LearningStore } from './store'
import { useApprovedSave, type SaveStatus } from './use-approved-save'

const MAX_FEEDBACK_LENGTH = 1000
const NO_REVISIONS: Revision[] = []

export type RequestCandidates = (
  request: CandidatesRequest,
  options?: CandidatesOptions,
) => Promise<CandidatesResult>

interface LearningReviewProps {
  trip: Trip
  // trip・revisionsを取得した認証セッション。指定すると、候補の生成はこのセッションのトークンでだけ送り、
  // セッションが変わったら送らず、古い結果も採用しない。実データを渡す画面は必ず指定する。
  scope?: SessionScope
  // 架空の旅程を実APIに送る画面では、表示時ではなく候補生成の操作時に認証世代を取る。
  bindCandidatesToCurrentSession?: boolean
  // 旅行中に行った部分修正の履歴。承認した、実際の報告に基づくものだけが、学びの材料になる。
  revisions?: Revision[]
  // テスト・先行開発で差し替える。省略時は実際のAPIを呼ぶ。
  requestCandidates?: RequestCandidates
  now?: () => Date
  // 承認済みの学びが変わるたびに呼ぶ（保存は呼び出し側の責務。承認済みだけが渡る）。
  onApprovedChange?: (approved: ApprovedLearning[]) => void
  // 承認済みの学びの保存先。省略時は保存せず、承認した内容がこの画面の中だけにあることを示す。
  // 保存の状態（未保存・保存中・保存済み・失敗）は、承認とは別に示し、承認しただけでは保存済みと表示しない。
  store?: LearningStore
  // 認証状態を確認できない間は、見えている保存先があっても保存操作を受け付けない。
  canSave?: boolean
  saveDisabledLabel?: string
}

const CATEGORY_LABEL: Record<Learning['category'], string> = {
  verification: '情報源との不一致',
  preference: '個人の好み・経験',
}

const STATUS_LABEL = {
  pending: '未承認',
  approved: '承認済み',
  rejected: '却下',
} as const

const APPROVAL_LABEL = {
  pending: '未承認',
  approved: '承認済み',
  rejected: '却下',
} as const

// 報告の種類と承認状態は、独立して示す（模擬報告を、実際の体験と取り違えない）。
function revisionKindLabel(revision: Revision): string {
  if (revision.context.phase !== 'on_site') return '旅行前の修正'
  return isSimulated(revision)
    ? '模擬報告（デモ用の想定。実際の出来事ではありません）'
    : '現地の実際の報告'
}

const REVISION_MATERIAL_LABEL = {
  usable: '承認済み（学びの材料にします）',
  simulated: '模擬報告（デモ用の想定）のため、学びの材料にしません',
  not_approved: '未承認または却下のため、学びの材料にしません',
} as const

const fieldClass = 'gt-field px-3 py-3'
const buttonClass = 'gt-button-secondary'
// 長い文字列でも、モバイル画面で横にはみ出さない。
const wrapClass = 'break-words [overflow-wrap:anywhere]'

type Phase =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'failed'; failure: CandidatesFailure }
  | { kind: 'ready' }

// 旅行後の振り返り：感想と変更履歴から学びの候補（1〜3件）を作り、本人が編集・承認・却下する。
// 候補は提案であり、承認するまで次回の旅程には使われない。学びはAIの再学習ではなく、本人の設定である。
//
// 状態の扱い：
// - 承認済みの内容を編集し始めたら、その時点で再承認待ちにする（承認済み一覧と通知から、すぐに外れる）。
// - 候補を再生成しても、既存の候補・承認結果・編集中の内容は消さない（新しい候補を追加する）。
// - 旅程・履歴が更新されたら、進行中の取得を中止し、古い応答を採用しない。別の旅程に切り替わったら、
//   前の旅程の候補・承認状態を消し、混在させない。
export function LearningReview({
  trip,
  scope,
  bindCandidatesToCurrentSession = false,
  revisions = NO_REVISIONS,
  requestCandidates = requestLearningCandidates,
  now = () => new Date(),
  onApprovedChange,
  store,
  canSave = true,
  saveDisabledLabel = '認証を確認中…',
}: LearningReviewProps) {
  const [feedback, setFeedback] = useState('')
  const [feedbackError, setFeedbackError] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [review, dispatch] = useReducer(reviewReducer, initialReviewState)
  const [focusApproveId, setFocusApproveId] = useState<string | null>(null)
  // 学びの候補は、旅程と地域の組に結びつく（承認結果に残る適用範囲が、画面の地域と食い違わないように）。
  const [lastScope, setLastScope] = useState({ id: trip.id, region: trip.region })
  const [resetNotice, setResetNotice] = useState('')
  // 常設のライブリージョンへの通知。同じ文言が続いても読み上げ直されるよう、更新のたびに通し番号を進める。
  const [announcement, setAnnouncement] = useState({ text: '', count: 0 })
  // 同時に複数の通知が出たときは、1つにまとめる（後の通知で、先の通知を上書きして、読み上げを失わない）。
  const pendingAnnouncementsRef = useRef<string[]>([])
  const announce = useCallback((text: string) => {
    const pending = pendingAnnouncementsRef.current
    pending.push(text)
    if (pending.length > 1) return
    queueMicrotask(() => {
      const joined = pendingAnnouncementsRef.current.join(' ')
      pendingAnnouncementsRef.current = []
      setAnnouncement((current) => ({ text: joined, count: current.count + 1 }))
    })
  }, [])

  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const resultHeadingRef = useRef<HTMLHeadingElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  // 送信の即時ロック（状態の更新は非同期のため、二重送信はrefで確実に止める）。
  const inFlightRef = useRef(false)
  // 最新の応答だけを採用するための通し番号。
  const seqRef = useRef(0)

  // 旅程・履歴の内容。変わったら、進行中の取得の結果は、古いものとして扱う。
  const contextKey = useMemo(() => JSON.stringify([trip, revisions]), [trip, revisions])
  const contextKeyRef = useRef(contextKey)
  const reviewRef = useRef(review)
  // 更新のコミットと同時に（描画の反映の直後、ブラウザの描画前に）同期する。
  // 通常の副作用では、コミットから実行までの間に旧リクエストの応答が届くことがある（startTransition など）。
  useLayoutEffect(() => {
    contextKeyRef.current = contextKey
    reviewRef.current = review
  })

  // 別の旅程、または同じ旅程の別の地域になったら、前の候補・承認状態・入力を消す（描画中の状態調整）。
  if (trip.id !== lastScope.id || trip.region !== lastScope.region) {
    setLastScope({ id: trip.id, region: trip.region })
    dispatch({ type: 'reset' })
    setFeedback('')
    setFeedbackError('')
    setPhase({ kind: 'idle' })
    setFocusApproveId(null)
    setAnnouncement({ text: '', count: 0 })
    setResetNotice(
      trip.id === lastScope.id
        ? '旅程の地域が変わったため、確認中の候補と承認結果をリセットしました。'
        : '',
    )
  }

  // 旅程・履歴が更新されたら、進行中の取得を中止する（古い応答を採用しない）。コミットと同時に行う。
  useLayoutEffect(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    seqRef.current += 1
    inFlightRef.current = false
    setPhase((current) => (current.kind === 'generating' ? { kind: 'idle' } : current))
  }, [contextKey])
  useEffect(() => () => controllerRef.current?.abort(), [])

  useEffect(() => {
    if (phase.kind === 'ready') resultHeadingRef.current?.focus()
  }, [phase.kind])

  // 却下を取り消したあと、消えたボタンの代わりに、その候補の「承認する」へフォーカスを移す。
  useEffect(() => {
    if (focusApproveId === null) return
    document.getElementById(`learning-approve-${focusApproveId}`)?.focus()
    setFocusApproveId(null)
  }, [focusApproveId])

  const approved = approvedOf(review).filter((item) => item.sourceTripId === trip.id)
  // 承認済みの内容が変わったときだけ、呼び出し側へ通知する。
  const approvedKey = JSON.stringify(approved)
  const notifyRef = useRef(onApprovedChange)
  const approvedRef = useRef(approved)
  useEffect(() => {
    notifyRef.current = onApprovedChange
    approvedRef.current = approved
  })
  useEffect(() => {
    notifyRef.current?.(approvedRef.current)
  }, [approvedKey])

  const save = useApprovedSave({
    store,
    approved,
    approvedKey,
    scopeKey: JSON.stringify([trip.id, trip.region]),
    canSave,
    announce,
  })

  // 承認操作の記録。入力不備の案内が同じ文言のまま続いても、再度、読み上げるために使う。
  const lastApproveRef = useRef({ id: '', count: 0 })
  const handledApproveRef = useRef(0)
  const announcedMessagesRef = useRef(review.messages)
  const reviewDispatch = useCallback((action: ReviewAction) => {
    if (action.type === 'approve') {
      lastApproveRef.current = { id: action.id, count: lastApproveRef.current.count + 1 }
    }
    dispatch(action)
  }, [])
  // 候補ごとの案内（入力不備・再承認の案内など）は、カードの近くに表示しつつ、
  // 読み上げは常設のライブリージョンに任せる（挿入と同時の読み上げは、支援技術に伝わりにくい）。
  useEffect(() => {
    const previous = announcedMessagesRef.current
    announcedMessagesRef.current = review.messages
    const approve = lastApproveRef.current
    const retried = approve.count !== handledApproveRef.current
    handledApproveRef.current = approve.count
    review.items.forEach((item, index) => {
      const id = item.learning.id
      const message = review.messages.get(id)
      if (message && (message !== previous.get(id) || (retried && id === approve.id))) {
        announce(`学びの候補${index + 1}：${message}`)
      }
    })
  }, [review.items, review.messages, announce])

  const generating = phase.kind === 'generating'

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlightRef.current) return
    const text = feedback.trim()
    if (text.length > MAX_FEEDBACK_LENGTH) {
      setFeedbackError(`感想は${MAX_FEEDBACK_LENGTH}文字以内にしてください。`)
      feedbackRef.current?.focus()
      return
    }
    // サーバーと同じ判定（承認済みで、模擬報告ではない変更）。材料が無ければ、APIを呼ばず、入力へ誘導する。
    if (!hasMaterial({ revisions, feedback: text })) {
      // ボタンは常に押せるようにし、押されたら不備の欄を示して移動する。
      setFeedbackError(
        '感想を入力してください（学びの材料にできる、承認済みで実際の報告に基づく変更が無いため、材料が必要です）。',
      )
      feedbackRef.current?.focus()
      return
    }
    setFeedbackError('')
    setResetNotice('')

    inFlightRef.current = true
    const seq = (seqRef.current += 1)
    const controller = new AbortController()
    controllerRef.current = controller
    const startedContext = contextKey
    const startedTrip = trip
    setPhase({ kind: 'generating' })

    let result: CandidatesResult
    let requestScope = scope
    const bindOnSubmit = bindCandidatesToCurrentSession && !scope
    // UIDが元に戻る切り替えも世代に反映するため、候補生成の間だけ認証通知を購読する。
    const stopObserving = bindOnSubmit ? observeAuthState(() => {}) : undefined
    try {
      if (bindOnSubmit) {
        requestScope = await captureSessionScope()
        controller.signal.throwIfAborted()
      }
      result = await requestCandidates(
        { trip: startedTrip, revisions, feedback: text },
        { signal: controller.signal, ...(requestScope ? { scope: requestScope } : {}) },
      )
    } catch (error) {
      if (bindOnSubmit && !requestScope) {
        const kind = classifyProtectedHeaderError(error)
        result = { ok: false, failure: { kind, message: PROTECTED_FAILURE_MESSAGES[kind] } }
      } else {
        result = {
          ok: false,
          failure: { kind: 'unexpected', message: '予期しないエラーが発生しました。' },
        }
      }
    } finally {
      stopObserving?.()
    }

    // 古い応答（中止された・新しい送信がある・旅程や履歴が更新された）は、採用しない。
    if (
      seq !== seqRef.current ||
      controller.signal.aborted ||
      contextKeyRef.current !== startedContext
    ) {
      return
    }
    // 認証セッションが変わっていたら、結果は画面に反映しない（古いセッションの結果を、新しい画面へ入れない）。
    if (requestScope) {
      try {
        assertCurrentSessionScopeSync(requestScope, 'unknown')
      } catch {
        inFlightRef.current = false
        controllerRef.current = null
        setPhase({ kind: 'idle' })
        return
      }
    }
    inFlightRef.current = false
    controllerRef.current = null

    if (!result.ok) {
      // 失敗しても、感想の入力と、確認中の候補・承認結果は残す。
      setPhase({ kind: 'failed', failure: result.failure })
      return
    }
    // 取り込む前に検証する（差し替えた取得関数の応答にも、同じ条件を適用する）。
    const intake = validateIncomingCandidates(result.learnings, {
      tripId: startedTrip.id,
      region: startedTrip.region,
      existingIds: new Set(reviewRef.current.items.map((item) => item.learning.id)),
    })
    if (!intake.ok) {
      setPhase({ kind: 'failed', failure: { kind: 'unexpected', message: intake.reason } })
      return
    }
    dispatch({ type: 'append', learnings: intake.learnings })
    setPhase({ kind: 'ready' })
  }

  return (
    <section aria-labelledby="reflection-heading" className="space-y-6">
      <div>
        <h2 id="reflection-heading" className="text-lg font-semibold">
          旅の振り返り
        </h2>
        <p className="mt-1 text-sm">
          感想と変更の履歴から、次の旅に活かせる「学び」の候補を作ります。
          {store ? (
            <>
              <b>承認しただけでは、保存されません。</b>
              承認した学びは、下の「承認した学びを保存する」を押すと保存されます。
              AIが学習し直すわけではありません。
            </>
          ) : (
            <>
              <b>
                いまの画面で承認しても、承認した内容は保存されず、次回の旅程づくりにも反映されません
              </b>
              （保存と次回への反映は、今後の機能です）。AIが学習し直すわけではありません。
            </>
          )}
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="gt-card space-y-3">
        <div>
          <label htmlFor="reflection-feedback" className="block text-sm font-medium">
            感想・変更した理由
          </label>
          <textarea
            id="reflection-feedback"
            ref={feedbackRef}
            rows={4}
            value={feedback}
            onChange={(event) => {
              setFeedback(event.target.value)
              setFeedbackError('')
            }}
            aria-invalid={feedbackError ? true : undefined}
            aria-describedby={feedbackError ? 'reflection-feedback-error' : undefined}
            className={`${fieldClass} mt-1`}
            readOnly={generating}
          />
          <p className="mt-1 text-xs">
            {feedback.length} / {MAX_FEEDBACK_LENGTH}文字
          </p>
          {feedbackError && (
            <p id="reflection-feedback-error" role="alert" className="mt-1 text-sm font-medium">
              {feedbackError}
            </p>
          )}
        </div>
        <button type="submit" className="gt-button-primary" aria-disabled={generating || undefined}>
          {generating ? '学びの候補を作っています…' : '学びの候補を作る'}
        </button>
      </form>

      <section aria-labelledby="revision-history-heading" className="space-y-2">
        <h3 id="revision-history-heading" className="text-base font-semibold">
          変更の履歴
        </h3>
        {revisions.length === 0 ? (
          <p className="text-sm">この旅程の変更履歴はありません。</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {revisions.map((revision) => (
              <li key={revision.id} className={`gt-card ${wrapClass}`}>
                <p>
                  <b>{revision.diff.before.name}</b> → <b>{revision.diff.after.name}</b>
                </p>
                <p>理由：{revision.reason}</p>
                <p>報告の種類：{revisionKindLabel(revision)}</p>
                <p>承認の状態：{APPROVAL_LABEL[revision.approval.status]}</p>
                <p>{REVISION_MATERIAL_LABEL[revisionMaterialStatus(revision)]}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 常設のライブリージョン（画面に1つ）。中身のテキストを更新して、読み上げる。 */}
      <div role="status" aria-live="polite">
        {generating && <p className="text-sm">AIが候補を考えています。しばらくお待ちください。</p>}
        {resetNotice && <p className="text-sm font-medium">{resetNotice}</p>}
        <p className="sr-only">
          {announcement.text}
          {announcement.count % 2 === 1 ? ' ' : ''}
        </p>
      </div>
      {phase.kind === 'failed' && (
        <p role="alert" className="gt-notice" data-tone="error">
          {phase.failure.message}
          {review.items.length > 0 && '（すでに確認中の候補は、そのまま残っています。）'}
        </p>
      )}

      {review.items.length > 0 && (
        <section aria-labelledby="candidates-heading" className="space-y-3">
          <h3
            id="candidates-heading"
            ref={resultHeadingRef}
            tabIndex={-1}
            className="text-base font-semibold focus:outline-2 focus:outline-offset-4"
          >
            学びの候補（{review.items.length}件）
          </h3>
          <p className="text-sm">
            内容と適用範囲を直してから、承認または却下してください。AIの提案は、承認するまで使われません。
            承認した内容を変えると、承認が取り消され、もう一度、承認が必要です。
            もう一度、候補を作っても、いまの候補と承認結果は消えません（新しい候補が追加されます）。
          </p>
          <ul className="space-y-3">
            {review.items.map((item) => (
              <CandidateCard
                key={item.learning.id}
                item={item}
                region={trip.region}
                message={review.messages.get(item.learning.id)}
                decidedAt={() => now().toISOString()}
                dispatch={reviewDispatch}
                onReopened={setFocusApproveId}
              />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="approved-heading" className="space-y-2">
        <h3 id="approved-heading" className="text-base font-semibold">
          承認済みの学び（{approved.length}件）
        </h3>
        {approved.length === 0 ? (
          <p className="text-sm">承認した学びはまだありません。</p>
        ) : (
          <ul className={`list-disc space-y-1 pl-5 text-sm ${wrapClass}`}>
            {approved.map((item) => (
              <li key={item.id}>
                {item.content}（
                {item.scope.kind === 'all_trips' ? 'すべての旅行' : `${item.scope.region}の旅行`}）
                {/* 保存先が、保存できた学び・結果不明の学びのIDを返したときだけ、項目ごとの結果を文字で示す。 */}
                {save.status.kind === 'failed' &&
                  (save.status.savedIds || save.status.unknownIds) && (
                    <b className="ml-1 whitespace-nowrap">{itemSaveLabel(save.status, item.id)}</b>
                  )}
              </li>
            ))}
          </ul>
        )}
        {store ? (
          <>
            <SavePanel
              status={save.status}
              notice={save.notice}
              onSave={save.save}
              approved={approved}
              unresolvedUnknowns={save.unresolvedUnknowns}
              canSave={canSave}
              disabledLabel={saveDisabledLabel}
            />
            {/* 画面上の編集・却下は、保存済みの承認を取り消さない。撤回の操作は、まだ無い。 */}
            <p id="learning-saved-approval-note" className="text-xs">
              {SAVED_APPROVAL_NOTE}
            </p>
          </>
        ) : (
          <p className="text-xs">
            承認した内容は、いまはこの画面の中だけにあり、まだ保存されません（保存は、ログインの機能が入ってから使えるようになります）。
          </p>
        )}
      </section>
    </section>
  )
}

interface CandidateCardProps {
  item: ReviewItem
  region: string
  message: string | undefined
  decidedAt: () => string
  dispatch: (action: ReviewAction) => void
  onReopened: (id: string) => void
}

function CandidateCard({
  item,
  region,
  message,
  decidedAt,
  dispatch,
  onReopened,
}: CandidateCardProps) {
  const { learning, draft } = item
  const status = learning.approval.status
  const contentId = `learning-content-${learning.id}`
  const scopeId = `learning-scope-${learning.id}`

  return (
    <li className={`gt-card space-y-3 ${wrapClass}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded border border-current/50 px-2 py-0.5">
          {CATEGORY_LABEL[learning.category]}
        </span>
        <span className="rounded border-2 border-current px-2 py-0.5 font-medium">
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div>
        <label htmlFor={contentId} className="block text-sm font-medium">
          学びの内容
        </label>
        <textarea
          id={contentId}
          rows={2}
          value={draft.content}
          onChange={(event) =>
            dispatch({ type: 'draft', id: learning.id, content: event.target.value, region })
          }
          className={`${fieldClass} mt-1`}
          aria-describedby={message ? `${contentId}-message` : undefined}
        />
        <p className="mt-1 text-xs">
          {draft.content.trim().length} / {MAX_LEARNING_CONTENT_LENGTH}文字
        </p>
      </div>
      <div>
        <label htmlFor={scopeId} className="block text-sm font-medium">
          適用範囲
        </label>
        <select
          id={scopeId}
          value={draft.scopeKind}
          onChange={(event) =>
            dispatch({
              type: 'draft',
              id: learning.id,
              scopeKind: event.target.value === 'region' ? 'region' : 'all_trips',
              region,
            })
          }
          className={`${fieldClass} mt-1`}
        >
          <option value="region">{region}の旅行だけ</option>
          <option value="all_trips">すべての旅行</option>
        </select>
      </div>
      {message && (
        <p id={`${contentId}-message`} className="text-sm font-medium">
          {message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          id={`learning-approve-${learning.id}`}
          className={buttonClass}
          onClick={() =>
            dispatch({ type: 'approve', id: learning.id, decidedAt: decidedAt(), region })
          }
        >
          {status === 'approved' ? '承認済み（再承認）' : '承認する'}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => dispatch({ type: 'reject', id: learning.id, decidedAt: decidedAt() })}
        >
          却下する
        </button>
        {status === 'rejected' && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              dispatch({ type: 'reopen', id: learning.id })
              onReopened(learning.id)
            }}
          >
            却下を取り消す
          </button>
        )}
      </div>
    </li>
  )
}

// 保存済みの承認は、この画面の編集・却下では変わらない。実際の状態（サーバー上は承認が有効）を伝える。
const SAVED_APPROVAL_NOTE =
  '画面上の編集・却下は、保存済みの承認を取り消しません。保存済みの学びを撤回する操作は、まだ提供していません。'

type FailedStatus = Extract<SaveStatus, { kind: 'failed' }>

// 項目ごとの保存結果。保存済みと結果不明に無い項目は、未保存（送信していない、または拒否された）。
function itemSaveLabel(status: FailedStatus, id: string): string {
  if (status.savedIds?.includes(id)) return '— 保存済み'
  if (status.unknownIds?.includes(id)) return '— 結果不明'
  return '— 未保存'
}

function saveStatusText(status: SaveStatus): string {
  switch (status.kind) {
    case 'saving':
      return '保存中です…'
    case 'saved':
      return `保存済み（承認済みの学び${status.count}件）`
    case 'unsaved':
      return status.count === 0
        ? '未保存の変更あり（承認済みの学びが0件になりました。以前に保存した内容は、まだ変わっていません）'
        : `未保存の変更あり（承認済みの学び${status.count}件に、まだ保存していない変更があります）`
    case 'empty':
      return '保存できる承認済みの学びはまだありません'
    case 'failed': {
      // 保存先が保存できた学び・結果不明の学びを返したときは、保存済み・結果不明・未保存を分けて示す。
      const saved = status.savedIds?.length ?? 0
      const unknown = status.unknownIds?.length ?? 0
      const unsaved = status.count - saved - unknown
      if (unknown > 0) {
        const parts = [
          saved > 0 ? `${saved}件は保存済み` : '',
          `${unknown}件は結果不明`,
          unsaved > 0 ? `${unsaved}件は未保存` : '',
        ].filter(Boolean)
        return `保存に失敗しました（承認済みの学び${status.count}件のうち、${parts.join('、')}です）`
      }
      if (saved > 0) {
        return `保存に失敗しました（承認済みの学び${status.count}件のうち、${saved}件は保存済み、${unsaved}件は未保存です）`
      }
      return `保存に失敗しました（承認済みの学び${status.count}件は未保存です）`
    }
  }
}

// 結果不明の学びがあるときの案内。自動では再送せず、確認してから利用者の操作で保存する。
const UNKNOWN_GUIDE =
  '結果不明の学びは、保存されている場合があります。自動では再送しません。' +
  '保存済みの学びの一覧を読み込み直して確認してから、もう一度、保存してください' +
  '（保存済みと確認できた学びは、再送しません）。'

interface SavePanelProps {
  status: SaveStatus
  notice: string
  onSave: () => void
  approved: ApprovedLearning[]
  unresolvedUnknowns: ApprovedLearning[]
  canSave: boolean
  disabledLabel: string
}

function sameApprovedContent(a: ApprovedLearning, b: ApprovedLearning): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// 承認済みの学びの保存。承認とは別の操作・別の状態として示す。
function SavePanel({
  status,
  notice,
  onSave,
  approved,
  unresolvedUnknowns,
  canSave,
  disabledLabel,
}: SavePanelProps) {
  const saving = status.kind === 'saving'
  const currentUnknowns =
    status.kind === 'failed'
      ? approved.filter((learning) => status.unknownIds?.includes(learning.id))
      : []
  const previousUnknowns = unresolvedUnknowns.filter(
    (unknown) => !currentUnknowns.some((current) => sameApprovedContent(current, unknown)),
  )
  return (
    <div className="gt-card space-y-2">
      <p className="text-sm">
        <span className="rounded border-2 border-current px-2 py-0.5 font-medium">保存の状態</span>{' '}
        {saveStatusText(status)}
      </p>
      {status.kind === 'failed' && (
        <p role="alert" className="gt-notice" data-tone="error">
          保存できませんでした。{status.message}
          承認済みの学びと入力中の内容は、そのまま残っています。
          {status.unknownIds && status.unknownIds.length > 0
            ? UNKNOWN_GUIDE
            : status.retryable && 'もう一度、保存できます。'}
        </p>
      )}
      {previousUnknowns.length > 0 && (
        <div role="alert" className="gt-notice" data-tone="error">
          前回の保存結果が未確認の学びが{previousUnknowns.length}
          件あります。保存済み一覧を読み込み直して、状態を確認してください。
          {UNKNOWN_GUIDE}
          <ul className="mt-2 list-disc pl-5">
            {previousUnknowns.map((learning, index) => (
              <li key={`${learning.id}-${index}`}>{learning.content}</li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        id="learning-save"
        className="gt-button-primary"
        aria-disabled={saving || !canSave || undefined}
        aria-describedby={notice ? 'learning-save-notice' : undefined}
        onClick={onSave}
      >
        {!canSave
          ? disabledLabel
          : saving
            ? '保存しています…'
            : status.kind === 'failed'
              ? status.unknownIds && status.unknownIds.length > 0
                ? '保存済みか確認して、もう一度、保存する'
                : 'もう一度、保存する'
              : '承認した学びを保存する'}
      </button>
      {notice && (
        <p id="learning-save-notice" className="text-sm font-medium">
          {notice}
        </p>
      )}
    </div>
  )
}
