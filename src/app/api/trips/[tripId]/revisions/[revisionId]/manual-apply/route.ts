import { ManualApplyBodySchema, ManualRecoveryBodySchema } from '@/domain/manual-revision'
import { COSTS } from '@/server/cost-control/costs'
import { isCostlyApiEnabled } from '@/server/costly-api'
import {
  ManualApplyResponseSchema,
  ManualRecoveryResponseSchema,
} from '@/server/persistence/contracts'
import { PersistenceError } from '@/server/persistence/errors'
import { dataError, dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { acceptsLearningTripProtocol } from '@/server/persistence/learning-trip-rollout'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

type Context = { params: Promise<{ tripId: string; revisionId: string }> }

export function POST(request: Request, context: Context): Promise<Response> {
  if (!isCostlyApiEnabled(process.env.TRIP_REVISION_APPLY_ENABLED)) {
    return Promise.resolve(dataError(new PersistenceError('revision_apply_disabled')))
  }
  return withDataActor(request, COSTS.manualApplyRevision, async (actor, operation) => {
    const { tripId, revisionId } = await context.params
    const body = await readDataBody(request, ManualApplyBodySchema, {
      signal: operation.signal,
      timeoutMs: 2_000,
    })
    const result = await new FirestoreTripStore().applyManualRevision(
      actor,
      tripId,
      revisionId,
      body,
      operation,
      acceptsLearningTripProtocol(request),
    )
    return dataResponse(ManualApplyResponseSchema, result)
  })
}

export function PATCH(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, COSTS.resolveManualRevision, async (actor, operation) => {
    const { tripId, revisionId } = await context.params
    const { expectedVersion } = await readDataBody(request, ManualRecoveryBodySchema, {
      signal: operation.signal,
      timeoutMs: 2_000,
    })
    const result = await new FirestoreTripStore().resolveManualRevision(
      actor,
      tripId,
      revisionId,
      expectedVersion,
      operation,
      acceptsLearningTripProtocol(request),
    )
    return dataResponse(ManualRecoveryResponseSchema, result)
  })
}
