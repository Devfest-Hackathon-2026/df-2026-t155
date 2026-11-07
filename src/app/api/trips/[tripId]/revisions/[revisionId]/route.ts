import { RevisionResponseSchema } from '@/server/persistence/contracts'
import { dataResponse, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

type Context = { params: Promise<{ tripId: string; revisionId: string }> }

export function GET(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { tripId, revisionId } = await context.params
    const revision = await new FirestoreTripStore().getRevision(actor, tripId, revisionId)
    return dataResponse(RevisionResponseSchema, { revision })
  })
}
