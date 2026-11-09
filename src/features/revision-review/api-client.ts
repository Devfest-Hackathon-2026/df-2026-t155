import { z } from 'zod'

import {
  KnownTravelModeSchema,
  ProposalFailureSchema,
  RevisionContextSchema,
  ReviseTripRequestSchema,
  ReviseTripResponseSchema,
  StopSchema,
  TripSchema,
  type KnownTravelSegment,
  type ReviseTripRequest,
  type ReviseTripResponse,
  type Revision,
  type Stop,
  type TravelSegmentSlot,
  type Trip,
} from '@/domain'
import { TextSchema } from '@/domain/primitives'
import { getProtectedApiHeaders } from '@/lib/auth/protected-api'
import {
  classifyProtectedHeaderError,
  classifyProtectedStatus,
  PROTECTED_FAILURE_MESSAGES,
} from '@/lib/auth/protected-api-errors'
import {
  ApplyRevisionResponseSchema,
  type ApplyRevisionResult,
} from '@/server/persistence/contracts'

import { checkCandidate, retainsApprovedEvidence } from './proposal-checks'

export type RevisionRequest = ReviseTripRequest & { travelModes?: KnownTravelSegment['mode'][] }

const travelModesSchema = z.array(KnownTravelModeSchema).min(1).max(2).optional()

export type { TravelComparison, TravelSegmentSlot as TravelSlot } from '@/domain'
export type RevisionProposal = Extract<ReviseTripResponse, { status: 'proposed' }>

export type RevisionResult =
  | RevisionProposal
  | z.infer<typeof ProposalFailureSchema>
  | {
      status:
        | 'unavailable'
        | 'interrupted'
        | 'conflict'
        | 'invalid_request'
        | 'unexpected'
        | 'unauthorized'
        | 'rate_limited'
        | 'auth_required'
        | 'app_check_unavailable'
      message?: string
    }

export type GenerateRevisions = (
  request: RevisionRequest,
  signal: AbortSignal,
) => Promise<RevisionResult>

// 本人の承認操作を受け取る。applied と失敗はサーバーで結果が確定した場合にだけ返す。
export type ApplyRevision = (
  decision: {
    request: RevisionRequest
    revision: Revision
    proposalToken: string
  },
  signal?: AbortSignal,
) => Promise<
  | { status: 'applied'; trip: Trip; receipt?: ApplyRevisionResult }
  | { status: 'conflict' | 'unavailable' | 'failed' | 'uncertain'; message?: string }
>

// 既定は本人のBearer＋App Check。テストでは通信とヘッダー取得のみ差し替える。
export interface RevisionRequestDeps {
  fetchFn?: typeof fetch
  getHeaders?: () => Promise<Headers>
}

export const requestRevisions = async (
  request: RevisionRequest,
  signal: AbortSignal,
  {
    fetchFn = (...args) => fetch(...args),
    getHeaders = getProtectedApiHeaders,
  }: RevisionRequestDeps = {},
): Promise<RevisionResult> => {
  const { travelModes, ...base } = request
  const input = ReviseTripRequestSchema.safeParse(base)
  const modes = travelModesSchema.safeParse(travelModes)
  if (!input.success || !modes.success) return { status: 'invalid_request' }
  const checkedRequest = { ...input.data, travelModes: modes.data }

  let headers: Headers
  try {
    headers = await getHeaders()
  } catch (error) {
    const status = classifyProtectedHeaderError(error)
    return { status, message: PROTECTED_FAILURE_MESSAGES[status] }
  }
  headers.set('Content-Type', 'application/json')

  let response: Response
  let bodyText: string
  try {
    response = await fetchFn('/api/trips/revise', {
      method: 'POST',
      headers,
      body: JSON.stringify(checkedRequest),
      signal,
    })
    const protectedFailure = classifyProtectedStatus(response.status)
    if (protectedFailure) {
      return { status: protectedFailure, message: PROTECTED_FAILURE_MESSAGES[protectedFailure] }
    }
    if ([404, 405, 503].includes(response.status)) return { status: 'unavailable' }
    if (response.status === 409) return { status: 'conflict' }
    if ([400, 413, 415].includes(response.status)) return { status: 'invalid_request' }
    bodyText = await response.text()
  } catch {
    return { status: 'interrupted' }
  }

  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return { status: 'unexpected' }
  }
  const failure = ProposalFailureSchema.safeParse(body)
  if (failure.success) {
    const expected = failure.data.status === 'external_service_error' ? 502 : 422
    if (response.status === expected || (response.status === 200 && expected === 422))
      return failure.data
  }
  if (response.status === 200) {
    return readRevisionProposal(body, checkedRequest) ?? { status: 'unexpected' }
  }
  return { status: 'unexpected' }
}

function sameStop(left: Stop, right: Stop) {
  // 共通スキーマでキー順を揃え、根拠を含む変更前のStopを比較する。
  return JSON.stringify(StopSchema.parse(left)) === JSON.stringify(StopSchema.parse(right))
}

export function sameTrip(left: Trip, right: Trip): boolean {
  const parsedLeft = TripSchema.safeParse(left)
  const parsedRight = TripSchema.safeParse(right)
  return (
    parsedLeft.success &&
    parsedRight.success &&
    JSON.stringify(parsedLeft.data) === JSON.stringify(parsedRight.data)
  )
}

function matchesRevisionTarget(revision: Revision, trip: Trip, target: Stop) {
  return (
    !target.isFixed &&
    revision.approval.status === 'pending' &&
    revision.tripId === trip.id &&
    revision.baseTripVersion === trip.version &&
    revision.targetStopId === target.id &&
    sameStop(revision.diff.before, target)
  )
}

// HTTP応答と差し替えコールバックの両方で検証し、呼び出し元と参照を共有しないデータを返す。
export function readRevisionProposal(
  value: unknown,
  request: RevisionRequest,
): RevisionProposal | null {
  const checked = ReviseTripResponseSchema.safeParse(value)
  if (!checked.success || checked.data.status !== 'proposed') return null
  const { revisions, comparisons } = checked.data
  const { trip, targetStopId } = request
  const index = trip.stops.findIndex((stop) => stop.id === targetStopId)
  const target = trip.stops[index]
  const modes = travelModesSchema.safeParse(request.travelModes)
  if (
    !target ||
    revisions.length > 3 ||
    !modes.success ||
    !revisions.every((revision) => matchesRevisionTarget(revision, trip, target))
  )
    return null
  // サーバーは依頼の理由と文脈をそのままRevisionへ写す。別の依頼の応答を取り違えていないか確かめる。
  const reason = TextSchema.safeParse(request.reason)
  const context = RevisionContextSchema.safeParse(request.context)
  if (
    !reason.success ||
    !context.success ||
    !revisions.every(
      (revision) =>
        revision.reason === reason.data &&
        // 共通スキーマを通した値どうしを比べ、キーの順序の違いで不一致にしない。
        JSON.stringify(revision.context) === JSON.stringify(context.data),
    )
  )
    return null

  const requestedModes = modes.data ?? ['walk']
  const matchesMode = (slot: TravelSegmentSlot) => {
    if (slot.presence === 'none') return true
    const { mode } = slot.segment
    // 未対応の公共交通は、区間に数値を持たない旨の表示にだけ使える。
    return mode === 'transit' || requestedModes.includes(mode)
  }

  const previous = trip.stops[index - 1]
  const next = trip.stops[index + 1]
  const comparisonsMatch = comparisons?.every(({ before, after }) =>
    [before, after].every(({ fromPrevious, toNext }) => {
      const fromMatches = previous
        ? fromPrevious.presence === 'segment' &&
          fromPrevious.segment.fromStopId === previous.id &&
          fromPrevious.segment.toStopId === targetStopId
        : fromPrevious.presence === 'none' && fromPrevious.reason === 'first_stop'
      const toMatches = next
        ? toNext.presence === 'segment' &&
          toNext.segment.fromStopId === targetStopId &&
          toNext.segment.toStopId === next.id
        : toNext.presence === 'none' && toNext.reason === 'last_stop'
      return fromMatches && toMatches && matchesMode(fromPrevious) && matchesMode(toNext)
    }),
  )
  if (comparisonsMatch === false) return null

  // 応答の申告を引き上げず、裏付けのない satisfied だけを承認不可にする。
  return {
    ...checked.data,
    revisions: revisions.map((revision) => {
      if (revision.constraintCheck.status !== 'satisfied') return revision
      const comparison = comparisons?.find(({ revisionId }) => revisionId === revision.id)
      const check = checkCandidate(revision.diff.after, previous, next, comparison, {
        original: target,
        context: context.data,
      })
      return check.status === 'satisfied'
        ? revision
        : { ...revision, constraintCheck: check, impactSummary: 'この予定だけが変更対象です。' }
    }),
  }
}

export function confirmedTrip(
  base: Trip,
  revision: Revision,
  result: Trip,
  receipt?: ApplyRevisionResult,
): Trip | null {
  const checked = TripSchema.safeParse(result)
  if (!checked.success) return null
  const trip = checked.data
  const index = base.stops.findIndex((stop) => stop.id === revision.targetStopId)
  const target = base.stops[index]
  const applied = trip.stops[index]
  if (
    !target ||
    trip.id !== base.id ||
    trip.version <= base.version ||
    (revision.context.phase === 'on_site' && revision.context.report.kind === 'simulated') ||
    revision.constraintCheck.status !== 'satisfied' ||
    !matchesRevisionTarget(revision, base, target)
  )
    return null

  const withoutEvidence = (stop: Stop) => ({ ...stop, evidence: [] })
  let recheckUnavailable = false
  if (receipt !== undefined) {
    const parsed = ApplyRevisionResponseSchema.safeParse(receipt)
    if (!parsed.success) return null
    const record = parsed.data.revision
    if (
      parsed.data.appliedTripVersion !== base.version + 1 ||
      !sameTrip(parsed.data.trip, trip) ||
      record.id !== revision.id ||
      record.tripId !== revision.tripId ||
      record.baseTripVersion !== revision.baseTripVersion ||
      record.targetStopId !== revision.targetStopId ||
      record.reason !== revision.reason ||
      JSON.stringify(record.context) !== JSON.stringify(revision.context) ||
      !sameStop(withoutEvidence(record.diff.before), withoutEvidence(revision.diff.before)) ||
      !sameStop(withoutEvidence(record.diff.after), withoutEvidence(revision.diff.after))
    )
      return null
    recheckUnavailable =
      parsed.data.status === 'already_applied' && parsed.data.verification === 'not_available'
    // 適用版の確定を確認できた。さらに後の旅程には、古い画面の根拠を移さない。
    if (trip.version > parsed.data.appliedTripVersion) return recheckUnavailable ? trip : null
  }
  if (!applied || trip.version !== base.version + 1) return null

  // 再照合で根拠は更新され得る。承認した予定の内容と、対象外の旅程は一致する必要がある。
  const expected = { ...revision.diff.after, evidence: applied.evidence }
  if (
    (!recheckUnavailable && applied.evidence.length === 0) ||
    !sameStop(applied, expected) ||
    (receipt === undefined && !retainsApprovedEvidence(revision.diff.after, applied))
  )
    return null
  // 保存DTOでは照合データを持たない。対象外の予定は中身を照合した後、表示中の根拠を引き継ぐ。
  const stops = trip.stops.map((stop, position) =>
    position !== index && stop.evidence.length === 0 && base.stops[position]
      ? { ...stop, evidence: structuredClone(base.stops[position].evidence) }
      : stop,
  )
  const withoutChange = {
    ...trip,
    version: base.version,
    stops: stops.with(index, target),
  }
  return sameTrip(withoutChange, base) ? { ...trip, stops } : null
}

export function readRevisionApplyResponse(
  value: unknown,
  request: RevisionRequest,
  revision: Revision,
): Awaited<ReturnType<ApplyRevision>> {
  const result = ApplyRevisionResponseSchema.safeParse(value)
  if (!result.success || !confirmedTrip(request.trip, revision, result.data.trip, result.data)) {
    return { status: 'uncertain' }
  }
  return { status: 'applied', trip: result.data.trip, receipt: result.data }
}
