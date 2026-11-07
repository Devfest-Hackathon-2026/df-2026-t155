import {
  CreateTripBodySchema,
  TripListResponseSchema,
  TripResponseSchema,
} from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

export function GET(request: Request): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { items: trips, listInfo } = await new FirestoreTripStore().listTrips(actor)
    return dataResponse(TripListResponseSchema, { trips, listInfo })
  })
}

export function POST(request: Request): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const input = await readDataBody(request, CreateTripBodySchema)
    const trip = await new FirestoreTripStore().createTrip(actor, input)
    return dataResponse(TripResponseSchema, { trip }, 201)
  })
}
