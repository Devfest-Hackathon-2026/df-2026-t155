import 'server-only'

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore'

import {
  matchesRevisionReportTarget,
  revisionTargetRestriction,
  TripSchema,
  type Trip,
} from '@/domain'
import {
  MANUAL_UNVERIFIED,
  ManualApplyBodySchema,
  manualOperationId,
  ManualRevisionGrantSchema,
  type ManualApplyBody,
} from '@/domain/manual-revision'
import type { Actor } from '@/lib/auth/server'
import { compareNames } from '@/server/verification/name-match'
import { hasTimeConflict } from '@/server/verification/travel'

import {
  ManualApplyResponseSchema,
  ManualRecoveryResponseSchema,
  ManualRevisionSchema,
  VersionSchema,
} from './contracts'
import {
  fromTripDocument,
  isManualRevisionDocument,
  manualApplyEpoch,
  readManualRevisionDocument,
  toManualRevisionDocument,
  toStopDto,
} from './dto'
import { parseInput, parseStored, PersistenceError } from './errors'
import { requireLearningTripReader } from './learning-trip-rollout'
import { reserveDocumentSlot, REVISION_LIMIT } from './limits'
import { verifyManualRevisionGrant } from './manual-revision-provenance'
import { found, readOwned, recordKey } from './paths'
import type { ApplyGuard } from './revision-apply'
import { reportState, storedReportStates } from './revision-reports'

function readManualRecord(actor: Actor, tripId: string, snapshot: DocumentSnapshot) {
  return readOwned(actor, snapshot, (data, key) => {
    if (!isManualRevisionDocument(data)) throw new PersistenceError('already_exists')
    return readManualRevisionDocument(data, tripId, key)
  })
}

function appliedResult(
  current: Trip,
  revision: ReturnType<typeof readManualRevisionDocument>['revision'],
) {
  const appliedTripVersion = revision.baseTripVersion + 1
  if (current.version === appliedTripVersion) {
    const stop = current.stops.find((item) => item.id === revision.targetStopId)
    if (!stop || !isDeepStrictEqual(toStopDto(stop), toStopDto(revision.diff.after))) {
      throw new PersistenceError('invalid_stored_data')
    }
  }
  return parseStored(ManualApplyResponseSchema, {
    status: 'already_applied',
    appliedTripVersion,
    trip: current,
    revision,
  })
}

export function applyManualRevision(
  actor: Actor,
  tripRef: DocumentReference,
  revisionId: string,
  input: ManualApplyBody,
  guard: ApplyGuard,
  acceptsProtocol: boolean,
) {
  const body = parseInput(ManualApplyBodySchema, input)
  const id = parseInput(ManualRevisionGrantSchema.shape.id, revisionId)
  const collection = tripRef.collection('revisions')
  const ref = collection.doc(recordKey(id))
  const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')

  return guard.write(async (transaction) => {
    const [tripSnapshot, revisionSnapshot] = await transaction.getAll(tripRef, ref)
    const current = found(readOwned(actor, tripSnapshot, fromTripDocument))
    requireLearningTripReader(acceptsProtocol, [current])
    const saved = readManualRecord(actor, current.id, revisionSnapshot)
    if (saved) {
      if (saved.requestHash !== requestHash) throw new PersistenceError('already_exists')
      return appliedResult(current, saved.revision)
    }

    if (current.version !== body.expectedVersion) throw new PersistenceError('version_conflict')
    const grant = verifyManualRevisionGrant(actor, current, body.token)
    if (
      grant.epoch !== manualApplyEpoch(tripSnapshot) ||
      id !== (await manualOperationId({ id: grant.id, token: body.token }, body.confirmation))
    ) {
      throw new PersistenceError('revision_provenance_invalid')
    }
    const index = current.stops.findIndex((stop) => stop.id === grant.targetStopId)
    const before = current.stops[index]
    if (
      !before ||
      revisionTargetRestriction(before) ||
      !matchesRevisionReportTarget(grant.context, before.id)
    ) {
      throw new PersistenceError('revision_mismatch')
    }
    if (grant.context.phase === 'on_site' && grant.context.report.kind === 'simulated') {
      throw new PersistenceError('revision_simulated')
    }
    if (
      hasTimeConflict(current.stops) ||
      compareNames(before.name, grant.name) === 'exact' ||
      (grant.placeId !== null && current.stops.some((stop) => stop.placeId === grant.placeId))
    )
      throw new PersistenceError('revision_not_applicable')

    // 署名を発行できる保存済みTripは、生成時に報告状態を初期化済み。
    const states = storedReportStates(tripSnapshot)
    if (!states) throw new PersistenceError('invalid_stored_data')
    const report = reportState(states, before.id)
    if (report.reportVersion !== grant.reportVersion)
      throw new PersistenceError('revision_report_changed')
    if (report.blocked) throw new PersistenceError('revision_unverified')

    const after = {
      ...before,
      name: grant.name,
      placeId: grant.placeId,
      evidence: [],
      manualRevisionId: id,
    }
    const trip = parseStored(TripSchema, {
      ...current,
      version: current.version + 1,
      stops: current.stops.with(index, after),
    })
    const revision = parseStored(ManualRevisionSchema, {
      id,
      tripId: current.id,
      baseTripVersion: current.version,
      targetStopId: before.id,
      reason: grant.reason,
      context: grant.context,
      diff: { before, after },
      impactSummary: '本人の確認を記録して、1地点を差し替えました。',
      constraintCheck: { status: 'unknown', explanation: MANUAL_UNVERIFIED },
      method: 'manual',
      confirmation: body.confirmation,
      approval: { status: 'approved', decidedAt: new Date().toISOString() },
    })
    const result = parseStored(ManualApplyResponseSchema, {
      status: 'applied',
      appliedTripVersion: trip.version,
      trip,
      revision,
    })
    const storedStops: unknown = tripSnapshot.get('trip.stops')
    if (!Array.isArray(storedStops)) throw new PersistenceError('invalid_stored_data')
    guard.assertActive()
    await reserveDocumentSlot(transaction, collection, REVISION_LIMIT)
    transaction.update(tripRef, {
      'trip.version': trip.version,
      'trip.stops': storedStops.with(index, toStopDto(after)),
    })
    transaction.create(ref, toManualRevisionDocument(actor, revision, requestHash))
    return result
  })
}

// 同じTripと履歴を適用側と同じ書き込み権で読む。履歴がまだ無ければ、以前の署名で
// 遅れて確定できないよう、Tripの内容や版を動かさず手動承認用の世代を進める。
export function resolveManualRevision(
  actor: Actor,
  tripRef: DocumentReference,
  revisionId: string,
  expectedVersion: number,
  guard: ApplyGuard,
  acceptsProtocol: boolean,
) {
  const id = parseInput(ManualRevisionGrantSchema.shape.id, revisionId)
  const version = parseInput(VersionSchema, expectedVersion)
  const ref = tripRef.collection('revisions').doc(recordKey(id))
  return guard.write(async (transaction) => {
    const [tripSnapshot, revisionSnapshot] = await transaction.getAll(tripRef, ref)
    const trip = found(readOwned(actor, tripSnapshot, fromTripDocument))
    requireLearningTripReader(acceptsProtocol, [trip])
    const saved = readManualRecord(actor, trip.id, revisionSnapshot)
    if (saved) {
      if (saved.revision.baseTripVersion !== version) throw new PersistenceError('version_conflict')
      return appliedResult(trip, saved.revision)
    }
    if (trip.version < version) throw new PersistenceError('version_conflict')
    if (trip.version === version) {
      transaction.update(tripRef, {
        manualApplyEpoch: parseStored(VersionSchema, manualApplyEpoch(tripSnapshot) + 1),
      })
    }
    return parseStored(ManualRecoveryResponseSchema, {
      status: 'not_applied',
      trip,
      revisionId: id,
      baseTripVersion: version,
    })
  })
}
