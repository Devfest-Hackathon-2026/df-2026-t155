import { LEARNING_COUNT_HEADER } from '@/domain/learning-trip-protocol'
import { COSTS, createTripCost } from '@/server/cost-control/costs'
import {
  CreateTripBodySchema,
  TripListResponseSchema,
  TripResponseSchema,
} from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { LEARNING_LIMIT } from '@/server/persistence/limits'
import {
  acceptsLearningTripProtocol,
  requireLearningTripReader,
} from '@/server/persistence/learning-trip-rollout'
import { PersistenceError } from '@/server/persistence/errors'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

export function GET(request: Request): Promise<Response> {
  return withDataActor(request, COSTS.listTrips, async (actor, operation) => {
    operation.assertActive()
    const { items: trips, listInfo } = await new FirestoreTripStore().listTrips(actor)
    requireLearningTripReader(acceptsLearningTripProtocol(request), trips)
    return dataResponse(TripListResponseSchema, { trips, listInfo })
  })
}

export function POST(request: Request): Promise<Response> {
  // 宣言は事前予約にのみ使い、本文と一致する場合にだけ保存へ進む。
  const declared = request.headers.get(LEARNING_COUNT_HEADER)
  const count = declared === null || /^(0|[1-9][0-9]?)$/.test(declared) ? Number(declared) : NaN
  const validCount = Number.isInteger(count) && count >= 0 && count <= LEARNING_LIMIT
  return withDataActor(
    request,
    createTripCost(validCount ? count : 0),
    async (actor, operation) => {
      if (!validCount) throw new PersistenceError('invalid_request')
      const input = await readDataBody(request, CreateTripBodySchema, {
        signal: operation.signal,
        timeoutMs: 2_000,
      })
      if (input.learningApplications.length !== count) throw new PersistenceError('invalid_request')
      operation.assertActive()
      const trip = await new FirestoreTripStore().createTrip(actor, input, operation.write)
      return dataResponse(TripResponseSchema, { trip }, 201)
    },
  )
}
