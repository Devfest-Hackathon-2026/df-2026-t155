import type { z } from 'zod'
import type { ManualApplyBody } from '@/domain/manual-revision'
import { RevisionSchema, type Revision, type Trip } from '@/domain'
import {
  ApplyRevisionResponseSchema,
  ManualApplyResponseSchema,
  ManualRecoveryResponseSchema,
  PendingRevisionResponseSchema,
  RevisionResponseSchema,
  TripResponseSchema,
  RevisionReportResponseSchema,
} from '@/server/persistence/contracts'
import {
  sameStop,
  sameTrip,
  type ApplyManualRevision,
  type ApplyRevision,
} from '@/features/revision-review/api-client'
import { authorizedJson, ReflectionApiError } from '@/features/reflection-flow/api-client'
import {
  assertCurrentSessionScopeSync,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'
import { ClientAuthError } from '@/lib/auth/client'
import {
  clearApplyUnresolved,
  isManualApply,
  judgeLatestTrip,
  readManualReplay,
  readUnresolvedApply,
  rememberManualApply,
  type RecoverManualApply,
  markApplyUnresolved,
} from '@/features/revision-review/unresolved-apply'

export type OnSiteSend = <T>(
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  signal?: AbortSignal,
) => Promise<T>

function persistedCandidate(revision: Revision): string {
  const item = RevisionSchema.parse(revision)
  return JSON.stringify({
    id: item.id,
    tripId: item.tripId,
    baseTripVersion: item.baseTripVersion,
    targetStopId: item.targetStopId,
    reason: item.reason,
    context: item.context,
    diff: {
      before: { ...item.diff.before, evidence: [] },
      after: { ...item.diff.after, evidence: [] },
    },
  })
}
export function createOnSiteApply(
  send: OnSiteSend,
  beforeApply?: (decision: Parameters<ApplyRevision>[0]) => void,
): ApplyRevision {
  return async (decision, signal) => {
    const { request, revision, proposalToken } = decision
    const base = `/api/trips/${encodeURIComponent(request.trip.id)}/revisions`
    try {
      const saved = await send(
        base,
        PendingRevisionResponseSchema,
        {
          ...revision,
          travelModes: request.travelModes ?? ['walk'],
          proposalToken,
        },
        signal,
      )
      if (
        saved.revision.tripId !== request.trip.id ||
        persistedCandidate(saved.revision) !== persistedCandidate(revision)
      ) {
        return {
          status: 'failed',
          message: '候補の保存結果を確認できません。旅程への適用は行っていません。',
        }
      }
    } catch {
      return {
        status: 'failed',
        message: '候補の保存結果を確認できません。旅程への適用は行っていません。',
      }
    }
    try {
      signal?.throwIfAborted()
      beforeApply?.(decision)
    } catch {
      return { status: 'failed', message: '適用状態を保存できないため、適用を開始しませんでした。' }
    }
    try {
      const receipt = await send(
        `${base}/${encodeURIComponent(revision.id)}/apply`,
        ApplyRevisionResponseSchema,
        {
          expectedVersion: request.trip.version,
          confirm: true,
        },
        signal,
      )
      if (receipt.revision.id !== revision.id || receipt.trip.id !== request.trip.id)
        return { status: 'uncertain' }
      return { status: 'applied', trip: receipt.trip, receipt }
    } catch (error) {
      if (
        (error instanceof SessionChangedError && error.outcome === 'not_sent') ||
        error instanceof ClientAuthError
      )
        return { status: 'failed', message: '認証を確認できないため、適用を開始しませんでした。' }
      if (
        error instanceof ReflectionApiError &&
        error.outcome !== 'unknown' &&
        (error.status !== 503 ||
          error.code === 'revision_apply_disabled' ||
          error.code === 'persistence_disabled')
      ) {
        return { status: error.status === 409 ? 'conflict' : 'failed', message: error.message }
      }
      return { status: 'uncertain' }
    }
  }
}
export function scopedOnSiteApply(scope: SessionScope): ApplyRevision {
  return async (decision, signal) => {
    let locked = false
    const run = createOnSiteApply(
      (path, schema, body, requestSignal) =>
        authorizedJson(scope, path, schema, { method: 'POST', body, signal: requestSignal }),
      () => {
        assertCurrentSessionScopeSync(scope)
        markApplyUnresolved(
          scope.uid,
          decision.request.trip.id,
          decision.request.trip.version,
          decision.revision.id,
        )
        locked = true
      },
    )
    const result = await run(decision, signal)
    if (locked && result.status !== 'uncertain' && result.status !== 'applied') {
      try {
        clearApplyUnresolved(scope.uid, decision.request.trip.id, decision.revision.id)
      } catch {
        return { status: 'uncertain' }
      }
    }
    return result
  }
}

const manualApplyPath = (tripId: string, id: string) =>
  `/api/trips/${encodeURIComponent(tripId)}/revisions/${encodeURIComponent(id)}/manual-apply`

export function scopedManualApply(scope: SessionScope): ApplyManualRevision {
  return async ({ trip, revision, grant, operationId, confirmation }, signal) => {
    const index = trip.stops.findIndex(({ id }) => id === revision.targetStopId)
    if (index < 0 || revision.constraintCheck.status !== 'unknown') return { status: 'failed' }
    const body: ManualApplyBody = {
      expectedVersion: trip.version,
      token: grant.token,
      confirmation,
      confirm: true,
    }
    try {
      signal?.throwIfAborted()
      assertCurrentSessionScopeSync(scope)
      markApplyUnresolved(scope.uid, trip.id, trip.version, operationId)
      try {
        rememberManualApply(scope.uid, trip.id, operationId, body)
      } catch {
        clearApplyUnresolved(scope.uid, trip.id, operationId)
        return { status: 'failed', message: '再送に必要な情報を端末に保存できませんでした。' }
      }
    } catch {
      return { status: 'failed', message: '適用状態を保存できないため、適用を開始しませんでした。' }
    }

    try {
      const receipt = await authorizedJson(
        scope,
        manualApplyPath(trip.id, operationId),
        ManualApplyResponseSchema,
        {
          method: 'POST',
          signal,
          body,
        },
      )
      const saved = receipt.revision
      const after = { ...revision.diff.after, evidence: [], manualRevisionId: operationId }
      const withoutEvidence = (value: Trip) => ({
        ...value,
        stops: value.stops.map((stop) => ({ ...stop, evidence: [] })),
      })
      if (
        saved.id !== operationId ||
        saved.tripId !== trip.id ||
        saved.targetStopId !== revision.targetStopId ||
        saved.baseTripVersion !== trip.version ||
        saved.reason !== revision.reason ||
        JSON.stringify(saved.context) !== JSON.stringify(revision.context) ||
        JSON.stringify(saved.confirmation) !== JSON.stringify(confirmation) ||
        !sameStop(after, saved.diff.after) ||
        !sameStop({ ...trip.stops[index], evidence: [] }, saved.diff.before)
      )
        return { status: 'uncertain' }

      if (receipt.trip.version > receipt.appliedTripVersion) {
        return { status: 'applied', trip: receipt.trip, receipt }
      }
      const expected = { ...trip, version: trip.version + 1, stops: trip.stops.with(index, after) }
      if (!sameTrip(withoutEvidence(receipt.trip), withoutEvidence(expected))) {
        return { status: 'uncertain' }
      }
      return { status: 'applied', trip: expected, receipt }
    } catch (error) {
      const notSent =
        (error instanceof SessionChangedError && error.outcome === 'not_sent') ||
        error instanceof ClientAuthError
      if (!notSent && (!(error instanceof ReflectionApiError) || error.outcome === 'unknown')) {
        return { status: 'uncertain' }
      }
      try {
        clearApplyUnresolved(scope.uid, trip.id, operationId)
      } catch {
        return { status: 'uncertain' }
      }
      return error instanceof ReflectionApiError
        ? { status: error.status === 409 ? 'conflict' : 'failed', message: error.message }
        : { status: 'failed', message: '認証を確認できないため、適用を開始しませんでした。' }
    }
  }
}

function scopedManualRecovery(scope: SessionScope): RecoverManualApply {
  return async (tripId, pending, action, signal) => {
    const current = readUnresolvedApply(scope.uid, tripId)
    if (
      current.status !== 'pending' ||
      !isManualApply(pending) ||
      current.value.revisionId !== pending.revisionId ||
      current.value.baseVersion !== pending.baseVersion
    ) {
      return { kind: 'unverified' }
    }
    const path = manualApplyPath(tripId, pending.revisionId)
    const body = action === 'retry' ? readManualReplay(scope.uid, tripId, pending) : undefined
    if (action === 'retry' && !body) return { kind: 'unverified' }
    // 拒否や通信断は前回の結果を確定させない。確定済みの応答だけを採用する。
    const result = body
      ? await authorizedJson(scope, path, ManualApplyResponseSchema, {
          method: 'POST',
          body,
          signal,
        })
      : await authorizedJson(scope, path, ManualRecoveryResponseSchema, {
          method: 'PATCH',
          body: { expectedVersion: pending.baseVersion },
          signal,
        })
    if (result.status === 'not_applied') {
      return result.trip.id === tripId &&
        result.trip.version >= pending.baseVersion &&
        result.revisionId === pending.revisionId &&
        result.baseTripVersion === pending.baseVersion
        ? { kind: 'not_applied', trip: result.trip }
        : { kind: 'unverified' }
    }
    return judgeLatestTrip(
      tripId,
      pending.baseVersion,
      pending.revisionId,
      result.trip,
      result.revision,
    )
  }
}

export function scopedRecovery(scope: SessionScope) {
  return {
    recoverManualApply: scopedManualRecovery(scope),
    loadLatestTrip: async (tripId: string, signal: AbortSignal) =>
      (
        await authorizedJson(
          scope,
          `/api/trips/${encodeURIComponent(tripId)}`,
          TripResponseSchema,
          { signal },
        )
      ).trip,
    loadAppliedRevision: async (tripId: string, revisionId: string, signal: AbortSignal) =>
      (
        await authorizedJson(
          scope,
          `/api/trips/${encodeURIComponent(tripId)}/revisions/${encodeURIComponent(revisionId)}`,
          RevisionResponseSchema,
          { signal },
        )
      ).revision,
  }
}
export function scopedReportControl(scope: SessionScope) {
  const path = (tripId: string, stopId: string) =>
    `/api/trips/${encodeURIComponent(tripId)}/revision-reports/${encodeURIComponent(stopId)}`
  return {
    load: (tripId: string, stopId: string, signal: AbortSignal) =>
      authorizedJson(scope, path(tripId, stopId), RevisionReportResponseSchema, { signal }),
    resolve: (
      tripId: string,
      stopId: string,
      tripVersion: number,
      reportVersion: number,
      signal: AbortSignal,
    ) =>
      authorizedJson(scope, path(tripId, stopId), RevisionReportResponseSchema, {
        method: 'POST',
        signal,
        body: { expectedVersion: tripVersion, expectedReportVersion: reportVersion, confirm: true },
      }),
  }
}
