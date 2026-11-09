'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'

import { MAX_REVISION_REASON_LENGTH, type Revision, type Stop, type Trip } from '@/domain'
import { StatusBadge } from '@/features/trip-map/evidence-badge'
import type { RouteMeta } from '@/features/trip-map/model'
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
  no_candidates: '条件に合う候補が見つかりませんでした。希望条件を見直して再試行できます。',
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

const inputClass = 'gt-field px-3 py-2'
const primaryClass = 'gt-button-primary'
const secondaryClass = 'gt-button-secondary'

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
  target: Stop
  meta?: RouteMeta
  generate: GenerateRevisions
  generationAvailable?: boolean
  apply?: ApplyRevision
  applyUnresolved?: boolean
  // 適用できない理由。applyが無いときの承認ボタンの説明に使う（省略時は「未接続」）。
  applyUnavailableReason?: string
  onCancel: () => void
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
  target,
  meta,
  generate,
  generationAvailable = true,
  apply,
  applyUnresolved = false,
  applyUnavailableReason,
  onCancel,
  onApplied,
  onApplyUnresolvedChange,
  onSiteReport,
}: RevisionReviewProps) {
  const [reason, setReason] = useState(onSiteReport?.reason ?? '')
  const [preferences, setPreferences] = useState('')
  const [canDrive, setCanDrive] = useState(false)
  const [invalidReason, setInvalidReason] = useState(false)
  // 理由と希望条件の合計が上限を超えたときの、結合後の文字数。
  const [reasonLength, setReasonLength] = useState<number | null>(null)
  const [generationFailure, setGenerationFailure] = useState<Exclude<
    RevisionResult,
    RevisionProposal
  > | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [confirming, setConfirming] = useState(false)
  const id = useId()
  const [isGenerating, setIsGenerating] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [applyFailure, setApplyFailure] = useState<{
    status: keyof typeof applyMessages
    message?: string
  } | null>(null)
  const activeGeneration = useRef<AbortController | null>(null)
  const activeApply = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const reasonField = useRef<HTMLTextAreaElement>(null)
  const preferencesField = useRef<HTMLTextAreaElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const stage = !review ? 'reason' : confirming ? 'confirm' : 'preview'

  useEffect(() => {
    heading.current?.focus()
  }, [stage])

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
    if (!generationAvailable) {
      setGenerationFailure({ status: 'unavailable' })
      return
    }
    if (activeGeneration.current || generationFailure?.status === 'conflict') return
    if (!reason.trim()) {
      setInvalidReason(true)
      reasonField.current?.focus()
      return
    }
    // PR #28のリクエストでは、理由と希望条件を一つのフィールドで渡す。
    const requestReason = composeReason(reason, preferences)
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
      : hoursUnconfirmed
        ? '営業時間を照合できる別の施設を探す場合は、希望条件を見直せます。'
        : walkingRouteMissing && !canDrive
          ? '車を使える場合は、条件を見直して車での移動も確認できます。'
          : null
  const reviewConditions = () => {
    setReview(null)
    setApplyFailure(null)
  }
  const constraintViolated = candidate?.constraintCheck.status === 'violated'
  const unapprovableNote = constraintViolated
    ? '旅程の条件に合わないため、この候補は選べません。'
    : '旅程に組み込めるか確認できていないため、この候補は選べません。'
  // 現地報告では、承認できない具体的な理由を承認欄にも添える（比較欄が画面の外にあっても理由が分かる）。
  const unapprovableReason =
    onSiteReport && candidate ? `理由：${candidate.constraintCheck.explanation}` : ''
  const approvalNote = constraintViolated
    ? `${unapprovableNote}${unapprovableReason}`
    : simulated
      ? '模擬報告のため適用できません。'
      : !constraintSatisfied
        ? `${unapprovableNote}${unapprovableReason}`
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
          setApplyFailure({ status: 'uncertain' })
        }
      } else {
        if (result.status !== 'uncertain') onApplyUnresolvedChange(false, decision.revision.id)
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
      aria-labelledby={`${id}-heading`}
      className="mx-auto max-w-[34rem] space-y-4 rounded-2xl bg-gt-bg p-3 text-gt-ink sm:p-5"
    >
      <header className="space-y-2">
        <p key={stage} className="gt-enter text-sm font-semibold text-gt-muted">
          部分修正 {stage === 'reason' ? '1' : stage === 'preview' ? '2' : '3'} / 3
        </p>
        <h2 id={`${id}-heading`} tabIndex={-1} ref={heading} className="gt-screen-title">
          {stage === 'reason'
            ? 'この予定だけ変更'
            : stage === 'preview'
              ? '候補を選ぶ'
              : '変更内容の確認'}
        </h2>
        <p className="text-sm font-bold wrap-anywhere">
          {target.plannedStartTime}　{target.name}
        </p>
        <p className="text-sm text-gt-muted">
          開始時刻と滞在時間を維持し、この予定の場所だけを変更します。
        </p>
        {stage === 'confirm' && review && (
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
        <form className="gt-card gt-enter space-y-4" onSubmit={generateCandidates} noValidate>
          <fieldset
            disabled={isGenerating || generationFailure?.status === 'conflict'}
            className="min-w-0 space-y-3"
          >
            <legend className="sr-only">部分修正の条件</legend>
            <label className="block space-y-1 text-sm font-semibold">
              <span>{onSiteReport ? '現地の報告内容' : '修正理由（必須）'}</span>
              <textarea
                ref={reasonField}
                required
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
                rows={2}
                maxLength={500}
                className={inputClass}
                value={preferences}
                aria-invalid={reasonLength !== null}
                aria-describedby={reasonLength !== null ? `${id}-length-error` : undefined}
                onChange={(event) => {
                  setPreferences(event.target.value)
                  setReasonLength(null)
                }}
              />
            </label>
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
          <div className="flex flex-wrap gap-2">
            <button ref={cancelButton} type="button" className={secondaryClass} onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              ref={submitButton}
              type="submit"
              className={`flex-1 ${primaryClass}`}
              disabled={
                !generationAvailable || isGenerating || generationFailure?.status === 'conflict'
              }
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

      {stage === 'preview' && review && candidate && (
        <div className="gt-enter space-y-3">
          <p className="text-sm font-semibold" role="status">
            {approvableCount === 0 ? '承認できる候補はありません' : `承認可能 ${approvableCount}件`}
            {review.proposal.revisions.length > approvableCount &&
              ` ／ 承認不可 ${review.proposal.revisions.length - approvableCount}件`}
          </p>
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
                data-approvable={isApprovable(revision)}
                className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-gt-muted bg-gt-paper p-2 text-sm font-semibold aria-pressed:border-gt-preview aria-pressed:outline-2 aria-pressed:outline-gt-preview aria-pressed:data-[approvable=true]:bg-gt-preview-bg"
                onClick={() => {
                  setReview({ ...review, selected: index })
                  if (!requiresLatestTrip) setApplyFailure(null)
                }}
              >
                <span>{candidateLabel(index)}</span>
                <span className={isApprovable(revision) ? 'text-gt-ok' : 'text-gt-muted'}>
                  {isApprovable(revision) ? '承認可能' : '承認不可'}
                </span>
              </button>
            ))}
          </div>
          <section className="gt-card space-y-3" aria-label="選択中の候補の概要">
            <div className="flex flex-wrap items-center gap-2">
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
                <p>この確認は候補に共通します。候補を切り替えるだけでは解消しません。</p>
              </div>
            )}
            {!constraintSatisfied && (
              <p className="text-sm">{candidate.constraintCheck.explanation}</p>
            )}
            {constraintSatisfied && approvalNote && <p className="text-sm">{approvalNote}</p>}
            <CandidatePreviewSummary trip={trip} revision={candidate} comparison={comparison} />
            {conditionsHint && (
              <div className="space-y-1">
                <p className="text-sm">{conditionsHint}</p>
                <button
                  type="button"
                  className={secondaryClass}
                  disabled={requiresLatestTrip}
                  onClick={reviewConditions}
                >
                  条件を見直す
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondaryClass} onClick={onCancel}>
                {requiresLatestTrip ? '旅程を確認' : cancelLabel}
              </button>
              <button
                type="button"
                className={canApprove ? primaryClass : secondaryClass}
                onClick={() => setConfirming(true)}
              >
                変更内容を確認する
              </button>
            </div>
          </section>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`#${encodeURIComponent(`${id}-stop-${target.id}`)}`}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-gt-preview underline underline-offset-2"
            >
              路線図の分岐を見る
            </a>
          </div>
        </div>
      )}

      {(stage === 'preview' || generationFailure) && (
        <RouteMap
          idPrefix={id}
          trip={trip}
          meta={meta}
          preview={candidate && { stop: candidate.diff.after, label, revisionId: candidate.id }}
        />
      )}

      {stage === 'confirm' && candidate && (
        <>
          <section className="gt-card space-y-3" aria-labelledby={`${id}-comparison`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${id}-comparison`} className="text-lg font-bold">
                {label}の根拠と変更内容
              </h3>
              <StatusBadge tone="unverified">{approvalStatus}</StatusBadge>
            </div>
            <button
              type="button"
              className={secondaryClass}
              disabled={isApplying || requiresLatestTrip}
              onClick={() => setConfirming(false)}
            >
              候補の選択へ戻る
            </button>
            <CandidateComparison
              key={candidate.id}
              trip={trip}
              revision={candidate}
              label={label}
              comparison={comparison}
            />
            {canReviewConditions && (
              <button
                type="button"
                className="min-h-11 text-sm font-bold underline disabled:opacity-50"
                disabled={isApplying || requiresLatestTrip}
                onClick={reviewConditions}
              >
                条件を見直す
              </button>
            )}
          </section>
          <footer className="space-y-2 border-t border-gt-rule bg-gt-bg py-2 pb-[max(8px,env(safe-area-inset-bottom))]">
            {applyFailure && (
              <div role="alert" className="gt-notice gt-enter font-semibold" data-tone="error">
                {applyMessages[applyFailure.status]} {applyFailure.message}
              </div>
            )}
            {approvalNote && (
              <p id={`${id}-approval-note`} className="text-sm text-gt-muted">
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
                {applyFailure?.status === 'uncertain' || (applyUnresolved && !isApplying)
                  ? '旅程を確認'
                  : cancelLabel}
              </button>
              <button
                type="button"
                className={`flex-1 ${primaryClass}`}
                aria-disabled={!canApprove || !apply || isApplying}
                aria-describedby={approvalNote ? `${id}-approval-note` : undefined}
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
