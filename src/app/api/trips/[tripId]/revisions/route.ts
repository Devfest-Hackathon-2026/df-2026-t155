import { COSTS } from '@/server/cost-control/costs'
import {
  PendingRevisionResponseSchema,
  RevisionListResponseSchema,
  SaveRevisionBodySchema,
} from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

type Context = { params: Promise<{ tripId: string }> }

export function GET(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, COSTS.listRevisions, async (actor, operation) => {
    const { tripId } = await context.params
    operation.assertActive()
    const { items: revisions, listInfo } = await new FirestoreTripStore().listRevisions(
      actor,
      tripId,
      operation.assertActive,
    )
    return dataResponse(RevisionListResponseSchema, { revisions, listInfo })
  })
}

export function POST(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, COSTS.saveRevision, async (actor, operation) => {
    const { tripId } = await context.params
    const input = await readDataBody(request, SaveRevisionBodySchema)
    operation.assertActive()
    const revision = await new FirestoreTripStore().saveRevision(
      actor,
      tripId,
      input,
      operation.write,
      operation.assertActive,
    )
    return dataResponse(PendingRevisionResponseSchema, { revision }, 201)
  })
}
