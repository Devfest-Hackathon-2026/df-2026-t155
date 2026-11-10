import { z } from 'zod'

import { ApprovedLearningSchema, StopSchema, TripSchema } from './models'
import { LearningSaveProofSchema } from './learning-trip-protocol'
import {
  TripPreferencesSchema,
  TripRecordIdSchema,
  TripRegionSchema,
  TripStopNameSchema,
} from './trip-write-limits'
import { DateSchema, IdSchema, TextSchema, TimeZoneSchema } from './primitives'
import {
  matchesRevisionReportTarget,
  RevisionContextSchema,
  RevisionReasonSchema,
  RevisionSchema,
} from './revision'
import { TravelSegmentSchema } from './travel'

// HTTPステータスやURLとは独立した共有ペイロード。外部サービスの生データは含めない。
export const ProposalFailureSchema = z.strictObject({
  status: z.enum(['no_candidates', 'insufficient_information', 'external_service_error']),
  message: TextSchema,
})

export const GenerateTripRequestSchema = z
  .strictObject({
    date: DateSchema,
    region: TripRegionSchema,
    timeZone: TimeZoneSchema,
    preferences: TripPreferencesSchema,
    fixedStops: z
      .array(
        StopSchema.safeExtend({
          id: TripRecordIdSchema,
          name: TripStopNameSchema,
          isFixed: z.literal(true),
        }),
      )
      .max(4),
    learnings: z.array(ApprovedLearningSchema),
  })
  .superRefine((request, ctx) => {
    if (new Set(request.fixedStops.map((stop) => stop.id)).size !== request.fixedStops.length) {
      ctx.addIssue({ code: 'custom', path: ['fixedStops'], message: '固定Stop IDが重複しています' })
    }
    if (
      new Set(request.learnings.map((learning) => learning.id)).size !== request.learnings.length
    ) {
      ctx.addIssue({ code: 'custom', path: ['learnings'], message: 'Learning IDが重複しています' })
    }
    request.learnings.forEach((learning, index) => {
      if (learning.scope.kind === 'region' && learning.scope.region !== request.region) {
        ctx.addIssue({
          code: 'custom',
          path: ['learnings', index, 'scope'],
          message: '学びの適用地域が一致しません',
        })
      }
    })
  })

export const GenerateTripResponseSchema = z.union([
  z.strictObject({
    status: z.literal('proposed'),
    trip: TripSchema,
    learningSaveProof: LearningSaveProofSchema.optional(),
    learningSaveUnavailable: z.enum(['disabled', 'signing_unavailable']).optional(),
  }),
  ProposalFailureSchema,
])

export const ReviseTripRequestSchema = z
  .strictObject({
    trip: TripSchema,
    targetStopId: IdSchema,
    reason: RevisionReasonSchema,
    context: RevisionContextSchema,
    // 移動が間に合うかを確認する、利用者が使える移動手段。省略時は徒歩だけ（車を使えるとは限らないため）。
    // 車は、利用者が使えると明示したときだけ、確認の対象にする。公共交通は、現段階では未対応。
    travelModes: z
      .array(z.enum(['walk', 'drive']))
      .min(1)
      .max(2)
      .optional(),
  })
  .superRefine((request, ctx) => {
    const target = request.trip.stops.find((stop) => stop.id === request.targetStopId)
    if (!matchesRevisionReportTarget(request.context, request.targetStopId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'report', 'targetStopId'],
        message: '報告対象を修正対象と一致させてください',
      })
    }
    if (!target || target.isFixed) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetStopId'],
        message: '存在する、固定されていないStopを指定してください',
      })
    }
  })

// 変更前後の移動区間の比較（候補ごとの、一時的な比較データ。保存しない）。
// 「区間が存在しない」（最初・最後の予定）と、「区間はあるが、経路を確認できなかった」（TravelSegmentのunknown）を区別する。
// 値は構造化された結果（TravelSegment）で、説明文から取り出さない。承認の根拠として、クライアントから戻された値を信用しない。
export const TravelSegmentSlotSchema = z.discriminatedUnion('presence', [
  z.strictObject({ presence: z.literal('none'), reason: z.enum(['first_stop', 'last_stop']) }),
  z.strictObject({ presence: z.literal('segment'), segment: TravelSegmentSchema }),
])

export const TravelComparisonSideSchema = z.strictObject({
  // 前の予定 → 対象の予定
  fromPrevious: TravelSegmentSlotSchema,
  // 対象の予定 → 次の予定
  toNext: TravelSegmentSlotSchema,
})

export const RevisionRouteEndpointsSchema = z.strictObject({
  previousPlaceId: IdSchema.max(1024).nullable(),
  nextPlaceId: IdSchema.max(1024).nullable(),
})
export type RevisionRouteEndpoints = z.infer<typeof RevisionRouteEndpointsSchema>

export const TravelComparisonSchema = z.strictObject({
  // 対応するRevisionのid（tripId・baseTripVersion・targetStopIdは、そのRevisionが持つ）。
  revisionId: IdSchema,
  // 生成時に照合した元施設。nullは未同定、省略は旧応答で照合結果不明。
  originalPlaceId: IdSchema.nullable().optional(),
  routeEndpoints: RevisionRouteEndpointsSchema.optional(),
  // 経路を照会する前に、端点の施設検索が失敗した側。
  failedPlaceLookups: z
    .array(z.enum(['previous', 'next']))
    .min(1)
    .max(2)
    .optional(),
  before: TravelComparisonSideSchema,
  after: TravelComparisonSideSchema,
})

export const RevisionProposalTokenSchema = z
  .string()
  .max(12_000)
  .regex(/^v2\.[0-9]{13}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)

export const ReviseTripResponseSchema = z.union([
  z
    .strictObject({
      status: z.literal('proposed'),
      revisions: z.array(RevisionSchema).min(1),
      // 任意。移動区間の比較は、Revisionごとに高々1件。
      comparisons: z.array(TravelComparisonSchema).optional(),
      proposalTokens: z.record(IdSchema, RevisionProposalTokenSchema).optional(),
    })
    .superRefine((response, ctx) => {
      const byRevision = new Map(response.revisions.map((revision) => [revision.id, revision]))
      if (Object.keys(response.proposalTokens ?? {}).some((id) => !byRevision.has(id))) {
        ctx.addIssue({ code: 'custom', path: ['proposalTokens'], message: '候補IDが一致しません' })
      }
      const seen = new Set<string>()
      response.comparisons?.forEach((comparison, index) => {
        const revision = byRevision.get(comparison.revisionId)
        const path = ['comparisons', index]
        if (!revision || seen.has(comparison.revisionId)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: '比較は、存在するRevisionに対して、1件ずつにしてください',
          })
          return
        }
        seen.add(comparison.revisionId)
        for (const slot of ['fromPrevious', 'toNext'] as const) {
          const before = comparison.before[slot]
          const after = comparison.after[slot]
          // 区間が存在するかは、旅程内の位置で決まるため、変更前後で一致する。
          if (before.presence !== after.presence) {
            ctx.addIssue({ code: 'custom', path, message: '変更前後で、区間の有無が一致しません' })
            continue
          }
          if (before.presence !== 'segment' || after.presence !== 'segment') continue
          const b = before.segment
          const a = after.segment
          const targetOk =
            slot === 'fromPrevious'
              ? b.toStopId === revision.targetStopId && a.toStopId === revision.targetStopId
              : b.fromStopId === revision.targetStopId && a.fromStopId === revision.targetStopId
          const neighborOk =
            slot === 'fromPrevious' ? b.fromStopId === a.fromStopId : b.toStopId === a.toStopId
          if (!targetOk || !neighborOk) {
            ctx.addIssue({
              code: 'custom',
              path,
              message: '区間の端点が、Revisionの対象Stopと前後のStopに一致しません',
            })
          }
        }
      })
      const first = response.revisions[0]
      const ids = new Set<string>()
      response.revisions.forEach((revision, index) => {
        if (
          revision.approval.status !== 'pending' ||
          revision.tripId !== first.tripId ||
          revision.baseTripVersion !== first.baseTripVersion ||
          revision.targetStopId !== first.targetStopId ||
          ids.has(revision.id)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['revisions', index],
            message: '候補は同一旅程・版・対象への未承認の修正とし、IDを一意にしてください',
          })
        }
        ids.add(revision.id)
      })
    }),
  ProposalFailureSchema,
])

export type ProposalFailure = z.infer<typeof ProposalFailureSchema>
export type GenerateTripRequest = z.infer<typeof GenerateTripRequestSchema>
export type GenerateTripResponse = z.infer<typeof GenerateTripResponseSchema>
export type ReviseTripRequest = z.infer<typeof ReviseTripRequestSchema>
export type ReviseTripResponse = z.infer<typeof ReviseTripResponseSchema>
export type TravelSegmentSlot = z.infer<typeof TravelSegmentSlotSchema>
export type TravelComparison = z.infer<typeof TravelComparisonSchema>
