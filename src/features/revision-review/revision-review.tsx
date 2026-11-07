'use client'

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'

import type { Stop, Trip } from '@/domain'
import { StatusBadge } from '@/features/trip-map/evidence-badge'
import type { RouteMeta } from '@/features/trip-map/model'
import { RouteMap } from '@/features/trip-map/route-map'

import {
  confirmedTrip,
  readRevisionProposal,
  sameTrip,
  type ApplyRevision,
  type GenerateRevisions,
  type RevisionProposal,
  type RevisionRequest,
  type RevisionResult,
} from './api-client'
import { CandidateComparison, ConstraintBadge } from './candidate-comparison'

const generationMessages = {
  no_candidates: '条件に合う候補が見つかりませんでした。希望条件を見直して再試行できます。',
  insufficient_information:
    '候補を作るための情報が不足しています。変更理由や希望条件を補ってください。',
  external_service_error: '候補生成や照合に使う外部サービスでエラーが発生しました。',
  unavailable: '候補生成APIは現在利用できません。',
  interrupted: '通信が中断されました。接続を確認して再試行してください。',
  conflict: '旅程が更新されています。最新の旅程を確認してから部分修正を始め直してください。',
  invalid_request: '修正対象や入力内容を確認してください。',
  unexpected: '候補の応答を確認できませんでした。',
} satisfies Record<Exclude<RevisionResult['status'], 'proposed'>, string>

const applyMessages = {
  conflict: '旅程が更新され、適用できませんでした。最新の旅程を確認してから始め直してください。',
  unavailable: '候補を適用するサービスは現在利用できません。',
  failed: '候補を適用できませんでした。',
  uncertain: '適用結果を確認できませんでした。再操作する前に最新の旅程を確認してください。',
}

const inputClass = 'gt-field px-3 py-2'
const primaryClass =
  'min-h-12 rounded-xl bg-gt-ink px-3 py-2 text-sm font-semibold text-white motion-safe:transition-colors motion-safe:duration-200 hover:bg-gt-muted disabled:bg-gt-rule disabled:text-gt-muted aria-disabled:bg-gt-rule aria-disabled:text-gt-muted aria-disabled:hover:bg-gt-rule disabled:hover:bg-gt-rule'
const secondaryClass =
  'min-h-12 rounded-xl border border-gt-rule bg-gt-paper px-3 py-2 text-sm font-semibold motion-safe:transition-colors motion-safe:duration-200 hover:bg-gt-bg disabled:opacity-50'

function ProgressMark() {
  return (
    <span
      aria-hidden="true"
      className="gt-spinner size-4 shrink-0 rounded-full border-2 border-gt-preview/30 border-t-gt-preview"
    />
  )
}

interface RevisionReviewProps {
  trip: Trip
  target: Stop
  meta?: RouteMeta
  generate: GenerateRevisions
  apply?: ApplyRevision
  onCancel: () => void
  onApplied: (trip: Trip) => void
  onApplyUnresolvedChange: (unresolved: boolean) => void
}

type Review = { request: RevisionRequest; proposal: RevisionProposal; selected: number }

const candidateLabel = (index: number) =>
  `候補 ${index < 26 ? String.fromCharCode(65 + index) : index + 1}`

export function RevisionReview({
  trip,
  target,
  meta,
  generate,
  apply,
  onCancel,
  onApplied,
  onApplyUnresolvedChange,
}: RevisionReviewProps) {
  const [reason, setReason] = useState('')
  const [preferences, setPreferences] = useState('')
  const [canDrive, setCanDrive] = useState(false)
  const [invalidReason, setInvalidReason] = useState(false)
  const [generationFailure, setGenerationFailure] = useState<Exclude<
    RevisionResult,
    RevisionProposal
  > | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [applyFailure, setApplyFailure] = useState<{
    status: keyof typeof applyMessages
    message?: string
  } | null>(null)
  const activeGeneration = useRef<AbortController | null>(null)
  const activeApply = useRef<object | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const reasonField = useRef<HTMLTextAreaElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const hasReview = review !== null

  useEffect(() => {
    heading.current?.focus()
  }, [hasReview])

  useLayoutEffect(() => {
    if (!generationFailure) return
    // disabledが反映されたDOMで判定し、待機中に移したフォーカスを維持する。
    const active = document.activeElement
    if (active && active !== document.body && !active.matches(':disabled')) return

    const submit = submitButton.current
    const destination = submit && !submit.disabled ? submit : cancelButton.current
    destination?.focus()
  }, [generationFailure])

  // 親はTrip差し替え時にこのセッションを閉じる。コミット時点で古い応答を無効にする。
  useLayoutEffect(
    () => () => {
      activeGeneration.current?.abort()
      activeGeneration.current = null
      activeApply.current = null
    },
    [],
  )

  const generateCandidates = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (activeGeneration.current || generationFailure?.status === 'conflict') return
    if (!reason.trim()) {
      setInvalidReason(true)
      reasonField.current?.focus()
      return
    }
    const request: RevisionRequest = {
      trip: structuredClone(trip),
      targetStopId: target.id,
      // PR #28のリクエストでは、理由と希望条件を一つのフィールドで渡す。
      reason: [reason.trim(), preferences.trim() && `希望条件：${preferences.trim()}`]
        .filter(Boolean)
        .join('\n'),
      context: { phase: 'planning' },
      travelModes: canDrive ? ['walk', 'drive'] : ['walk'],
    }
    const controller = new AbortController()
    activeGeneration.current = controller
    setGenerationFailure(null)
    setIsGenerating(true)

    let result: RevisionResult
    try {
      result = await generate(structuredClone(request), controller.signal)
    } catch {
      result = { status: 'interrupted' }
    }
    if (controller.signal.aborted || activeGeneration.current !== controller) return
    activeGeneration.current = null
    setIsGenerating(false)
    if (result.status === 'proposed') {
      const proposal = readRevisionProposal(result, request)
      if (proposal) {
        setReview({ request, proposal, selected: 0 })
      } else {
        setGenerationFailure({ status: 'unexpected' })
      }
    } else {
      setGenerationFailure({ ...result })
    }
  }

  const candidate = review?.proposal.revisions[review.selected]
  const label = review ? candidateLabel(review.selected) : ''
  const comparison = review?.proposal.comparisons?.find(
    ({ revisionId }) => revisionId === candidate?.id,
  )
  const requiresLatestTrip =
    applyFailure?.status === 'conflict' || applyFailure?.status === 'uncertain'
  const constraintSatisfied = candidate?.constraintCheck.status === 'satisfied'
  const canApprove = constraintSatisfied && !requiresLatestTrip
  const approvalNote = !constraintSatisfied
    ? candidate?.constraintCheck.status === 'violated'
      ? '旅程の条件に合わないため、この候補は選べません。'
      : '旅程に組み込めるか確認できていないため、この候補は選べません。'
    : requiresLatestTrip
      ? '再操作する前に最新の旅程を確認してください。'
      : !apply
        ? '承認・適用サービスは未接続です。'
        : null
  const approvalStatus = isApplying
    ? '承認操作済み・適用結果を確認中'
    : applyFailure?.status === 'uncertain'
      ? '適用結果未確認'
      : applyFailure
        ? '適用されていません'
        : '未承認・未適用'

  const approve = async () => {
    if (!review || !candidate || !canApprove || !apply || isApplying || activeApply.current) return
    // 表示時の候補と、本人が承認した時点のTripを検証用に確保する。
    // コールバックには別のコピーだけを渡し、検証用のデータを変更できないようにする。
    const decision = structuredClone({ request: { ...review.request, trip }, revision: candidate })
    if (!sameTrip(decision.request.trip, review.request.trip)) {
      setApplyFailure({ status: 'conflict' })
      return
    }
    const attempt = {}
    activeApply.current = attempt
    setApplyFailure(null)
    setIsApplying(true)
    onApplyUnresolvedChange(true)
    try {
      const result = await apply(structuredClone(decision))
      if (activeApply.current !== attempt) return
      if (result.status === 'applied') {
        const nextTrip = confirmedTrip(decision.request.trip, decision.revision, result.trip)
        if (nextTrip) {
          onApplied(nextTrip)
        } else {
          setApplyFailure({ status: 'uncertain' })
        }
      } else {
        if (result.status !== 'uncertain') onApplyUnresolvedChange(false)
        setApplyFailure({ ...result })
      }
    } catch {
      if (activeApply.current === attempt) setApplyFailure({ status: 'uncertain' })
    } finally {
      if (activeApply.current === attempt) {
        activeApply.current = null
        setIsApplying(false)
      }
    }
  }

  return (
    <section
      aria-labelledby="revision-heading"
      className="mx-auto max-w-[34rem] space-y-4 rounded-2xl bg-gt-bg p-3 text-gt-ink sm:p-5"
    >
      <header className="space-y-2">
        <p
          key={hasReview ? 'compare' : 'conditions'}
          className="gt-enter text-sm font-semibold text-gt-muted"
        >
          {review ? '2 / 2　候補を確認' : '1 / 2　希望を入力'}
        </p>
        <h2
          id="revision-heading"
          tabIndex={-1}
          ref={heading}
          className="text-xl font-bold leading-snug wrap-anywhere"
        >
          {review ? '候補を比較して承認' : 'この予定だけ変更'}
        </h2>
        <p className="text-sm font-bold wrap-anywhere">
          {target.plannedStartTime}　{target.name}
        </p>
        <p className="text-sm text-gt-muted">
          この予定だけが変更の対象です。ほかの予定や固定時刻はそのままです。
        </p>
        {review && (
          <p className="whitespace-pre-wrap text-sm text-gt-muted wrap-anywhere">
            {review.request.reason}
          </p>
        )}
      </header>

      <p role="status" aria-atomic="true" className="sr-only">
        {review
          ? `${label}を表示中。 ${approvalStatus}`
          : isGenerating
            ? '候補を探し、営業時間や移動にかかる時間を確認しています。'
            : ''}
      </p>

      {!review && (
        <form className="gt-enter space-y-4" onSubmit={generateCandidates} noValidate>
          <fieldset
            disabled={isGenerating || generationFailure?.status === 'conflict'}
            className="min-w-0 space-y-3"
          >
            <legend className="sr-only">部分修正の条件</legend>
            <label className="block space-y-1 text-sm font-semibold">
              <span>修正理由（必須）</span>
              <textarea
                ref={reasonField}
                required
                rows={2}
                maxLength={500}
                className={inputClass}
                value={reason}
                aria-invalid={invalidReason}
                aria-describedby={invalidReason ? 'revision-reason-error' : undefined}
                onChange={(event) => {
                  setReason(event.target.value)
                  setInvalidReason(false)
                }}
              />
            </label>
            {invalidReason && (
              <p id="revision-reason-error" role="alert" className="text-sm text-gt-warn">
                修正理由を入力してください。
              </p>
            )}
            <label className="block space-y-1 text-sm font-semibold">
              <span>希望条件（任意）</span>
              <textarea
                rows={2}
                maxLength={500}
                className={inputClass}
                value={preferences}
                onChange={(event) => setPreferences(event.target.value)}
              />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                className="size-5"
                type="checkbox"
                checked={canDrive}
                onChange={(event) => setCanDrive(event.target.checked)}
              />
              車を利用できる（通常は徒歩で確認）
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button ref={cancelButton} type="button" className={secondaryClass} onClick={onCancel}>
              キャンセル
            </button>
            <button
              ref={submitButton}
              type="submit"
              className={`flex-1 ${primaryClass}`}
              disabled={isGenerating || generationFailure?.status === 'conflict'}
            >
              {isGenerating ? '候補を生成中…' : '変更候補を探す'}
            </button>
          </div>
          {isGenerating && (
            <p aria-hidden="true" className="gt-enter flex items-center gap-2 text-sm">
              <ProgressMark />
              候補を探し、営業時間や移動にかかる時間を確認しています。
            </p>
          )}
          {generationFailure && (
            <div role="alert" className="gt-notice gt-enter space-y-1" data-tone="error">
              <p className="font-bold text-gt-warn">
                {generationMessages[generationFailure.status]}
              </p>
              {generationFailure.message && <p>{generationFailure.message}</p>}
              <p>元の旅程を表示しています。</p>
            </div>
          )}
        </form>
      )}

      {review && (
        <div className="gt-enter space-y-2">
          <div
            role="group"
            aria-label="変更候補を切り替える"
            className="grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-2"
          >
            {review.proposal.revisions.map((revision, index) => (
              <button
                key={revision.id}
                type="button"
                aria-pressed={review.selected === index}
                disabled={isApplying}
                className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-gt-rule bg-gt-paper p-1 text-sm font-semibold motion-safe:transition-colors motion-safe:duration-200 aria-pressed:border-gt-preview aria-pressed:bg-gt-preview-bg aria-pressed:text-gt-preview"
                onClick={() => {
                  setReview({ ...review, selected: index })
                  if (!requiresLatestTrip) setApplyFailure(null)
                }}
              >
                {candidateLabel(index)}
                <ConstraintBadge status={revision.constraintCheck.status} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-2">
            <p aria-hidden="true" className="flex flex-wrap items-center gap-1 text-sm">
              {label}を表示中
              {isApplying && <ProgressMark />}
              <StatusBadge key={approvalStatus} tone="unverified">
                <span className="gt-enter">{approvalStatus}</span>
              </StatusBadge>
            </p>
            <a
              href={`#stop-${encodeURIComponent(target.id)}`}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-gt-preview underline underline-offset-2"
            >
              路線図の分岐を見る
            </a>
          </div>
        </div>
      )}

      <RouteMap
        trip={trip}
        meta={meta}
        preview={candidate && { stop: candidate.diff.after, label, revisionId: candidate.id }}
      />

      {review && candidate && (
        <>
          <section className="space-y-3" aria-labelledby="comparison-heading">
            <h3 id="comparison-heading" className="text-lg font-bold">
              根拠と変更内容を比較
            </h3>
            <CandidateComparison
              key={candidate.id}
              trip={trip}
              revision={candidate}
              label={label}
              comparison={comparison}
            />
            <button
              type="button"
              className="min-h-11 text-sm font-bold underline disabled:opacity-50"
              disabled={isApplying || requiresLatestTrip}
              onClick={() => {
                setReview(null)
                setApplyFailure(null)
              }}
            >
              条件を見直す
            </button>
          </section>
          <footer className="space-y-2 border-t border-gt-rule bg-gt-bg py-2 pb-[max(8px,env(safe-area-inset-bottom))]">
            {applyFailure && (
              <div role="alert" className="gt-notice gt-enter font-semibold" data-tone="error">
                {applyMessages[applyFailure.status]} {applyFailure.message}
              </div>
            )}
            {approvalNote && (
              <p id="approval-note" className="text-sm text-gt-muted">
                {approvalNote}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={secondaryClass}
                disabled={isApplying}
                onClick={onCancel}
              >
                {applyFailure?.status === 'uncertain' ? '旅程を確認' : 'キャンセル'}
              </button>
              <button
                type="button"
                className={`flex-1 ${primaryClass}`}
                aria-disabled={!canApprove || !apply || isApplying}
                aria-describedby={approvalNote ? 'approval-note' : undefined}
                onClick={() => void approve()}
              >
                {isApplying ? '適用を確認中…' : '承認して適用を依頼'}
              </button>
            </div>
          </footer>
        </>
      )}
    </section>
  )
}
