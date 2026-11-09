import type { z } from 'zod'
import { RevisionSchema, type Revision } from '@/domain'
import {
  ApplyRevisionResponseSchema,
  PendingRevisionResponseSchema,
  RevisionResponseSchema,
  TripResponseSchema,
  RevisionReportResponseSchema,
} from '@/server/persistence/contracts'
import type { ApplyRevision } from '@/features/revision-review/api-client'
import { authorizedJson, ReflectionApiError } from '@/features/reflection-flow/api-client'
import {
  assertCurrentSessionScopeSync,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'
import { ClientAuthError } from '@/lib/auth/client'
import {
  clearApplyUnresolved,
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

export function scopedRecovery(scope: SessionScope) {
  return {
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
