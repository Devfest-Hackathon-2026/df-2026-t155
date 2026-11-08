import { COSTS } from '@/server/cost-control/costs'
import { RevisionResponseSchema } from '@/server/persistence/contracts'
import { dataResponse, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

type Context = { params: Promise<{ tripId: string; revisionId: string }> }

export function GET(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, COSTS.getRevision, async (actor, operation) => {
    const { tripId, revisionId } = await context.params
    operation.assertActive()
    const revision = await new FirestoreTripStore().getRevision(
      actor,
      tripId,
      revisionId,
      operation.assertActive,
    )
    return dataResponse(RevisionResponseSchema, { revision })
  })
}
