import { COSTS } from '@/server/cost-control/costs'
import { meteredMaps } from '@/server/cost-control/providers'
import { isCostlyApiEnabled } from '@/server/costly-api'
import { createLazyMapsClient } from '@/server/maps'
import {
  ApplyRevisionBodySchema,
  ApplyRevisionResponseSchema,
} from '@/server/persistence/contracts'
import { PersistenceError } from '@/server/persistence/errors'
import { dataError, dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { acceptsLearningTripProtocol } from '@/server/persistence/learning-trip-rollout'
import { FirestoreTripStore } from '@/server/persistence/trips'
import { createRevisionVerifier } from '@/server/revision/verify-for-apply'

export const runtime = 'nodejs'

const maps = createLazyMapsClient(process.env)
type Context = { params: Promise<{ tripId: string; revisionId: string }> }

export function POST(request: Request, context: Context): Promise<Response> {
  // 適用の機能フラグは、認証・利用枠の予約より前に確かめる。停止中の要求が枠を消費しない。
  if (!isCostlyApiEnabled(process.env.TRIP_REVISION_APPLY_ENABLED)) {
    return Promise.resolve(dataError(new PersistenceError('revision_apply_disabled')))
  }
  // 確定前の再検証（Places・Routes）と確定を、同じ操作の予約に含める。
  // 有料のMaps照会は計量済みclientだけを通し、確定は書き込み権（`operation.write`）で守る。
  return withDataActor(request, COSTS.applyRevision, async (actor, operation) => {
    const { tripId, revisionId } = await context.params
    const { expectedVersion } = await readDataBody(request, ApplyRevisionBodySchema)
    operation.assertActive()
    const result = await new FirestoreTripStore().applyRevision(
      actor,
      tripId,
      revisionId,
      expectedVersion,
      createRevisionVerifier(meteredMaps(operation, maps)),
      operation,
      acceptsLearningTripProtocol(request),
    )
    return dataResponse(ApplyRevisionResponseSchema, result)
  })
}
