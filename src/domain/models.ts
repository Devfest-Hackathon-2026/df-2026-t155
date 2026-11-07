import { z } from 'zod'

import {
  ApprovalSchema,
  DateSchema,
  IdSchema,
  LocalTimeSchema,
  TextSchema,
  TimestampSchema,
  TimeZoneSchema,
} from './primitives'

export const EvidenceStatusSchema = z.enum(['consistent', 'conflicting', 'unverifiable'])
export const evidenceStatusLabels = {
  consistent: '情報源と整合',
  conflicting: '矛盾あり',
  unverifiable: '確認できない',
} satisfies Record<z.infer<typeof EvidenceStatusSchema>, string>

// Geminiの提案文は出典にしない。模擬報告も実データと区別する。
export const EvidenceSchema = z.strictObject({
  id: IdSchema,
  subject: z.enum(['place_identity', 'opening_hours', 'travel_time', 'other']),
  claim: TextSchema,
  applicability: TextSchema,
  source: z.strictObject({
    kind: z.enum(['places', 'routes', 'official', 'user_report', 'simulation']),
    label: TextSchema,
    url: z.url({ protocol: /^https?$/ }).optional(),
  }),
  checkedAt: TimestampSchema,
  status: EvidenceStatusSchema,
  explanation: TextSchema,
})

// 予定の種類。固定・予約・購入の状態（isFixed等）とは別の軸で、種類を表すだけ。
// 任意：未指定は「予定」として扱い、観光だと推測しない。`transport`は、移動そのものではなく、
// 旅程上の独立した予定（乗車・乗換など）だけに使う。Stop間の移動は`TravelSegment`が表す。
export const StopKindSchema = z.enum(['sight', 'meal', 'transport', 'other'])
export const stopKindLabels = {
  sight: '観光',
  meal: '食事',
  transport: '乗車・乗換',
  other: 'その他',
} satisfies Record<z.infer<typeof StopKindSchema>, string>

export const StopSchema = z
  .strictObject({
    id: IdSchema,
    name: TextSchema,
    kind: StopKindSchema.optional(),
    // 未同定を許容し、架空のPlace IDで補完しない。
    placeId: IdSchema.nullable(),
    plannedStartTime: LocalTimeSchema,
    durationMinutes: z.int().positive().max(1440),
    isFixed: z.boolean(),
    evidence: z.array(EvidenceSchema),
  })
  .refine(
    (stop) => {
      const [hours, minutes] = stop.plannedStartTime.split(':').map(Number)
      return hours * 60 + minutes + stop.durationMinutes <= 1440
    },
    { path: ['durationMinutes'], message: '滞在は旅程当日内に収めてください' },
  )

export const LearningSchema = z.strictObject({
  id: IdSchema,
  sourceTripId: IdSchema,
  category: z.enum(['verification', 'preference']),
  content: TextSchema,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all_trips') }),
    z.strictObject({ kind: z.literal('region'), region: TextSchema }),
  ]),
  approval: ApprovalSchema,
})

export const ApprovedLearningSchema = LearningSchema.extend({
  approval: z.strictObject({ status: z.literal('approved'), decidedAt: TimestampSchema }),
})

export const LearningApplicationSchema = z.strictObject({
  learningId: IdSchema,
  targetStopIds: z.array(IdSchema).min(1),
  explanation: TextSchema,
})

export const TripSchema = z
  .strictObject({
    id: IdSchema,
    version: z.int().nonnegative(),
    date: DateSchema,
    region: TextSchema,
    timeZone: TimeZoneSchema,
    preferences: z.array(TextSchema),
    stops: z.array(StopSchema).min(3).max(4),
    learningApplications: z.array(LearningApplicationSchema),
  })
  .superRefine((trip, ctx) => {
    const stopIds = new Set(trip.stops.map((stop) => stop.id))
    if (stopIds.size !== trip.stops.length) {
      ctx.addIssue({ code: 'custom', path: ['stops'], message: 'Stop IDが重複しています' })
    }
    const learningIds = new Set<string>()
    trip.learningApplications.forEach((application, index) => {
      if (
        learningIds.has(application.learningId) ||
        new Set(application.targetStopIds).size !== application.targetStopIds.length ||
        application.targetStopIds.some((id) => !stopIds.has(id))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['learningApplications', index],
          message: '学びの適用先が存在しないか、IDが重複しています',
        })
      }
      learningIds.add(application.learningId)
    })
  })

export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>
export type Evidence = z.infer<typeof EvidenceSchema>
export type Stop = z.infer<typeof StopSchema>
export type Learning = z.infer<typeof LearningSchema>
export type ApprovedLearning = z.infer<typeof ApprovedLearningSchema>
export type LearningApplication = z.infer<typeof LearningApplicationSchema>
export type Trip = z.infer<typeof TripSchema>
