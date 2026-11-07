import 'server-only'

import type { z } from 'zod'

import { AuthError, authErrorResponse, requireActor, type Actor } from '@/lib/auth/server'

import { readBodyWithLimit } from '../http'
import { diagnosePersistenceFailure } from './diagnostics'
import { parseInput, parseStored, PersistenceError } from './errors'

const headers = { 'Cache-Control': 'private, no-store' }
const MAX_BODY_BYTES = 64 * 1024

export async function withDataActor(
  request: Request,
  action: (actor: Actor) => Promise<Response>,
): Promise<Response> {
  try {
    if (process.env.PERSISTENCE_ENABLED?.trim() !== 'true') {
      throw new PersistenceError('persistence_disabled')
    }
    return await action(await requireActor(request))
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error)
    const failure = diagnosePersistenceFailure(error)
    return Response.json(
      { error: { code: failure.code, message: failure.message } },
      { status: failure.status, headers },
    )
  }
}

export async function readDataBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') throw new PersistenceError('unsupported_media_type')
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new PersistenceError('payload_too_large')
  }
  const body = await readBodyWithLimit(request, MAX_BODY_BYTES)
  if (!body.ok) {
    throw new PersistenceError(
      body.reason === 'too_large' ? 'payload_too_large' : 'invalid_request',
    )
  }
  let value: unknown
  try {
    value = JSON.parse(body.text)
  } catch {
    throw new PersistenceError('invalid_request')
  }
  return parseInput(schema, value)
}

export function dataResponse<T>(schema: z.ZodType<T>, data: unknown, status = 200): Response {
  return Response.json(parseStored(schema, data), { status, headers })
}

export function noDataResponse(): Response {
  return new Response(null, { status: 204, headers })
}
