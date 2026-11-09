'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { revisionTargetRestriction, TripSchema, type Trip } from '@/domain'
import { OnSiteReportForm } from '@/features/onsite-report/onsite-report-form'
import type { OnSiteReportSubmission } from '@/features/onsite-report/report-model'
import type { ApplyRevision, GenerateRevisions } from '@/features/revision-review/api-client'
import { RevisionReview } from '@/features/revision-review/revision-review'
import {
  clearApplyUnresolved,
  judgeLatestTrip,
  markApplyUnresolved,
  readUnresolvedApply,
  subscribeApplyLock,
} from '@/features/revision-review/unresolved-apply'
import {
  TripProgressView,
  type FinishTripAction,
} from '@/features/trip-progress/trip-progress-view'

import { guardOnSiteProposal } from './onsite-approval-guard'
import type { scopedReportControl } from './onsite-persistence'
import { ReportResolution } from './report-resolution'

interface OnSiteReplanningFlowProps {
  trip: Trip
  generate?: GenerateRevisions
  generationUnavailableReason?: string
  apply?: ApplyRevision
  onTripChange?: (trip: Trip) => void
  lockManagedByApply?: boolean
  reportControl?: ReturnType<typeof scopedReportControl>
  ownerUid?: string
  loadLatestTrip?: (tripId: string, signal: AbortSignal) => Promise<unknown>
  loadAppliedRevision?: (
    tripId: string,
    revisionId: string,
    signal: AbortSignal,
  ) => Promise<unknown>
  initialIndex?: number
  active?: boolean
  finishAction?: FinishTripAction
}

type Step = 'progress' | 'report' | 'review'
// 報告の入力。epoch は入力を作った時点の世代。targetId が null のときは、対象の予定を選び直してもらう。
type Draft = { epoch: number; targetId: string | null }
// 比較に進んだ報告。epoch は報告を送った時点の世代で、現在の世代と違えば無効。
type Session = { epoch: number; submission: OnSiteReportSubmission }
// 画面を切り替えたあとにフォーカスを移す先。
type FocusTarget = 'progress' | 'report' | 'unresolved'

const unresolvedMessage =
  '適用結果を確認できませんでした。この画面からは再操作できません。旅程の最新状態を確認できるまで、再計画を停止しています。'
const stoppedMessage =
  '再計画を停止しています。適用結果を確認できていないため、この画面からは報告を始められません。ページを再読み込みして、最新の旅程を取得し直してください。'
// 子の画面の見出し。画面ごとの切り替えでフォーカスを失わないよう、ここから探して移す。
const progressHeadingSelector = '#trip-progress-current'
const reportHeadingSelector = 'h2'

// 旅程の中身を比べるための文字列。共通スキーマで並びを揃えるので、キー順が違うだけの同じ旅程は同じ文字列になる。
// 検証に通らない旅程でも、同じ入力なら同じ文字列になる（描画のたびに変化したと見なさない）。
const fingerprintOf = (trip: Trip) => {
  const parsed = TripSchema.safeParse(trip)
  return JSON.stringify(parsed.success ? parsed.data : trip)
}

// 再計画だけの画面導線。進行状態は保存しない。候補生成・検証・適用は既存の部分修正処理を使う。
//
// 旅程が変わったあとの「古い報告・比較・適用処理」は、世代（epoch）で無効にする。
// 世代は親の旅程の中身が変わるたびに増えるだけで、減らない。そのため、旅程が元の内容に戻っても
// （v0→v1→v0）、一度無効になった報告・候補・適用結果は復活しない。内容の一致では判定しない。
export function OnSiteReplanningFlow({
  trip: sourceTrip,
  generate,
  generationUnavailableReason,
  apply,
  onTripChange,
  initialIndex,
  active = true,
  finishAction,
  ownerUid,
  reportControl,
  lockManagedByApply,
  loadLatestTrip,
  loadAppliedRevision,
}: OnSiteReplanningFlowProps) {
  const [watch, setWatch] = useState(() => ({
    fingerprint: fingerprintOf(sourceTrip),
    epoch: 0,
  }))
  // 適用に成功した旅程。親が反映するまでの表示用で、その世代の間だけ使う。
  const [local, setLocal] = useState<{ epoch: number; value: Trip } | null>(null)
  const [step, setStep] = useState<Step>('progress')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  // 適用の結果をサーバーから確認できていない状態。利用者の操作では解除しない（下の注記を参照）。
  const [applyUnresolved, setApplyUnresolved] = useState(() =>
    ownerUid ? readUnresolvedApply(ownerUid, sourceTrip.id).status !== 'clear' : false,
  )
  useEffect(() => {
    if (!ownerUid) return
    const refreshLock = () =>
      setApplyUnresolved(readUnresolvedApply(ownerUid, sourceTrip.id).status !== 'clear')
    if (active) refreshLock()
    return subscribeApplyLock(ownerUid, sourceTrip.id, refreshLock)
  }, [active, ownerUid, sourceTrip.id])
  const [checking, setChecking] = useState(false)
  const recoveryAbort = useRef<AbortController | null>(null)
  useEffect(() => () => recoveryAbort.current?.abort(), [])
  // 同じ文言が続いても読み上げ直されるよう、更新のたびに数える。
  const [notice, setNotice] = useState({ text: '', tick: 0 })
  const [focusRequest, setFocusRequest] = useState<{ to: FocusTarget } | null>(null)
  const progressArea = useRef<HTMLDivElement>(null)
  const reportArea = useRef<HTMLDivElement>(null)
  const unresolvedNote = useRef<HTMLDivElement>(null)
  const staleAlert = useRef<HTMLDivElement>(null)

  const announce = (text: string) => setNotice((previous) => ({ text, tick: previous.tick + 1 }))
  const moveFocus = (to: FocusTarget) => setFocusRequest({ to })

  // 親の旅程の中身が変わったら世代を進める（描画中の状態調整）。
  // 版が同じでも、対象の予定が固定・削除・差し替えされた場合は中身が変わるので、同じように扱う。
  const sourceFingerprint = fingerprintOf(sourceTrip)
  if (watch.fingerprint !== sourceFingerprint) {
    const nextEpoch = watch.epoch + 1
    setWatch({ fingerprint: sourceFingerprint, epoch: nextEpoch })
    if (draft) {
      // 入力中の報告は別の世代の旅程に向けたものになる。別の予定へ引き継がず、対象の選び直しを求める。
      setDraft({ epoch: nextEpoch, targetId: null })
      if (step === 'report') {
        announce(
          '旅程が更新されたため入力をリセットしました。対象の予定を選び直し、報告内容を確認してください。',
        )
        moveFocus('report')
      }
    }
  }
  const epoch = watch.epoch
  const epochRef = useRef(epoch)
  epochRef.current = watch.fingerprint === sourceFingerprint ? epoch : epoch + 1
  const trip = local && local.epoch === epoch ? local.value : sourceTrip

  const target = session && trip.stops.find((stop) => stop.id === session.submission.targetStopId)
  const activeReview =
    step === 'review' &&
    session !== null &&
    session.epoch === epoch &&
    target != null &&
    revisionTargetRestriction(target) === null
  const stale = step === 'review' && !activeReview

  // 切り替えた先の見出しなどへフォーカスを移す。隠していた画面は、このコミットで表示される。
  useEffect(() => {
    if (!active || !focusRequest) return
    const element =
      focusRequest.to === 'unresolved'
        ? unresolvedNote.current
        : focusRequest.to === 'report'
          ? reportArea.current?.querySelector<HTMLElement>(reportHeadingSelector)
          : progressArea.current?.querySelector<HTMLElement>(progressHeadingSelector)
    if (!element) return
    // 見出しは通常フォーカスできない。プログラムからだけフォーカスできるようにする。
    if (!element.hasAttribute('tabindex')) element.tabIndex = -1
    element.focus()
    setFocusRequest(null)
  }, [active, focusRequest])

  // 親の更新で比較画面が消えると、フォーカスが失われる。中止の通知へ移す。
  useLayoutEffect(() => {
    if (active && stale && document.activeElement === document.body) staleAlert.current?.focus()
  }, [active, stale])

  // 現地報告の候補は、承認の可否を下げる方向にだけ働く暫定ガードを通してから比較画面へ渡す。
  const guardedGenerate: GenerateRevisions = async (request, signal) => {
    if (!generate) return { status: 'unavailable' }
    const result = await generate(request, signal)
    return result.status === 'proposed' ? guardOnSiteProposal(result, request) : result
  }

  const canReport = (stopId: string) =>
    trip.stops.some((stop) => stop.id === stopId && revisionTargetRestriction(stop) === null)

  const startReport = (stopId: string) => {
    if (!generate || !canReport(stopId)) return
    if (
      applyUnresolved ||
      (ownerUid && readUnresolvedApply(ownerUid, trip.id).status !== 'clear')
    ) {
      setApplyUnresolved(true)
      // 前回の適用結果が分からないまま、古い旅程から報告を始めさせない。
      announce(stoppedMessage)
      moveFocus('unresolved')
      return
    }
    setDraft((current) =>
      current?.epoch === epoch && current.targetId === stopId
        ? current
        : { epoch, targetId: stopId },
    )
    setSession(null)
    announce('')
    setStep('report')
    moveFocus('report')
  }

  const submitReport = (submission: OnSiteReportSubmission) => {
    if (!generate || !canReport(submission.targetStopId)) {
      announce('修正できる予定を確認してください。元の旅程は変更していません。')
      return
    }
    setSession({ epoch, submission })
    announce('')
    setStep('review')
  }

  // 適用結果が不明なまま進行画面へ戻る。再操作の停止は保ち、解除しない。
  const leaveUnresolved = () => {
    announce(unresolvedMessage)
    setSession(null)
    setDraft(null)
    setStep('progress')
    moveFocus('unresolved')
  }

  const cancelReview = () => {
    if (applyUnresolved) {
      leaveUnresolved()
      return
    }
    setSession(null)
    announce('報告内容を見直せます。旅程は変更されていません。')
    setStep('report')
    moveFocus('report')
  }

  const applied = (next: Trip, _receipt?: unknown, revisionId?: string) => {
    if (ownerUid && revisionId) clearApplyUnresolved(ownerUid, sourceTrip.id, revisionId)
    // 適用を確認できた応答は、その世代の画面に届く。親が反映するまでの間、適用後の旅程を表示する。
    setLocal({ epoch, value: next })
    setSession(null)
    setDraft(null)
    setApplyUnresolved(false)
    setStep('progress')
    announce('承認した1件の変更を旅程に反映しました。')
    moveFocus('progress')
    onTripChange?.(next)
  }

  const recover = async () => {
    if (!ownerUid || !loadLatestTrip || !loadAppliedRevision || checking) return
    const lock = readUnresolvedApply(ownerUid, sourceTrip.id)
    if (lock.status !== 'pending') return
    const controller = new AbortController()
    const recoveryEpoch = epochRef.current
    recoveryAbort.current = controller
    setChecking(true)
    try {
      const latest = await loadLatestTrip(sourceTrip.id, controller.signal)
      const revision = await loadAppliedRevision(
        sourceTrip.id,
        lock.value.revisionId,
        controller.signal,
      )
      if (controller.signal.aborted || epochRef.current !== recoveryEpoch) return
      const current = readUnresolvedApply(ownerUid, sourceTrip.id)
      if (
        current.status !== 'pending' ||
        current.value.revisionId !== lock.value.revisionId ||
        current.value.baseVersion !== lock.value.baseVersion
      )
        return
      const verdict = judgeLatestTrip(
        sourceTrip.id,
        lock.value.baseVersion,
        lock.value.revisionId,
        latest,
        revision,
      )
      if (verdict.kind !== 'applied') {
        announce('対象の適用を確認できませんでした。再操作は停止したままです。')
        return
      }
      clearApplyUnresolved(ownerUid, sourceTrip.id, lock.value.revisionId)
      applied(verdict.trip)
    } catch {
      if (!controller.signal.aborted)
        announce('対象の適用を確認できませんでした。再操作は停止したままです。')
    } finally {
      if (!controller.signal.aborted) setChecking(false)
    }
  }
  return (
    <section aria-label="旅行中の再計画" className="mx-auto w-full max-w-xl">
      <p
        role="status"
        aria-live="polite"
        className="text-sm not-empty:mb-3 not-empty:rounded-lg not-empty:border not-empty:border-gt-rule not-empty:p-3"
      >
        {notice.text && <span key={notice.tick}>{notice.text}</span>}
      </p>

      {/* 画面を隠してもマウントを維持することで、手動で進めた現在位置を保持する。 */}
      <div hidden={step !== 'progress'} ref={progressArea}>
        {applyUnresolved && (
          // 結果不明は、利用者のボタン操作では解除しない。サーバーから取得した最新の旅程か、
          // 確定した結果と照合できるまで（確認手段が接続されるまで）、再計画を止めたままにする。
          <div
            ref={unresolvedNote}
            role="note"
            tabIndex={-1}
            className="mx-4 mt-3 space-y-2 rounded-lg border-2 border-gt-rule p-3 text-sm"
          >
            <p className="font-bold">
              適用結果を確認できませんでした。この画面からは再操作できません。
            </p>
            <p>
              旅程の最新状態を確認できるまで、再計画を停止しています。ページを再読み込みして、最新の旅程を取得し直してください。再読み込みすると、この画面の入力と、手動で進めた現在位置は失われます。
            </p>
            {ownerUid && loadLatestTrip && loadAppliedRevision && (
              <button
                className="min-h-11 font-semibold underline"
                type="button"
                onClick={() => void recover()}
                disabled={checking}
              >
                {checking ? '確認中…' : '最新の旅程を取得して確認する'}
              </button>
            )}
          </div>
        )}
        <TripProgressView
          trip={trip}
          initialIndex={initialIndex}
          onReplan={generate ? startReport : undefined}
          finishAction={finishAction}
        />
        {!generate && (
          <p className="px-4 text-sm text-gt-muted">
            {generationUnavailableReason ??
              '現地報告からの再計画は、候補生成サービスを接続すると利用できます。'}
          </p>
        )}
      </div>

      {/* 報告を修正するために戻っても入力内容を維持する。 */}
      {draft && (
        <div hidden={step !== 'report'} ref={reportArea}>
          <OnSiteReportForm
            key={`${draft.epoch}:${draft.targetId ?? ''}`}
            trip={trip}
            initialTargetStopId={draft.targetId ?? undefined}
            // 対象の予定が変わって入力を作り直したときは、残った1件を自動で選ばない。
            autoSelectSingleTarget={draft.targetId !== null}
            status={{ phase: 'idle' }}
            onSubmit={submitReport}
            onBack={() => {
              setSession(null)
              setStep('progress')
              announce('元の旅程を表示しています。')
              moveFocus('progress')
            }}
          />
        </div>
      )}

      {activeReview && session && target && (
        <div className="space-y-3">
          {session.submission.context.report.kind === 'simulated' && (
            <p role="note" className="rounded-lg border-2 border-dashed border-gt-rule p-3 text-sm">
              デモ用の想定です。現地で実際に起きたことではありません。候補を比較できますが、旅程には適用しません。
            </p>
          )}
          {session.submission.context.report.kind === 'actual' && (
            <p className="rounded-lg border border-gt-rule p-3 text-sm text-gt-muted">
              現地での報告は利用者による申告です。Placesなどの照合結果と区別して扱います。
            </p>
          )}
          {session.submission.context.report.kind === 'actual' &&
            reportControl &&
            !applyUnresolved && (
              <ReportResolution
                key={JSON.stringify([ownerUid, trip.id, trip.version, session.epoch, target.id])}
                tripId={trip.id}
                stopId={target.id}
                tripVersion={trip.version}
                control={reportControl}
                onResolved={() => {
                  setSession(null)
                  setStep('report')
                  announce('保留を解消しました。報告内容を見直して、候補を作り直してください。')
                  moveFocus('report')
                }}
              />
            )}{' '}
          <RevisionReview
            key={`${session.epoch}:${target.id}`}
            active={active}
            trip={trip}
            target={target}
            generate={guardedGenerate}
            generationAvailable={generate !== undefined}
            applyUnresolved={applyUnresolved}
            // 模擬報告では適用の経路そのものを渡さず、承認が旅程へ届かないようにする。
            apply={session.submission.context.report.kind === 'actual' ? apply : undefined}
            applyUnavailableReason={
              session.submission.context.report.kind === 'simulated'
                ? '模擬報告のため適用できません。'
                : undefined
            }
            onSiteReport={{
              reason: session.submission.reason,
              context: session.submission.context,
            }}
            onCancel={cancelReview}
            onApplied={applied}
            onApplyUnresolvedChange={(unresolved, revisionId) => {
              if (ownerUid) {
                if (!revisionId) throw new Error('候補を確認できません。')
                if (unresolved && !lockManagedByApply)
                  markApplyUnresolved(ownerUid, trip.id, trip.version, revisionId)
                else if (!unresolved && !lockManagedByApply)
                  clearApplyUnresolved(ownerUid, trip.id, revisionId)
              }
              setApplyUnresolved(unresolved)
            }}
          />
        </div>
      )}

      {stale && (
        <div
          ref={staleAlert}
          role="alert"
          tabIndex={-1}
          className="rounded-lg border-2 border-gt-rule p-4 text-sm"
        >
          <p>
            {applyUnresolved
              ? unresolvedMessage
              : '旅程または固定予定が更新されたため、古い報告からの再計画を中止しました。'}
          </p>
          <button
            type="button"
            className="mt-3 min-h-11 font-bold underline"
            onClick={() => {
              if (applyUnresolved) {
                leaveUnresolved()
                return
              }
              setSession(null)
              setDraft(null)
              setStep('progress')
              announce('最新の旅程を確認してから報告し直してください。')
              moveFocus('progress')
            }}
          >
            旅行中の画面に戻る
          </button>
        </div>
      )}
    </section>
  )
}
