import { TripResponseSchema, UpdateTripBodySchema } from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

type Context = { params: Promise<{ tripId: string }> }

export function GET(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { tripId } = await context.params
    return dataResponse(TripResponseSchema, {
      trip: await new FirestoreTripStore().getTrip(actor, tripId),
    })
  })
}

export function PATCH(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { tripId } = await context.params
    const { expectedVersion, preferences } = await readDataBody(request, UpdateTripBodySchema)
    const trip = await new FirestoreTripStore().updatePreferences(
      actor,
      tripId,
      expectedVersion,
      preferences,
    )
    return dataResponse(TripResponseSchema, { trip })
  })
}
