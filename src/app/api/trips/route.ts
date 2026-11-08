import { COSTS } from '@/server/cost-control/costs'
import {
  CreateTripBodySchema,
  TripListResponseSchema,
  TripResponseSchema,
} from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

export function GET(request: Request): Promise<Response> {
  return withDataActor(request, COSTS.listTrips, async (actor, operation) => {
    operation.assertActive()
    const { items: trips, listInfo } = await new FirestoreTripStore().listTrips(actor)
    return dataResponse(TripListResponseSchema, { trips, listInfo })
  })
}

export function POST(request: Request): Promise<Response> {
  return withDataActor(request, COSTS.createTrip, async (actor, operation) => {
    const input = await readDataBody(request, CreateTripBodySchema)
    operation.assertActive()
    const trip = await new FirestoreTripStore().createTrip(actor, input, operation.write)
    return dataResponse(TripResponseSchema, { trip }, 201)
  })
}
