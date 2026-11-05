import { z } from 'zod'

import { ApprovedLearningSchema, StopSchema, TripSchema } from './models'
import { DateSchema, IdSchema, TextSchema, TimeZoneSchema } from './primitives'
import { RevisionContextSchema, RevisionSchema } from './revision'

// HTTPステータスやURLとは独立した共有ペイロード。外部サービスの生データは含めない。
export const ProposalFailureSchema = z.strictObject({
  status: z.enum(['no_candidates', 'insufficient_information', 'external_service_error']),
  message: TextSchema,
})

export const GenerateTripRequestSchema = z
  .strictObject({
    date: DateSchema,
    region: TextSchema,
    timeZone: TimeZoneSchema,
    preferences: z.array(TextSchema),
    fixedStops: z.array(StopSchema.safeExtend({ isFixed: z.literal(true) })).max(4),
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
  z.strictObject({ status: z.literal('proposed'), trip: TripSchema }),
  ProposalFailureSchema,
])

export const ReviseTripRequestSchema = z
  .strictObject({
    trip: TripSchema,
    targetStopId: IdSchema,
    reason: TextSchema,
    context: RevisionContextSchema,
  })
  .superRefine((request, ctx) => {
    const target = request.trip.stops.find((stop) => stop.id === request.targetStopId)
    if (!target || target.isFixed) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetStopId'],
        message: '存在する、固定されていないStopを指定してください',
      })
    }
  })

export const ReviseTripResponseSchema = z.union([
  z
    .strictObject({ status: z.literal('proposed'), revisions: z.array(RevisionSchema).min(1) })
    .superRefine((response, ctx) => {
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
