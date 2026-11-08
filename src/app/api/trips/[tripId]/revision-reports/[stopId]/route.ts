import { COSTS } from '@/server/cost-control/costs'
import {
  ResolveRevisionReportSchema,
  RevisionReportResponseSchema,
} from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'
type Context = { params: Promise<{ tripId: string; stopId: string }> }

export function GET(request: Request, context: Context) {
  return withDataActor(request, COSTS.getRevisionReport, async (actor, operation) => {
    const { tripId, stopId } = await context.params
    return dataResponse(
      RevisionReportResponseSchema,
      await new FirestoreTripStore().revisionReport(actor, tripId, stopId, operation.assertActive),
    )
  })
}

export function POST(request: Request, context: Context) {
  return withDataActor(request, COSTS.resolveRevisionReport, async (actor, operation) => {
    const { tripId, stopId } = await context.params
    const input = await readDataBody(request, ResolveRevisionReportSchema)
    operation.assertActive()
    return dataResponse(
      RevisionReportResponseSchema,
      await new FirestoreTripStore().resolveRevisionReport(
        actor,
        tripId,
        stopId,
        input,
        operation.write,
        operation.assertActive,
      ),
    )
  })
}
