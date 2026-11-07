import { LearningListResponseSchema } from '@/server/persistence/contracts'
import { dataResponse, withDataActor } from '@/server/persistence/http'
import { FirestoreLearningStore } from '@/server/persistence/learnings'

export const runtime = 'nodejs'

export function GET(request: Request): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { items: learnings, listInfo } = await new FirestoreLearningStore().list(actor)
    return dataResponse(LearningListResponseSchema, { learnings, listInfo })
  })
}
