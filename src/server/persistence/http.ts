import 'server-only'

import type { z } from 'zod'

import { AuthError, authErrorResponse, type Actor } from '@/lib/auth/server'

import { WriteFenceError } from '../cost-control/write-transaction'
import type { OperationCost } from '../cost-control/policy'
import {
  isCostlyApiEnabled,
  requireCostlyApiActor,
  runCostlyOperation,
  type CostlyOperation,
} from '../costly-api'
import { readBodyWithLimit } from '../http'
import { diagnosePersistenceFailure } from './diagnostics'
import { parseInput, parseStored, PersistenceError } from './errors'

const headers = { 'Cache-Control': 'private, no-store' }
const MAX_BODY_BYTES = 64 * 1024

export async function withDataActor(
  request: Request,
  cost: OperationCost,
  action: (actor: Actor, operation: CostlyOperation) => Promise<Response>,
): Promise<Response> {
  try {
    if (!isCostlyApiEnabled(process.env.PERSISTENCE_ENABLED)) {
      throw new PersistenceError('persistence_disabled')
    }
    const actor = await requireCostlyApiActor(request)
    if (actor instanceof Response) return actor

    return await runCostlyOperation(actor, cost, async (operation) => {
      try {
        return await action(actor, operation)
      } catch (error) {
        const response = dataError(error)
        if (response.status >= 500) operation.keepLease()
        return response
      }
    })
  } catch (error) {
    return dataError(error)
  }
}

function dataError(error: unknown): Response {
  if (error instanceof AuthError) return authErrorResponse(error)
  if (error instanceof WriteFenceError) {
    const unknown = error.code === 'write_result_unknown'
    return Response.json(
      {
        error: {
          code: unknown ? 'write_result_unknown' : 'protection_unavailable',
          message: unknown
            ? '保存結果を確認できませんでした。再送する前に保存内容を取得してください。'
            : '保存の利用枠を安全に確認できませんでした。',
        },
      },
      { status: 503, headers },
    )
  }
  const failure = diagnosePersistenceFailure(error)
  return Response.json(
    { error: { code: failure.code, message: failure.message } },
    { status: failure.status, headers },
  )
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
