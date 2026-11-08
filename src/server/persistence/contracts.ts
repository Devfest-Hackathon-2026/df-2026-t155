import { z } from 'zod'

import {
  ApprovedLearningSchema,
  LearningSchema,
  RevisionSchema,
  StopSchema,
  TripSchema,
} from '@/domain'
import { IdSchema, TextSchema } from '@/domain/primitives'
import { MAX_LEARNING_CONTENT_LENGTH } from '@/lib/learnings/lifecycle'

export const RecordIdSchema = IdSchema.max(256).refine((id) => id.isWellFormed())
export const VersionSchema = z.int().nonnegative()

// URLのドットセグメントはエンコードしても正規化される。
const PathIdSchema = RecordIdSchema.refine((id) => id !== '.' && id !== '..')
const tripRouteNames = new Set(['generate', 'verify', 'revise'])
const TripIdSchema = PathIdSchema.refine((id) => !tripRouteNames.has(id))
export const LearningIdSchema = PathIdSchema.refine((id) => id !== 'candidates')

const RegionSchema = TextSchema.max(120)
const PreferencesSchema = z.array(TextSchema.max(200)).max(16)
const WriteStopSchema = StopSchema.safeExtend({
  id: RecordIdSchema,
  name: TextSchema.max(200),
  placeId: IdSchema.max(1024).nullable(),
  evidence: StopSchema.shape.evidence.max(16),
})

// 書き込みの上限は既存文書の読み取りには適用しない。
export const CreateTripBodySchema = TripSchema.safeExtend({
  id: TripIdSchema,
  version: z.literal(0),
  region: RegionSchema,
  preferences: PreferencesSchema,
  stops: z.array(WriteStopSchema).min(3).max(4),
  learningApplications: TripSchema.shape.learningApplications.max(0),
})

export const UpdateTripBodySchema = z.strictObject({
  expectedVersion: VersionSchema,
  preferences: PreferencesSchema,
})

export const PendingRevisionSchema = RevisionSchema.safeExtend({
  approval: z.strictObject({ status: z.literal('pending') }),
})

export const SaveRevisionBodySchema = PendingRevisionSchema.safeExtend({
  id: PathIdSchema,
  tripId: RecordIdSchema,
  targetStopId: RecordIdSchema,
  reason: TextSchema.max(1000),
  context: PendingRevisionSchema.shape.context.refine(
    (context) => context.phase === 'planning' || context.report.description.length <= 1000,
  ),
  diff: z.strictObject({ before: WriteStopSchema, after: WriteStopSchema }),
})

export const ApproveLearningBodySchema = z.strictObject({
  expectedVersion: VersionSchema,
  sourceTripId: RecordIdSchema,
  category: LearningSchema.shape.category,
  content: TextSchema.max(MAX_LEARNING_CONTENT_LENGTH),
  scope: LearningSchema.shape.scope.refine(
    (scope) => scope.kind === 'all_trips' || RegionSchema.safeParse(scope.region).success,
  ),
})

export const VersionedLearningSchema = z.strictObject({
  version: VersionSchema.positive(),
  learning: ApprovedLearningSchema,
})

// 利用者が画面で選んだ学び。画面に表示した版を添え、サーバーが保存済みの現行版と
// 一致するときだけ採用する。本文や承認状態は運ばない。
export const LearningSelectionSchema = z.strictObject({
  id: LearningIdSchema,
  version: VersionSchema.positive(),
})

export const TripResponseSchema = z.strictObject({ trip: TripSchema })
const ListInfoSchema = z.strictObject({
  returned: z.int().nonnegative(),
  skippedInvalid: z.int().nonnegative(),
  truncated: z.boolean(),
})

export const TripListResponseSchema = z.strictObject({
  trips: z.array(TripSchema),
  listInfo: ListInfoSchema,
})
export const RevisionResponseSchema = z.strictObject({ revision: PendingRevisionSchema })
export const RevisionListResponseSchema = z.strictObject({
  revisions: z.array(PendingRevisionSchema),
  listInfo: ListInfoSchema,
})
export const LearningListResponseSchema = z.strictObject({
  learnings: z.array(VersionedLearningSchema),
  listInfo: ListInfoSchema,
})

export type ApproveLearningBody = z.infer<typeof ApproveLearningBodySchema>
export type PendingRevision = z.infer<typeof PendingRevisionSchema>
export type VersionedLearning = z.infer<typeof VersionedLearningSchema>
export type LearningSelection = z.infer<typeof LearningSelectionSchema>
