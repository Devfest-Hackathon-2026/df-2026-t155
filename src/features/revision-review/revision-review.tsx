'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'

import { MAX_REVISION_REASON_LENGTH, type Revision, type Stop, type Trip } from '@/domain'
import { ScreenHeader } from '@/features/screen-chrome/screen-header'
import { LockIcon } from '@/features/trip-map/icons'
import { StatusBadge } from '@/features/trip-map/evidence-badge'
import { routeStopKind, type RouteMeta } from '@/features/trip-map/model'
import { RouteMap } from '@/features/trip-map/route-map'
import type { ApplyRevisionResult } from '@/server/persistence/contracts'

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
import {
  CandidateComparison,
  CandidatePreviewSummary,
  ConstraintBadge,
  sharedRevisionBlockers,
} from './candidate-comparison'
import { checkStopEvidence } from './proposal-checks'

const generationMessages = {
  no_candidates: '条件に合う候補が見つかりませんでした。',
  insufficient_information:
    '候補を作るための情報が不足しています。変更理由や希望条件を補ってください。',
  external_service_error: '候補生成や照合に使う外部サービスでエラーが発生しました。',
  unavailable: '候補生成APIは現在利用できません。',
  interrupted: '通信が中断されました。接続を確認して再試行してください。',
  conflict: '旅程が更新されています。最新の旅程を確認してから部分修正を始め直してください。',
  invalid_request: '修正対象や入力内容を確認してください。',
  unexpected: '候補の応答を確認できませんでした。',
  unauthorized:
    '認証、招待、またはアプリの検証が通りませんでした。入力内容と表示中の旅程はそのままです。認証の状態を確認してから、もう一度お試しください。',
  rate_limited:
    '利用の回数が上限に達しています。入力内容はそのままです。しばらく時間をおいてからお試しください。繰り返し押しても上限は戻りません。',
  auth_required:
    '認証情報を取得できなかったため、依頼を送信しませんでした。入力内容はそのままです。認証の状態を確認してから、もう一度お試しください。',
  app_check_unavailable:
    'アプリの検証（App Check）を用意できなかったため、依頼を送信しませんでした。入力内容はそのままです。設定を確認するか、時間をおいてお試しください。',
} satisfies Record<Exclude<RevisionResult['status'], 'proposed'>, string>

const applyMessages = {
  conflict: '旅程が更新され、適用できませんでした。最新の旅程を確認してから始め直してください。',
  unavailable: '候補を適用するサービスは現在利用できません。',
  failed: '候補を適用できませんでした。',
  uncertain: '適用結果を確認できませんでした。再操作する前に最新の旅程を確認してください。',
}

type ApplyFailure = { status: keyof typeof applyMessages; message?: string }

const inputClass = 'gt-field px-3 py-2'
const primaryClass = 'gt-button-primary min-h-[52px] text-base font-bold'
const secondaryClass = 'gt-button-secondary border-2 border-gt-ink text-sm font-bold'

const mealPreferenceIcons = {
  budget: 'm6 4 6 8 6-8M7 12h10M7 16h10M12 12v8',
  time: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2',
  taste: 'M4 3v5a3 3 0 0 0 6 0V3M7 3v18M19 3c-2 1-4 4-4 9h4m0-9v18',
}

function ProgressMark() {
  return (
    <span
      aria-hidden="true"
      className="gt-spinner size-4 shrink-0 rounded-full border-2 border-gt-preview/30 border-t-gt-preview"
    />
  )
}

// 依頼の理由（修正理由＋希望条件）の上限。保存契約（Revision.reason）に合わせる。
const MAX_REASON_LENGTH = MAX_REVISION_REASON_LENGTH

// 修正理由と希望条件を、サーバーへ送る一つの理由にまとめる。
const composeReason = (reason: string, preferences: string) =>
  [reason.trim(), preferences.trim() && `希望条件：${preferences.trim()}`]
    .filter(Boolean)
    .join('\n')

interface RevisionReviewProps {
  trip: Trip
  active?: boolean
  target: Stop
  meta?: RouteMeta
  generate: GenerateRevisions
  generationAvailable?: boolean
  apply?: ApplyRevision
  applyUnresolved?: boolean
  // 適用できない理由。applyが無いときの承認ボタンの説明に使う（省略時は「未接続」）。
  applyUnavailableReason?: string
  onCancel: () => void
  onLeaveWhileApplying: () => void
  onApplyFailureAfterLeave: (message?: string) => void
  onApplied: (trip: Trip, receipt?: ApplyRevisionResult, revisionId?: string) => void
  onApplyUnresolvedChange: (unresolved: boolean, revisionId?: string) => void
  // 現地報告は修正理由と文脈をまとめて受け取り、旅行前と同じ修正エンジンで扱う。
  onSiteReport?: {
    reason: string
    context: Extract<RevisionRequest['context'], { phase: 'on_site' }>
  }
}

type Review = { request: RevisionRequest; proposal: RevisionProposal; selected: number }

const candidateLabel = (index: number) =>
  `候補 ${index < 26 ? String.fromCharCode(65 + index) : index + 1}`

export function RevisionReview({
  trip,
  active = true,
  target,
  meta,
  generate,
  generationAvailable = true,
  apply,
  applyUnresolved = false,
  applyUnavailableReason,
  onCancel,
  onLeaveWhileApplying,
  onApplyFailureAfterLeave,
  onApplied,
  onApplyUnresolvedChange,
  onSiteReport,
}: RevisionReviewProps) {
  const isMeal = routeStopKind(target, meta?.[target.id]) === 'meal'
  const [mealPreference, setMealPreference] = useState('')
  const [reason, setReason] = useState(onSiteReport?.reason ?? '')
  const [preferences, setPreferences] = useState('')
  const [canDrive, setCanDrive] = useState(false)
  const reasonRequired = !mealPreference
  const [invalidReason, setInvalidReason] = useState(false)
  // 理由と希望条件の合計が上限を超えたときの、結合後の文字数。
  const [reasonLength, setReasonLength] = useState<number | null>(null)
  const [generationFailure, setGenerationFailure] = useState<Exclude<
    RevisionResult,
    RevisionProposal
  > | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [detailed, setDetailed] = useState(false)
  const id = useId()
  const [isGenerating, setIsGenerating] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [applyFailure, setApplyFailure] = useState<ApplyFailure | null>(null)
  const activeGeneration = useRef<AbortController | null>(null)
  const activeApply = useRef<AbortController | null>(null)
  const leftWhileApplying = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const reasonField = useRef<HTMLTextAreaElement>(null)
  const preferencesField = useRef<HTMLTextAreaElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const stage = !review ? 'reason' : detailed ? 'detail' : confirming ? 'confirm' : 'preview'

  const previewReturn = useRef<{ control: 'detail' | 'confirm'; top: number } | null>(null)
  const previewDetail = useRef<HTMLButtonElement>(null)
  const previewConfirm = useRef<HTMLButtonElement>(null)
  const shownStage = useRef<typeof stage | null>(null)

  useLayoutEffect(() => {
    if (!active && activeGeneration.current) {
      activeGeneration.current.abort()
      activeGeneration.current = null
      setIsGenerating(false)
      setGenerationFailure({ status: 'interrupted' })
    }
  }, [active])

  useEffect(() => {
    if (!active) {
      shownStage.current = null
      return
    }
    if (shownStage.current === stage) return
    shownStage.current = stage
    if (stage === 'preview' && previewReturn.current) {
      const { control, top } = previewReturn.current
      previewReturn.current = null
      const trigger = control === 'detail' ? previewDetail.current : previewConfirm.current
      trigger?.focus({ preventScroll: true })
      if (window.scrollY !== top) window.scrollTo({ top, behavior: 'instant' })
      return
    }
    heading.current?.focus()
  }, [active, stage])

  const openPreviewStep = (control: 'detail' | 'confirm') => {
    previewReturn.current = { control, top: window.scrollY }
    if (control === 'detail') setDetailed(true)
    else setConfirming(true)
  }

  useLayoutEffect(() => {
    if (!active || !generationFailure) return
    // disabledが反映されたDOMで判定し、待機中に移したフォーカスを維持する。
    const focused = document.activeElement
    if (focused && focused !== document.body && !focused.matches(':disabled')) return

    const submit = submitButton.current
    const destination = submit && !submit.disabled ? submit : cancelButton.current
    destination?.focus()
  }, [active, generationFailure])

  // 親はTrip差し替え時にこのセッションを閉じる。コミット時点で古い応答を無効にする。
  useLayoutEffect(
    () => () => {
      activeGeneration.current?.abort()
      activeGeneration.current = null
      activeApply.current?.abort()
      activeApply.current = null
    },
    [],
  )

  // 候補生成が外れたら、未適用の比較を破棄する。適用中または結果未確認の状態は
  // 子の再マウントで失われないよう保持し、サーバー確認なしに再操作を解禁しない。
  useEffect(() => {
    if (generationAvailable) {
      setGenerationFailure((current) => (current?.status === 'unavailable' ? null : current))
      return
    }
    activeGeneration.current?.abort()
    activeGeneration.current = null
    setIsGenerating(false)
    if (
      activeApply.current ||
      applyUnresolved ||
      applyFailure?.status === 'conflict' ||
      applyFailure?.status === 'uncertain'
    ) {
      return
    }
    setReview(null)
    setGenerationFailure({ status: 'unavailable' })
  }, [generationAvailable, applyUnresolved, applyFailure?.status])

  const generateCandidates = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!active) return
    if (!generationAvailable) {
      setGenerationFailure({ status: 'unavailable' })
      return
    }
    if (activeGeneration.current || generationFailure?.status === 'conflict') return
    const useDefaultReason =
      !onSiteReport &&
      event.nativeEvent instanceof SubmitEvent &&
      event.nativeEvent.submitter?.getAttribute('value') === 'any'
    const requestedReason = [mealPreference, reason.trim()].filter(Boolean).join('\n')
    if (!useDefaultReason && !requestedReason) {
      setInvalidReason(true)
      reasonField.current?.focus()
      return
    }
    // PR #28のリクエストでは、理由と希望条件を一つのフィールドで渡す。
    const requestReason = composeReason(
      requestedReason || 'おまかせで別の場所を探したい',
      preferences,
    )
    if (requestReason.length > MAX_REASON_LENGTH) {
      // 保存契約の上限を超える依頼は作らない。送信は止めず、短くする欄を示して移る。
      setReasonLength(requestReason.length)
      preferencesField.current?.focus()
      return
    }
    const request: RevisionRequest = {
      trip: structuredClone(trip),
      targetStopId: target.id,
      reason: requestReason,
      context: onSiteReport?.context ?? { phase: 'planning' },
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
        setConfirming(false)
        setDetailed(false)
        previewReturn.current = null
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
    applyUnresolved || applyFailure?.status === 'conflict' || applyFailure?.status === 'uncertain'
  const constraintSatisfied = candidate?.constraintCheck.status === 'satisfied'
  const simulated =
    candidate?.context.phase === 'on_site' && candidate.context.report.kind === 'simulated'
  const proposalToken = candidate && review?.proposal.proposalTokens?.[candidate.id]
  const isApprovable = (revision: Revision) =>
    Boolean(apply) &&
    generationAvailable &&
    revision.constraintCheck.status === 'satisfied' &&
    !requiresLatestTrip &&
    !(revision.context.phase === 'on_site' && revision.context.report.kind === 'simulated') &&
    Boolean(review?.proposal.proposalTokens?.[revision.id])
  const canApprove = Boolean(candidate && isApprovable(candidate))
  const approvableCount = review?.proposal.revisions.filter(isApprovable).length ?? 0
  const blockers =
    candidate && !constraintSatisfied ? sharedRevisionBlockers(trip, candidate, comparison) : []
  const canReviewConditions = blockers.length === 0
  const canRetryPlaceLookup =
    !constraintSatisfied && Boolean(comparison?.failedPlaceLookups?.length)
  const reviewConditionsLabel = canRetryPlaceLookup ? '条件に戻って再試行' : '条件を見直す'
  const hoursUnconfirmed =
    candidate?.constraintCheck.status === 'unknown' &&
    checkStopEvidence(candidate.diff.after, 'opening_hours').status === 'unverifiable'
  const walkingRouteMissing = [comparison?.after.fromPrevious, comparison?.after.toNext].some(
    (slot) =>
      slot?.presence === 'segment' &&
      slot.segment.status === 'unknown' &&
      slot.segment.reason === 'no_route' &&
      slot.segment.mode === 'walk',
  )
  const conditionsHint =
    !canReviewConditions || simulated
      ? null
      : canRetryPlaceLookup
        ? '同じ希望条件で探し直せます。'
        : hoursUnconfirmed
          ? '営業時間を照合できる別の施設を探す場合は、希望条件を見直せます。'
          : walkingRouteMissing && !canDrive
            ? '車を使える場合は、条件を見直して車での移動も確認できます。'
            : null
  const reviewConditions = () => {
    previewReturn.current = null
    setReview(null)
    setApplyFailure(null)
  }
  const constraintViolated = candidate?.constraintCheck.status === 'violated'
  // 比較欄が画面の外にあっても、承認欄で止まっている理由が分かるようにする。
  const unapprovableReason = candidate?.constraintCheck.explanation
  const approvalNote = constraintViolated
    ? unapprovableReason
    : simulated
      ? '模擬報告のため適用できません。'
      : !constraintSatisfied
        ? unapprovableReason
        : isApplying
          ? null
          : requiresLatestTrip
            ? '再操作する前に最新の旅程を確認してください。'
            : !apply
              ? (applyUnavailableReason ?? '承認・適用サービスは未接続です。')
              : !proposalToken
                ? '候補の来歴を確認できません。保存した旅程から候補を作り直してください。'
                : null
  // 現地報告から開いたときの「キャンセル」は、旅程ではなく報告画面に戻る操作になる。
  const cancelLabel = onSiteReport ? '報告を見直す' : 'キャンセル'
  const approvalStatus = isApplying
    ? '承認操作済み・適用結果を確認中'
    : applyFailure?.status === 'uncertain' || applyUnresolved
      ? '適用結果未確認'
      : applyFailure
        ? '適用されていません'
        : '未承認・未適用'

  const approve = async () => {
    if (
      !review ||
      !candidate ||
      !proposalToken ||
      !canApprove ||
      !apply ||
      isApplying ||
      activeApply.current
    )
      return
    // 表示時の候補と、本人が承認した時点のTripを検証用に確保する。
    // コールバックには別のコピーだけを渡し、検証用のデータを変更できないようにする。
    const decision = structuredClone({
      request: { ...review.request, trip },
      revision: candidate,
      proposalToken,
    })
    if (!sameTrip(decision.request.trip, review.request.trip)) {
      setApplyFailure({ status: 'conflict' })
      return
    }
    const attempt = new AbortController()
    activeApply.current = attempt
    leftWhileApplying.current = false
    setApplyFailure(null)
    setIsApplying(true)
    try {
      // 永続ロックの記録に失敗したらHTTP送信を開始しない。
      onApplyUnresolvedChange(true, decision.revision.id)
    } catch (error) {
      activeApply.current = null
      setIsApplying(false)
      setApplyFailure({
        status: 'unavailable',
        message: error instanceof Error ? error.message : '未確認状態を保存できません。',
      })
      return
    }
    let failure: ApplyFailure | undefined
    try {
      const result = await apply(structuredClone(decision), attempt.signal)
      if (activeApply.current !== attempt) return
      if (result.status === 'applied') {
        const nextTrip = confirmedTrip(
          decision.request.trip,
          decision.revision,
          result.trip,
          result.receipt,
        )
        if (nextTrip) {
          onApplied(nextTrip, result.receipt, decision.revision.id)
        } else {
          failure = { status: 'uncertain' }
        }
      } else {
        if (result.status !== 'uncertain') onApplyUnresolvedChange(false, decision.revision.id)
        failure = result
      }
    } catch {
      failure = { status: 'uncertain' }
    } finally {
      if (activeApply.current === attempt) {
        activeApply.current = null
        setIsApplying(false)
        if (failure) {
          if (leftWhileApplying.current) {
            onApplyFailureAfterLeave(
              failure.status === 'uncertain'
                ? undefined
                : `${applyMessages[failure.status]} ${failure.message ?? ''}`.trim(),
            )
          } else {
            setApplyFailure(failure)
          }
        }
      }
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="gt-revision-flow space-y-4 text-gt-ink">
      <ScreenHeader
        headingId={`${id}-heading`}
        headingRef={heading}
        title={
          stage === 'reason'
            ? 'この予定だけ変更'
            : stage === 'preview'
              ? '候補を選ぶ'
              : stage === 'detail'
                ? '詳しく比較'
                : '変更内容の確認'
        }
        subtitle={
          stage === 'reason'
            ? 'どんな場所に変えたい？'
            : stage === 'confirm'
              ? '承認する前の確認です'
              : review?.request.reason
        }
        backLabel={
          stage === 'confirm'
            ? '候補の選択へ戻る'
            : stage === 'detail'
              ? '比較から戻る'
              : '部分修正を閉じる'
        }
        onBack={
          stage === 'confirm'
            ? () => setConfirming(false)
            : stage === 'detail'
              ? () => setDetailed(false)
              : onCancel
        }
        disabled={isApplying || ((stage === 'confirm' || stage === 'detail') && requiresLatestTrip)}
      />

      {stage === 'reason' && (
        <div className="space-y-2.5">
          <div className="rounded-[14px] border border-gt-line border-l-[6px] bg-gt-paper px-3.5 py-2.5">
            <p className="text-xs font-bold text-gt-line-strong">変える予定（1つだけ）</p>
            <p className="text-lg font-bold wrap-anywhere">
              {target.plannedStartTime}　{target.name}
            </p>
          </div>
          <p className="text-xs font-semibold">
            他の予定・固定時刻は変わりません。開始時刻と滞在時間を維持します。
          </p>
        </div>
      )}

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
            {!onSiteReport && isMeal && (
              <div className="grid gap-2.5" role="group" aria-label="食事の希望">
                {[
                  {
                    label: '安い',
                    icon: mealPreferenceIcons.budget,
                    value: 'もっと安いお店にしたい',
                    hint: '予算を抑えたいという希望を候補探しに使います',
                  },
                  {
                    label: '早い',
                    icon: mealPreferenceIcons.time,
                    value: '移動時間を短くしたい',
                    hint: '確認できた移動時間で比べます',
                  },
                  {
                    label: 'うまい',
                    icon: mealPreferenceIcons.taste,
                    value: '料理の好みを重視したい',
                    hint: '料理の好みを重視します。おいしさを保証するものではありません',
                  },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={mealPreference === option.value}
                    className="flex min-h-[70px] items-center gap-3 rounded-[14px] border border-gt-rail bg-gt-paper px-3.5 py-2.5 text-left aria-pressed:border-gt-action aria-pressed:bg-gt-line-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
                    onClick={() => {
                      setMealPreference((current) => (current === option.value ? '' : option.value))
                      setInvalidReason(false)
                      setReasonLength(null)
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="grid size-10 shrink-0 place-items-center rounded-full border-2 border-gt-action bg-gt-line-tint text-gt-line-strong"
                    >
                      <svg
                        className="size-5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d={option.icon} />
                      </svg>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-lg font-bold">{option.label}</span>
                      <span className="block text-xs text-gt-muted">{option.hint}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`size-5 shrink-0 rounded-full border-2 ${mealPreference === option.value ? 'border-gt-action bg-gt-action ring-2 ring-white ring-inset' : 'border-gt-muted'}`}
                    />
                  </button>
                ))}
              </div>
            )}
            <label className="block space-y-1 text-sm font-semibold">
              <span>
                {onSiteReport
                  ? '現地の報告内容'
                  : reasonRequired
                    ? '修正理由（必須）'
                    : '修正理由（任意）'}
              </span>
              <textarea
                ref={reasonField}
                required={reasonRequired}
                rows={2}
                maxLength={500}
                className={inputClass}
                value={reason}
                readOnly={onSiteReport !== undefined}
                aria-invalid={invalidReason}
                aria-describedby={invalidReason ? `${id}-reason-error` : undefined}
                onChange={(event) => {
                  setReason(event.target.value)
                  setInvalidReason(false)
                  setReasonLength(null)
                }}
              />
            </label>
            {onSiteReport && (
              <p className="text-sm text-gt-muted">報告を直す場合は、前の画面に戻ってください。</p>
            )}
            {invalidReason && (
              <p id={`${id}-reason-error`} role="alert" className="text-sm text-gt-warn">
                修正理由を入力してください。
              </p>
            )}
            <label className="block space-y-1 text-sm font-semibold">
              <span>希望条件（任意）</span>
              <textarea
                ref={preferencesField}
                rows={1}
                maxLength={500}
                className={inputClass}
                value={preferences}
                aria-invalid={reasonLength !== null}
                aria-describedby={
                  [
                    isMeal && `${id}-preferences-hint`,
                    reasonLength !== null && `${id}-length-error`,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                onChange={(event) => {
                  setPreferences(event.target.value)
                  setReasonLength(null)
                }}
              />
            </label>
            {isMeal && (
              <p id={`${id}-preferences-hint`} className="text-sm text-gt-muted">
                例：あたたかい麺、和食
              </p>
            )}
            {reasonLength !== null && (
              <p id={`${id}-length-error`} role="alert" className="text-sm text-gt-warn">
                {`${onSiteReport ? '現地の報告内容' : '修正理由'}と希望条件を合わせて${MAX_REASON_LENGTH}文字以内にしてください（現在${reasonLength}文字）。${onSiteReport ? '希望条件' : '修正理由か希望条件'}を短くしてから、もう一度送ってください。`}
              </p>
            )}
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
          {generationFailure && (
            <div role="alert" className="gt-notice gt-enter space-y-1" data-tone="error">
              <p className="font-bold text-gt-warn">
                {generationMessages[generationFailure.status]}
              </p>
              {generationFailure.message && <p>{generationFailure.message}</p>}
              {generationFailure.status === 'no_candidates' && (
                <p>
                  希望条件を減らすか、探したい施設の種類を具体的にして、もう一度お試しください。
                </p>
              )}
              <p>元の旅程を表示しています。</p>
            </div>
          )}
          <div className="grid gap-2.5">
            <button
              ref={submitButton}
              type="submit"
              className={primaryClass}
              disabled={
                !generationAvailable || isGenerating || generationFailure?.status === 'conflict'
              }
            >
              {isGenerating ? '候補を生成中…' : '変更候補を探す'}
            </button>
            {!onSiteReport && !mealPreference && !reason.trim() && (
              <button
                type="submit"
                value="any"
                className={`${secondaryClass} min-h-[52px]`}
                disabled={
                  !generationAvailable || isGenerating || generationFailure?.status === 'conflict'
                }
              >
                {preferences.trim() ? '入力した希望で探す' : 'こだわらない（おまかせで探す）'}
              </button>
            )}
            <button
              ref={cancelButton}
              type="button"
              className="min-h-11 justify-self-start text-sm font-bold underline"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          </div>
          <p className="gt-card px-3 py-2 text-xs text-gt-muted">
            選んだ条件は、探すときの希望です。確認できない情報は、確認できないと表示します。
          </p>
          {isGenerating && (
            <p aria-hidden="true" className="gt-enter flex items-center gap-2 text-sm">
              <ProgressMark />
              候補を探し、営業時間や移動にかかる時間を確認しています。
            </p>
          )}
        </form>
      )}

      {stage === 'preview' && review && candidate && (
        <>
          <section
            role="group"
            aria-label="変更候補を切り替える"
            className="gt-revision-candidates grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-2"
          >
            {review.proposal.revisions.map((revision, index) => (
              <button
                key={revision.id}
                type="button"
                aria-pressed={review.selected === index}
                disabled={isApplying}
                aria-label={`${candidateLabel(index)} ${revision.diff.after.name} ${isApprovable(revision) ? '承認可能' : '承認不可'}`}
                className="gt-revision-ticket flex min-h-28 min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl border border-gt-rule bg-gt-paper p-2 text-xs font-semibold aria-pressed:border-gt-preview aria-pressed:bg-gt-preview-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
                onClick={() => {
                  setReview({ ...review, selected: index })
                  if (!requiresLatestTrip) setApplyFailure(null)
                }}
              >
                <span className="text-xl font-bold text-gt-preview">
                  {candidateLabel(index).slice(3)}
                </span>
                <span className="line-clamp-2 min-h-8 w-full wrap-anywhere">
                  {revision.diff.after.name}
                </span>
                <span className={isApprovable(revision) ? 'text-gt-ok' : 'text-gt-muted'}>
                  {isApprovable(revision) ? '承認可能' : '承認不可'}
                </span>
                <span className="min-h-4 text-gt-preview">
                  {review.selected === index ? '選択中' : ' '}
                </span>
              </button>
            ))}
          </section>
          <div className="gt-revision-route-note space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
              <StatusBadge tone="unverified">未承認の候補（プレビュー）</StatusBadge>
              <span className="text-gt-muted">まだ旅程には反映されていません。</span>
            </div>
            <p className="flex items-center gap-1.5 text-xs font-bold">
              <LockIcon size={14} /> 他の予定・固定時刻は変わりません
            </p>
            <RouteMap
              idPrefix={id}
              trip={trip}
              meta={meta}
              preview={{ stop: candidate.diff.after, label, revisionId: candidate.id }}
            />
          </div>
          <div className="gt-enter gt-preview-panel gt-revision-paper space-y-3 pt-2 pb-3">
            <h3 className="text-lg font-bold">変える前に、根拠を比較</h3>
            <p className="text-sm font-semibold" role="status">
              {approvableCount === 0
                ? '承認できる候補はありません'
                : `承認可能 ${approvableCount}件`}
              {review.proposal.revisions.length > approvableCount &&
                ` ／ 承認不可 ${review.proposal.revisions.length - approvableCount}件`}
            </p>
            <section className="space-y-3" aria-label="選択中の候補の概要">
              <div className="gt-revision-selected flex flex-wrap items-center gap-2 p-2.5">
                <h3 className="font-bold">
                  {label}　{candidate.diff.after.name}
                </h3>
                <ConstraintBadge status={candidate.constraintCheck.status} />
                <StatusBadge tone="unverified">{approvalStatus}</StatusBadge>
              </div>
              {blockers.length > 0 && (
                <div className="gt-notice space-y-1" data-tone="error">
                  <ul className="list-disc space-y-1 pl-5">
                    {blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                  <p>
                    この確認は候補に共通します。候補を切り替えるだけでは解消しません。
                    元の旅程に戻り、対象や前後の予定を確認してください。
                  </p>
                </div>
              )}
              {!constraintSatisfied && (
                <p className="text-sm">{candidate.constraintCheck.explanation}</p>
              )}
              {constraintSatisfied && approvalNote && <p className="text-sm">{approvalNote}</p>}
              {(conditionsHint ||
                (approvableCount === 0 &&
                  !constraintSatisfied &&
                  canReviewConditions &&
                  !requiresLatestTrip &&
                  !simulated)) && (
                <div className="space-y-1">
                  <p className="text-sm">
                    {conditionsHint ??
                      '条件を見直して別の候補を探すか、元の予定を使い続けられます。'}
                  </p>
                  <button
                    type="button"
                    className={secondaryClass}
                    disabled={requiresLatestTrip}
                    onClick={reviewConditions}
                  >
                    {reviewConditionsLabel}
                  </button>
                </div>
              )}
              <button
                type="button"
                className="min-h-11 text-left text-xs font-bold text-gt-line-strong underline underline-offset-2"
                ref={previewDetail}
                onClick={() => openPreviewStep('detail')}
              >
                詳しく比較
              </button>
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2.5">
                <button type="button" className={secondaryClass} onClick={onCancel}>
                  {requiresLatestTrip ? '旅程を確認' : cancelLabel}
                </button>
                <button
                  type="button"
                  ref={previewConfirm}
                  className={primaryClass}
                  onClick={() => openPreviewStep('confirm')}
                >
                  変更内容を確認する
                </button>
              </div>
              <CandidatePreviewSummary trip={trip} revision={candidate} comparison={comparison} />
            </section>
          </div>
        </>
      )}

      {generationFailure && <RouteMap idPrefix={id} trip={trip} meta={meta} />}

      {stage === 'detail' && candidate && (
        <>
          <div className="flex flex-wrap gap-1.5 text-xs font-bold">
            <span className="gt-revision-chip gt-revision-chip-candidate">{label}（未承認）</span>
            <span className="gt-revision-chip gt-revision-chip-original">変更前＝元の予定</span>
          </div>
          <CandidateComparison
            trip={trip}
            revision={candidate}
            label={label}
            comparison={comparison}
          />
          <div className="grid grid-cols-2 gap-2.5">
            <button type="button" className={secondaryClass} onClick={() => setDetailed(false)}>
              戻る
            </button>
            <button
              type="button"
              className={primaryClass}
              onClick={() => {
                setDetailed(false)
                setConfirming(true)
              }}
            >
              変更内容を確認する
            </button>
          </div>
        </>
      )}

      {stage === 'confirm' && candidate && (
        <>
          <div className="gt-revision-paper space-y-2">
            <h3 className="text-xl leading-tight font-bold wrap-anywhere">
              「{candidate.diff.after.name}」{canApprove ? 'に変更します' : 'への変更内容'}
            </h3>
            <span className="inline-flex rounded-lg border border-gt-preview bg-gt-preview-bg px-2 py-0.5 text-[11px] font-bold text-gt-preview">
              <span>{approvalStatus}</span>
              {candidate.approval.status === 'pending' && !isApplying && !requiresLatestTrip
                ? '・まだ旅程に反映されていません'
                : ''}
            </span>
          </div>
          <section className="gt-card space-y-2 rounded-[14px] border-[3px] border-gt-line p-3.5">
            <h3 className="text-sm font-bold text-gt-line-strong">変更されるもの</h3>
            <p className="border-t border-gt-rule pt-2 text-sm wrap-anywhere">
              <span className="block text-xs text-gt-muted">{target.plannedStartTime}の予定</span>
              {target.name} → <strong>{candidate.diff.after.name}</strong>
            </p>
          </section>
          <section className="gt-card space-y-2 rounded-[14px] border-2 border-gt-rail bg-[#ecebe5] p-3.5">
            <h3 className="text-sm font-bold">変更されないもの</h3>
            <ul className="divide-y divide-gt-rule border-t border-gt-rule text-sm">
              {trip.stops
                .filter((stop) => stop.id !== target.id)
                .map((stop) => (
                  <li
                    key={stop.id}
                    className="flex flex-wrap items-center justify-between gap-x-2 py-1.5 wrap-anywhere"
                  >
                    <span>
                      {stop.plannedStartTime} {stop.name}
                    </span>
                    {stop.isFixed && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-gt-ink bg-gt-paper px-1.5 text-[11px] font-bold">
                        <LockIcon size={11} />
                        固定・変更なし
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          </section>
          <CandidateComparison
            trip={trip}
            revision={candidate}
            label={label}
            comparison={comparison}
            compact
          />
          <footer className="space-y-2 pb-[max(8px,env(safe-area-inset-bottom))]">
            {applyFailure && (
              <div role="alert" className="gt-notice gt-enter font-semibold" data-tone="error">
                {applyMessages[applyFailure.status]} {applyFailure.message}
              </div>
            )}
            {approvalNote && (
              <p
                id={`${id}-approval-note`}
                className="rounded-[14px] border border-gt-unk/60 bg-gt-unk-bg p-3 text-sm text-gt-unk"
              >
                {approvalNote}
              </p>
            )}
            <div className="grid gap-2.5">
              <button
                type="button"
                className={primaryClass}
                aria-disabled={!canApprove || !apply || isApplying}
                aria-describedby={approvalNote ? `${id}-approval-note` : undefined}
                onClick={() => void approve()}
              >
                {isApplying ? '適用を確認中…' : '承認して適用を依頼'}
              </button>
              {isApplying ? (
                <button
                  type="button"
                  className={`${secondaryClass} min-h-[52px]`}
                  onClick={() => {
                    if (!activeApply.current) return
                    leftWhileApplying.current = true
                    onLeaveWhileApplying()
                  }}
                >
                  旅程へ戻る（適用の確認を続ける）
                </button>
              ) : (
                <button
                  type="button"
                  className={`${secondaryClass} min-h-[52px]`}
                  onClick={onCancel}
                >
                  {applyFailure?.status === 'uncertain' || applyUnresolved
                    ? '旅程を確認'
                    : cancelLabel}
                </button>
              )}
            </div>
            <p className="text-xs text-gt-muted">
              変更する前に、固定予定や時刻の条件をサーバーでもう一度確認します。
            </p>
          </footer>
          {canReviewConditions && (
            <button
              type="button"
              className="min-h-11 text-sm font-bold underline disabled:opacity-50"
              disabled={isApplying || requiresLatestTrip}
              onClick={reviewConditions}
            >
              {reviewConditionsLabel}
            </button>
          )}
        </>
      )}
    </section>
  )
}
