import {
  SaveRevisionBodySchema,
  RevisionListResponseSchema,
  RevisionResponseSchema,
} from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

type Context = { params: Promise<{ tripId: string }> }

export function GET(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { tripId } = await context.params
    const { items: revisions, listInfo } = await new FirestoreTripStore().listRevisions(
      actor,
      tripId,
    )
    return dataResponse(RevisionListResponseSchema, { revisions, listInfo })
  })
}

export function POST(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { tripId } = await context.params
    const input = await readDataBody(request, SaveRevisionBodySchema)
    const revision = await new FirestoreTripStore().saveRevision(actor, tripId, input)
    return dataResponse(RevisionResponseSchema, { revision }, 201)
  })
}
