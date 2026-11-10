import 'server-only'

import type { DocumentSnapshot } from 'firebase-admin/firestore'
import { z } from 'zod'

import {
  ApprovedLearningSchema,
  ApprovalSchema,
  EvidenceSchema,
  LearningApplicationSchema,
  StopSchema,
  TripSchema,
  type Stop,
  type Trip,
} from '@/domain'
import { MANUAL_UNVERIFIED } from '@/domain/manual-revision'
import type { Actor } from '@/lib/auth/server'

import {
  ApproveLearningBodySchema,
  PendingRevisionSchema,
  ManualRevisionSchema,
  RecordIdSchema,
  RevisionTravelModesSchema,
  RevisionProofContextSchema,
  RevisionReportStatesSchema,
  SavedAutomaticRevisionSchema,
  VersionedLearningSchema,
  type PendingRevision,
  type VersionedLearning,
} from './contracts'
import { parseInput, parseStored, PersistenceError } from './errors'
import { documentKey } from './paths'
import { isRevisionEvidenceConflict } from '@/domain/revision-evidence'

// 照合結果がドメインに追加されても、保存対象はここで許可した項目だけにする。
const StopFieldsDtoSchema = z.strictObject(StopSchema.shape).pick({
  id: true,
  kind: true,
  placeId: true,
  plannedStartTime: true,
  durationMinutes: true,
  isFixed: true,
  manualRevisionId: true,
})
const PlanStopDtoSchema = StopFieldsDtoSchema.extend({ planName: StopSchema.shape.name })
const StopDtoSchema = z.union([
  PlanStopDtoSchema,
  // 先行版で作られた文書も読み出せるようにする。失われた元の名称は復元できない。
  StopFieldsDtoSchema.extend({ name: StopSchema.shape.name })
    .refine(({ placeId, name }) => placeId === null || name === '場所（再確認が必要）')
    .transform(({ name, ...stop }) => ({ ...stop, planName: name })),
])
const LearningApplicationDtoSchema = LearningApplicationSchema.pick({
  learningId: true,
  learningVersion: true,
  targetStopIds: true,
  explanation: true,
})
const TripDtoSchema = z.strictObject({
  id: RecordIdSchema,
  version: TripSchema.shape.version,
  date: TripSchema.shape.date,
  region: TripSchema.shape.region,
  timeZone: TripSchema.shape.timeZone,
  preferences: TripSchema.shape.preferences,
  stops: z.array(StopDtoSchema).min(3).max(4),
  learningApplications: z.array(LearningApplicationDtoSchema),
})
const ReportConflictSchema = EvidenceSchema.safeExtend({
  status: z.literal('conflicting'),
  source: z.strictObject({
    kind: z.literal('user_report'),
    label: EvidenceSchema.shape.source.shape.label,
  }),
})
const ReportConflictsSchema = z.strictObject({
  before: z.array(ReportConflictSchema).max(16),
  after: z.array(ReportConflictSchema).max(16),
})
const RevisionDtoSchema = z.strictObject({
  id: RecordIdSchema,
  tripId: RecordIdSchema,
  baseTripVersion: PendingRevisionSchema.shape.baseTripVersion,
  targetStopId: PendingRevisionSchema.shape.targetStopId,
  reason: PendingRevisionSchema.shape.reason,
  context: PendingRevisionSchema.shape.context,
  diff: z.strictObject({ before: StopDtoSchema, after: StopDtoSchema }),
  approval: ApprovalSchema,
  travelModes: RevisionTravelModesSchema.optional(),
  reportConflicts: ReportConflictsSchema.optional(),
  proposalExpiresAt: z.int().positive().optional(),
  proposalContext: RevisionProofContextSchema.optional(),
})

const OwnedFieldsSchema = z.strictObject({
  ownerUid: z.string().min(1).max(128),
})

const ManualApplyEpochSchema = z.int().nonnegative()

export function manualApplyEpoch(snapshot: DocumentSnapshot) {
  return parseStored(ManualApplyEpochSchema, snapshot.get('manualApplyEpoch') ?? 0)
}

const TripDocumentSchema = OwnedFieldsSchema.extend({
  trip: TripDtoSchema,
  revisionReports: RevisionReportStatesSchema.optional(),
  manualApplyEpoch: ManualApplyEpochSchema.optional(),
})
const RevisionDocumentSchema = OwnedFieldsSchema.extend({ revision: RevisionDtoSchema })
const ManualRevisionDocumentSchema = OwnedFieldsSchema.extend({
  revision: RevisionDtoSchema.pick({
    id: true,
    tripId: true,
    baseTripVersion: true,
    targetStopId: true,
    reason: true,
    context: true,
    diff: true,
  }).extend({
    method: ManualRevisionSchema.shape.method,
    confirmation: ManualRevisionSchema.shape.confirmation,
    approval: ManualRevisionSchema.shape.approval,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
})
const LearningDocumentSchema = z.discriminatedUnion('state', [
  OwnedFieldsSchema.extend({
    state: z.literal('approved'),
    version: VersionedLearningSchema.shape.version,
    learning: z.strictObject({
      id: RecordIdSchema,
      sourceTripId: RecordIdSchema,
      category: ApprovedLearningSchema.shape.category,
      content: ApproveLearningBodySchema.shape.content,
      scope: ApprovedLearningSchema.shape.scope,
      approval: ApprovedLearningSchema.shape.approval,
    }),
  }),
  OwnedFieldsSchema.extend({
    state: z.literal('revoked'),
    id: RecordIdSchema,
  }),
])

const UNCHECKED_REVISION = {
  impactSummary: '保存した候補です。現在の影響は再確認が必要です。',
  constraintCheck: { status: 'not_checked', explanation: '制約は再確認が必要です。' },
} as const

// Stop.nameは本人入力・AI提案の予定名。PlaceCandidate.nameは照合処理内で別に扱う。
// Place IDは再照会用の参照であり、evidenceやPlace IDから予定名の出所を推定しない。
export function toStopDto(stop: Stop): z.infer<typeof PlanStopDtoSchema> {
  return PlanStopDtoSchema.parse({
    id: stop.id,
    planName: stop.name,
    ...(stop.kind === undefined ? {} : { kind: stop.kind }),
    placeId: stop.placeId,
    plannedStartTime: stop.plannedStartTime,
    durationMinutes: stop.durationMinutes,
    isFixed: stop.isFixed,
    ...(stop.manualRevisionId === undefined ? {} : { manualRevisionId: stop.manualRevisionId }),
  })
}

function restoreStop({ planName, ...stop }: z.infer<typeof StopDtoSchema>): Stop {
  return { ...stop, name: planName, evidence: [] }
}

export function toTripDocument(actor: Actor, input: Trip) {
  const trip = parseInput(TripSchema, input)
  return parseInput(TripDocumentSchema, {
    ownerUid: actor.uid,
    trip: {
      id: trip.id,
      version: trip.version,
      date: trip.date,
      region: trip.region,
      timeZone: trip.timeZone,
      preferences: trip.preferences,
      stops: trip.stops.map(toStopDto),
      learningApplications: trip.learningApplications.map(
        ({ learningId, learningVersion, targetStopIds, explanation }) => ({
          learningId,
          ...(learningVersion === undefined ? {} : { learningVersion }),
          targetStopIds,
          explanation,
        }),
      ),
    },
  })
}

export function fromTripDocument(data: unknown, id: string): Trip {
  const { trip } = parseStored(TripDocumentSchema, data)
  if (documentKey(trip.id) !== id) throw new PersistenceError('invalid_stored_data')
  return parseStored(TripSchema, { ...trip, stops: trip.stops.map(restoreStop) })
}

export function toRevisionDocument(
  actor: Actor,
  input: PendingRevision,
  travelModes?: z.infer<typeof RevisionTravelModesSchema>,
) {
  const revision = parseInput(PendingRevisionSchema, input)
  const conflicts = (stop: Stop, scope: 'original' | 'candidate') =>
    stop.evidence
      .filter(
        (item) => item.source.kind === 'user_report' && isRevisionEvidenceConflict(item, scope),
      )
      .map((item) => ({
        ...item,
        source: { kind: 'user_report' as const, label: item.source.label },
      }))
  const before = conflicts(revision.diff.before, 'original')
  const after = conflicts(revision.diff.after, 'candidate')
  return parseInput(RevisionDocumentSchema, {
    ownerUid: actor.uid,
    revision: {
      id: revision.id,
      tripId: revision.tripId,
      baseTripVersion: revision.baseTripVersion,
      targetStopId: revision.targetStopId,
      reason: revision.reason,
      context: revision.context,
      diff: { before: toStopDto(revision.diff.before), after: toStopDto(revision.diff.after) },
      approval: revision.approval,
      ...(travelModes === undefined ? {} : { travelModes }),
      ...(before.length || after.length ? { reportConflicts: { before, after } } : {}),
    },
  })
}

export function readRevisionDocument(data: unknown, tripId: string, id: string) {
  const {
    revision: { travelModes, reportConflicts, proposalExpiresAt, proposalContext, ...revision },
  } = parseStored(RevisionDocumentSchema, data)
  if (documentKey(revision.id) !== id || revision.tripId !== tripId) {
    throw new PersistenceError('invalid_stored_data')
  }
  return {
    travelModes,
    proposalExpiresAt,
    proposalContext,
    revision: parseStored(SavedAutomaticRevisionSchema, {
      ...revision,
      ...UNCHECKED_REVISION,
      ...(revision.approval.status === 'approved'
        ? { impactSummary: '適用済みの変更です。現在の影響は再確認が必要です。' }
        : {}),
      diff: {
        before: { ...restoreStop(revision.diff.before), evidence: reportConflicts?.before ?? [] },
        after: { ...restoreStop(revision.diff.after), evidence: reportConflicts?.after ?? [] },
      },
    }),
  }
}

export function toManualRevisionDocument(
  actor: Actor,
  input: z.infer<typeof ManualRevisionSchema>,
  requestHash: string,
) {
  const revision = parseStored(ManualRevisionSchema, input)
  return parseStored(ManualRevisionDocumentSchema, {
    ownerUid: actor.uid,
    revision: {
      id: revision.id,
      tripId: revision.tripId,
      baseTripVersion: revision.baseTripVersion,
      targetStopId: revision.targetStopId,
      reason: revision.reason,
      context: revision.context,
      diff: { before: toStopDto(revision.diff.before), after: toStopDto(revision.diff.after) },
      approval: revision.approval,
      method: revision.method,
      confirmation: revision.confirmation,
      requestHash,
    },
  })
}

export function isManualRevisionDocument(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'revision' in data &&
    typeof data.revision === 'object' &&
    data.revision !== null &&
    'method' in data.revision &&
    data.revision.method === 'manual'
  )
}

export function readManualRevisionDocument(data: unknown, tripId: string, id: string) {
  const {
    revision: { requestHash, diff, ...revision },
  } = parseStored(ManualRevisionDocumentSchema, data)
  if (documentKey(revision.id) !== id || revision.tripId !== tripId) {
    throw new PersistenceError('invalid_stored_data')
  }
  return {
    requestHash,
    revision: parseStored(ManualRevisionSchema, {
      ...revision,
      diff: { before: restoreStop(diff.before), after: restoreStop(diff.after) },
      impactSummary: '本人の確認を記録して、1地点を差し替えました。',
      constraintCheck: { status: 'unknown', explanation: MANUAL_UNVERIFIED },
    }),
  }
}

export function fromRevisionDocument(data: unknown, tripId: string, id: string) {
  return isManualRevisionDocument(data)
    ? readManualRevisionDocument(data, tripId, id).revision
    : readRevisionDocument(data, tripId, id).revision
}

export function toLearningDocument(actor: Actor, record: VersionedLearning) {
  const { version, learning } = parseInput(VersionedLearningSchema, record)
  const { id, sourceTripId, category, content, scope, approval } = learning
  return parseInput(LearningDocumentSchema, {
    ownerUid: actor.uid,
    state: 'approved',
    version,
    learning: { id, sourceTripId, category, content, scope, approval },
  })
}

export function toRevokedLearningDocument(actor: Actor, id: string) {
  return parseInput(LearningDocumentSchema, { state: 'revoked', ownerUid: actor.uid, id })
}

export function fromLearningDocument(data: unknown, id: string): VersionedLearning | null {
  const record = parseStored(LearningDocumentSchema, data)
  const storedId = record.state === 'approved' ? record.learning.id : record.id
  if (documentKey(storedId) !== id) throw new PersistenceError('invalid_stored_data')
  return record.state === 'approved'
    ? parseStored(VersionedLearningSchema, { version: record.version, learning: record.learning })
    : null
}
