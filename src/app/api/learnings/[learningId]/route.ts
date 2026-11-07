import { AuthError } from '@/lib/auth/server'
import { VersionedLearningSchema, VersionSchema } from '@/server/persistence/contracts'
import { parseInput } from '@/server/persistence/errors'
import { dataResponse, noDataResponse, withDataActor } from '@/server/persistence/http'
import { FirestoreLearningStore } from '@/server/persistence/learnings'

export const runtime = 'nodejs'

type Context = { params: Promise<{ learningId: string }> }

export function GET(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { learningId } = await context.params
    return dataResponse(
      VersionedLearningSchema,
      await new FirestoreLearningStore().get(actor, learningId),
    )
  })
}

export function DELETE(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { learningId } = await context.params
    const versions = new URL(request.url).searchParams.getAll('expectedVersion')
    const rawVersion =
      versions.length === 1 && /^(0|[1-9]\d*)$/.test(versions[0]) ? versions[0] : NaN
    const expectedVersion = parseInput(VersionSchema, Number(rawVersion))
    const removed = await new FirestoreLearningStore().remove(
      actor.uid,
      learningId,
      expectedVersion,
    )
    if (!removed) throw new AuthError('not_found')
    return noDataResponse()
  })
}
