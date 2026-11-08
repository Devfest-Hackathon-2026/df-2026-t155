import { z } from 'zod'

import {
  KnownTravelModeSchema,
  ProposalFailureSchema,
  RevisionContextSchema,
  ReviseTripRequestSchema,
  ReviseTripResponseSchema,
  StopSchema,
  TravelSegmentSchema,
  TripSchema,
  type KnownTravelSegment,
  type ReviseTripRequest,
  type ReviseTripResponse,
  type Revision,
  type Stop,
  type Trip,
} from '@/domain'
import { IdSchema, TextSchema } from '@/domain/primitives'
import { getProtectedApiHeaders } from '@/lib/auth/protected-api'
import {
  classifyProtectedHeaderError,
  classifyProtectedStatus,
  PROTECTED_FAILURE_MESSAGES,
} from '@/lib/auth/protected-api-errors'

import { checkCandidate, retainsApprovedEvidence } from './proposal-checks'

export type RevisionRequest = ReviseTripRequest & { travelModes?: KnownTravelSegment['mode'][] }

const travelModesSchema = z.array(KnownTravelModeSchema).min(1).max(2).optional()
// 比較の外枠のみ。区間の検証は共通契約を使う。
const slotSchema = z.discriminatedUnion('presence', [
  z.strictObject({ presence: z.literal('none'), reason: z.enum(['first_stop', 'last_stop']) }),
  z.strictObject({ presence: z.literal('segment'), segment: TravelSegmentSchema }),
])
const comparisonSideSchema = z.strictObject({ fromPrevious: slotSchema, toNext: slotSchema })
const comparisonSchema = z.strictObject({
  revisionId: IdSchema,
  before: comparisonSideSchema,
  after: comparisonSideSchema,
})
const proposalEnvelopeSchema = z.strictObject({
  status: z.literal('proposed'),
  revisions: z.array(z.unknown()).max(3),
  comparisons: z.array(comparisonSchema).max(3).optional(),
})

export type TravelComparison = z.infer<typeof comparisonSchema>
export type TravelSlot = z.infer<typeof slotSchema>
export type RevisionProposal = Extract<ReviseTripResponse, { status: 'proposed' }> & {
  comparisons?: TravelComparison[]
}

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
        // 認証・招待・アプリ検証の失敗（401・403）、利用制限（429）、送信できなかった（ヘッダーなし）。
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

// 通信の差し替え口（テスト用）。既定は実際のfetchと、本人のBearer＋App Check。
export interface RevisionRequestDeps {
  fetchFn?: typeof fetch
  getHeaders?: () => Promise<Headers>
}

// 本人の承認操作を受け取る。applied と失敗はサーバーで結果が確定した場合にだけ返す。
export type ApplyRevision = (decision: {
  request: RevisionRequest
  revision: Revision
}) => Promise<
  | { status: 'applied'; trip: Trip }
  | { status: 'conflict' | 'unavailable' | 'failed' | 'uncertain'; message?: string }
>

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

  // ヘッダーを用意できなければ送信しない（課金APIを呼ばない・再試行しない）。
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
    // 認証・利用制限は本文を見ずステータスで判定し、固定の文言を出す。
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
  if (response.status === 200) {
    return readRevisionProposal(body, checkedRequest) ?? { status: 'unexpected' }
  }

  const failure = ProposalFailureSchema.safeParse(body)
  if (failure.success) {
    const expected = failure.data.status === 'external_service_error' ? 502 : 422
    if (response.status === expected) return failure.data
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
  const envelope = proposalEnvelopeSchema.safeParse(value)
  if (!envelope.success) return null
  const { comparisons, ...core } = envelope.data
  const checked = ReviseTripResponseSchema.safeParse(core)
  if (!checked.success || checked.data.status !== 'proposed') return null
  const { revisions } = checked.data
  const { trip, targetStopId } = request
  const index = trip.stops.findIndex((stop) => stop.id === targetStopId)
  const target = trip.stops[index]
  const modes = travelModesSchema.safeParse(request.travelModes)
  if (
    !target ||
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
  const matchesMode = (slot: TravelSlot) => {
    if (slot.presence === 'none') return true
    const { mode } = slot.segment
    // 未対応の公共交通は、区間に数値を持たない旨の表示にだけ使える。
    return mode === 'transit' || requestedModes.includes(mode)
  }

  const previous = trip.stops[index - 1]
  const next = trip.stops[index + 1]
  const ids = new Set(revisions.map((revision) => revision.id))
  const comparisonsMatch =
    !comparisons ||
    (new Set(comparisons.map((comparison) => comparison.revisionId)).size === comparisons.length &&
      comparisons.every(
        ({ revisionId, before, after }) =>
          ids.has(revisionId) &&
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
      ))
  if (!comparisonsMatch) return null

  // 応答の申告を引き上げず、裏付けのない satisfied だけを承認不可にする。
  return {
    ...checked.data,
    ...(comparisons && { comparisons }),
    revisions: revisions.map((revision) => {
      if (revision.constraintCheck.status !== 'satisfied') return revision
      const comparison = comparisons?.find(({ revisionId }) => revisionId === revision.id)
      const check = checkCandidate(revision.diff.after, previous, next, comparison)
      return check.status === 'satisfied'
        ? revision
        : { ...revision, constraintCheck: check, impactSummary: 'この予定だけが変更対象です。' }
    }),
  }
}

export function confirmedTrip(base: Trip, revision: Revision, result: Trip): Trip | null {
  const checked = TripSchema.safeParse(result)
  if (!checked.success) return null
  const trip = checked.data
  const index = base.stops.findIndex((stop) => stop.id === revision.targetStopId)
  const target = base.stops[index]
  const applied = trip.stops[index]
  if (
    !target ||
    !applied ||
    trip.version <= base.version ||
    revision.constraintCheck.status !== 'satisfied' ||
    !matchesRevisionTarget(revision, base, target)
  )
    return null

  // 再照合で根拠は更新され得る。承認した予定の内容と、対象外の旅程は一致する必要がある。
  const expected = { ...revision.diff.after, evidence: applied.evidence }
  if (!sameStop(applied, expected) || !retainsApprovedEvidence(revision.diff.after, applied))
    return null
  const withoutChange = {
    ...trip,
    version: base.version,
    stops: trip.stops.map((stop, position) => (position === index ? target : stop)),
  }
  return sameTrip(withoutChange, base) ? trip : null
}
