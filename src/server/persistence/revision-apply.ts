import 'server-only'

import { isDeepStrictEqual } from 'node:util'
import type { DocumentReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore'

import { TripSchema, type RevisionRouteEndpoints, type Stop, type Trip } from '@/domain'
import type { Actor } from '@/lib/auth/server'
import { WriteFenceError, type WriteTransaction } from '@/server/cost-control/write-transaction'
import type { TravelModeSetting } from '@/server/verification/segment'

import {
  ApplyRevisionResponseSchema,
  PathIdSchema,
  VersionSchema,
  type ApplyRevisionResult,
  type PendingRevision,
} from './contracts'
import { diagnosePersistenceFailure } from './diagnostics'
import { fromTripDocument, isManualRevisionDocument, readRevisionDocument, toStopDto } from './dto'
import { parseInput, parseStored, PersistenceError } from './errors'
import { requireLearningTripReader } from './learning-trip-rollout'
import { found, readOwned, recordKey } from './paths'
import { requireUnexpiredProposal } from './revision-provenance'
import { reportState, storedReportStates } from './revision-reports'

// 共通の課金・保存の操作（`CostlyOperation`）から受け取る最小の部分。
// `write` だけが業務書き込みの確定に使え、リース失効後の古い確定を共有制御文書の版条件で止める。
export interface ApplyGuard {
  assertActive(): void
  write: WriteTransaction
}

type Target = ReturnType<typeof readTarget>
export type VerifyRevision = (
  trip: Trip,
  revision: PendingRevision,
  travelModes: readonly TravelModeSetting[],
  endpoints: RevisionRouteEndpoints,
) => Promise<Stop>

function readTarget(
  actor: Actor,
  tripSnapshot: DocumentSnapshot,
  revisionSnapshot: DocumentSnapshot,
) {
  const trip = found(readOwned(actor, tripSnapshot, fromTripDocument))
  const record = found(
    readOwned(actor, revisionSnapshot, (data, key) => {
      if (isManualRevisionDocument(data)) throw new PersistenceError('revision_not_applicable')
      return readRevisionDocument(data, trip.id, key)
    }),
  )
  if (
    record.revision.context.phase === 'on_site' &&
    record.revision.context.report.kind === 'simulated'
  ) {
    throw new PersistenceError('revision_simulated')
  }
  const reports = storedReportStates(tripSnapshot)
  if (!reports && record.proposalContext) throw new PersistenceError('invalid_stored_data')
  return { trip, ...record, report: reportState(reports ?? [], record.revision.targetStopId) }
}

function appliedResult({ trip, revision }: Target, expectedVersion: number) {
  if (revision.approval.status !== 'approved') return null
  if (revision.baseTripVersion !== expectedVersion) throw new PersistenceError('version_conflict')
  const appliedTripVersion = revision.baseTripVersion + 1
  const stop = trip.stops.find(({ id }) => id === revision.targetStopId)
  if (
    trip.version < appliedTripVersion ||
    (trip.version === appliedTripVersion &&
      (!stop || !isDeepStrictEqual(toStopDto(stop), toStopDto(revision.diff.after))))
  ) {
    throw new PersistenceError('invalid_stored_data')
  }
  return parseStored(ApplyRevisionResponseSchema, {
    status: 'already_applied',
    appliedTripVersion,
    trip,
    revision,
    verification: 'not_available',
  })
}

function requireApplicable(
  { trip, revision, travelModes, proposalExpiresAt, proposalContext, report }: Target,
  expectedVersion: number,
) {
  const { approval, ...candidate } = revision
  if (approval.status !== 'pending') throw new PersistenceError('revision_not_pending')
  if (trip.version !== expectedVersion || revision.baseTripVersion !== expectedVersion) {
    throw new PersistenceError('version_conflict')
  }
  const stop = trip.stops.find(({ id }) => id === revision.targetStopId)
  const { before, after } = revision.diff
  if (
    !stop ||
    stop.isFixed ||
    !isDeepStrictEqual(toStopDto(stop), toStopDto(before)) ||
    after.id !== stop.id ||
    after.kind !== stop.kind ||
    after.isFixed !== stop.isFixed ||
    after.plannedStartTime !== stop.plannedStartTime ||
    after.durationMinutes !== stop.durationMinutes
  ) {
    throw new PersistenceError('revision_mismatch')
  }
  if (!travelModes) throw new PersistenceError('revision_travel_modes_missing')
  if (report.blocked) throw new PersistenceError('revision_unverified')
  if (!proposalContext) throw new PersistenceError('revision_provenance_missing')
  requireUnexpiredProposal(proposalExpiresAt)
  if (proposalContext.reportVersion !== report.reportVersion)
    throw new PersistenceError('revision_report_changed')
  return {
    stop,
    travelModes,
    revision: { ...candidate, approval },
    endpoints: proposalContext.routeEndpoints,
  }
}

export async function applyStoredRevision(
  db: Firestore,
  actor: Actor,
  tripRef: DocumentReference,
  revisionId: string,
  expectedVersion: number,
  verify: VerifyRevision,
  guard: ApplyGuard,
  acceptsProtocol = true,
): Promise<ApplyRevisionResult> {
  const ref = tripRef.collection('revisions').doc(recordKey(parseInput(PathIdSchema, revisionId)))
  const version = parseInput(VersionSchema, expectedVersion)
  // 照会の読取は、操作の予約（読取14）に含まれる。期限切れの操作では読取を始めない。
  const readSnapshots = () => {
    guard.assertActive()
    return db.runTransaction((transaction) => transaction.getAll(tripRef, ref), { readOnly: true })
  }
  const [tripSnapshot, revisionSnapshot] = await readSnapshots()
  const initial = readTarget(actor, tripSnapshot, revisionSnapshot)
  requireLearningTripReader(acceptsProtocol, [initial.trip])
  const replay = appliedResult(initial, version)
  if (replay) return replay
  const { revision, travelModes, endpoints } = requireApplicable(initial, version)

  // 有料の照合は1回だけ。確定の取引は再試行されない（`maxAttempts: 1`）。
  guard.assertActive()
  const verified = await verify(initial.trip, revision, travelModes, endpoints)
  guard.assertActive()
  try {
    return await guard.write(async (transaction) => {
      const [currentTripSnapshot, currentRevisionSnapshot] = await transaction.getAll(tripRef, ref)
      const current = readTarget(actor, currentTripSnapshot, currentRevisionSnapshot)
      requireLearningTripReader(acceptsProtocol, [current.trip])
      const replay = appliedResult(current, version)
      if (replay) return replay
      const { stop } = requireApplicable(current, version)
      if (
        !currentTripSnapshot.updateTime ||
        !currentRevisionSnapshot.updateTime ||
        !tripSnapshot.updateTime?.isEqual(currentTripSnapshot.updateTime) ||
        !revisionSnapshot.updateTime?.isEqual(currentRevisionSnapshot.updateTime)
      ) {
        throw new PersistenceError('version_conflict')
      }

      const after = {
        ...stop,
        name: current.revision.diff.after.name,
        placeId: verified.placeId,
        evidence: [],
      }
      delete after.manualRevisionId
      const approval = { status: 'approved' as const, decidedAt: new Date().toISOString() }
      const trip = parseStored(TripSchema, {
        ...current.trip,
        version: version + 1,
        stops: current.trip.stops.map((item) => (item.id === stop.id ? after : item)),
      })
      const result = parseStored(ApplyRevisionResponseSchema, {
        status: 'applied',
        appliedTripVersion: trip.version,
        trip: {
          ...trip,
          stops: trip.stops.map((item) =>
            item.id === stop.id ? { ...item, evidence: verified.evidence } : item,
          ),
        },
        verification: 'fresh',
        revision: {
          ...current.revision,
          approval,
          impactSummary: '適用済みの変更です。現在の影響は再確認が必要です。',
          diff: { ...current.revision.diff, after },
        },
      })

      // 旧形式も含め、対象外のStopの保存表現をそのまま残す。
      const storedStops: unknown = currentTripSnapshot.get('trip.stops')
      if (!Array.isArray(storedStops)) throw new PersistenceError('invalid_stored_data')
      const index = trip.stops.findIndex(({ id }) => id === stop.id)
      transaction.update(tripRef, {
        'trip.version': trip.version,
        'trip.stops': storedStops.map((item: unknown, i) =>
          i === index ? toStopDto(after) : item,
        ),
      })
      transaction.update(ref, {
        'revision.approval': approval,
        'revision.diff.after': toStopDto(after),
      })
      return result
    })
  } catch (error) {
    // 書き込み権の失効（lease_lost）や、確定前の検証の失敗は、書き込まれていないのでそのまま返す。
    // コミットを始めた後の失敗だけが結果不明で、版・承認状態を取得し直して確かめる。
    if (!(error instanceof WriteFenceError) || error.code !== 'write_result_unknown') {
      throw error
    }
    try {
      const [currentTripSnapshot, currentRevisionSnapshot] = await readSnapshots()
      const replay = appliedResult(
        readTarget(actor, currentTripSnapshot, currentRevisionSnapshot),
        version,
      )
      if (replay) return replay
    } catch (readError) {
      diagnosePersistenceFailure(readError)
    }
    // コミットの応答を失った場合、再取得時点のpendingだけでは未確定と断定できない。
    throw new PersistenceError('apply_result_unknown')
  }
}
