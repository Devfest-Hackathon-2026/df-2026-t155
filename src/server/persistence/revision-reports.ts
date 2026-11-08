import 'server-only'

import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore'
import type { z } from 'zod'

import type { RevisionContext, Stop } from '@/domain'
import { isRevisionEvidenceConflict, revisionReportUncertainty } from '@/domain/revision-evidence'
import type { Actor } from '@/lib/auth/server'

import { RevisionReportStatesSchema } from './contracts'
import { fromRevisionDocument } from './dto'
import { parseStored, PersistenceError } from './errors'
import { REVISION_LIMIT } from './limits'
import { readOwned } from './paths'

type States = z.infer<typeof RevisionReportStatesSchema>

export function hasUnresolvedReport(context: RevisionContext, before: Stop, after?: Stop) {
  if (context.phase === 'on_site' && context.report.kind === 'simulated') return false
  return (
    Boolean(revisionReportUncertainty(context)) ||
    before.evidence.some(
      (item) => item.source.kind === 'user_report' && isRevisionEvidenceConflict(item, 'original'),
    ) ||
    (after?.evidence.some(
      (item) => item.source.kind === 'user_report' && isRevisionEvidenceConflict(item, 'candidate'),
    ) ??
      false)
  )
}

export function storedReportStates(snapshot: DocumentSnapshot): States | undefined {
  const states: unknown = snapshot.get('revisionReports')
  return states === undefined ? undefined : parseStored(RevisionReportStatesSchema, states)
}

export function reportState(states: States, stopId: string) {
  const state = states.find((item) => item.stopId === stopId)
  return { blocked: state?.blocked ?? false, reportVersion: state?.reportVersion ?? 0 }
}

export function changeReportState(states: States, stopId: string, blocked: boolean): States {
  return [
    ...states.filter((item) => item.stopId !== stopId),
    { stopId, blocked, reportVersion: reportState(states, stopId).reportVersion + 1 },
  ]
}

// 旧文書だけ保存済み候補から一度復元する。個別の根拠や外部照合結果を複製しない。
export async function readReportStates(
  transaction: Transaction,
  actor: Actor,
  snapshot: DocumentSnapshot,
  trip: { id: string; stops: Stop[] },
  assertActive: () => void,
): Promise<States> {
  const stored = storedReportStates(snapshot)
  if (stored) return stored
  // 先行するTrip読取後に期限が切れた場合、旧文書の復元クエリを開始しない。
  assertActive()
  const revisions = await transaction.get(
    snapshot.ref.collection('revisions').limit(REVISION_LIMIT + 1),
  )
  if (revisions.size > REVISION_LIMIT) throw new PersistenceError('invalid_stored_data')
  let states: States = []
  for (const candidate of revisions.docs) {
    const revision = readOwned(actor, candidate, (data, key) =>
      fromRevisionDocument(data, trip.id, key),
    )
    if (
      revision &&
      trip.stops.some(({ id }) => id === revision.targetStopId) &&
      !reportState(states, revision.targetStopId).blocked &&
      hasUnresolvedReport(revision.context, revision.diff.before, revision.diff.after)
    ) {
      states = changeReportState(states, revision.targetStopId, true)
    }
  }
  return states
}
