import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

import { demoAccessTicket } from '@/features/demo-access/contract'
import { getAdminAuth } from '@/lib/firebase/admin'
import { checkAppCheck, checkInviteEligibility } from '@/server/cost-control/eligibility'
import { withinDeadline } from '@/server/cost-control/store'
import { isDemoAuthPolicyConfigured } from '@/server/demo-auth-policy'
import { noStoreHeaders, readBodyWithLimit } from '@/server/http'

export const runtime = 'nodejs'

const ticketConfig = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  uid: z.string().min(1).max(128),
  expiresAt: z.iso.datetime(),
  revoked: z.boolean(),
})

const attempts: number[] = []
let pending = 0
const windowMs = 60_000
const maxAttempts = 12
const maxPending = 2
const deadlineMs = 8_000
const maxTicketBytes = 43

function error(status: number) {
  const headers = new Headers(noStoreHeaders)
  if (status === 429) headers.set('Retry-After', '60')
  return Response.json({ status: status === 503 ? 'unavailable' : 'denied' }, { status, headers })
}

async function exchange(request: Request, signal: AbortSignal): Promise<Response> {
  const config = ticketConfig.safeParse(JSON.parse(process.env.DEMO_ACCESS_TICKET ?? 'null'))
  if (!config.success) return error(503)
  const { sha256, uid, expiresAt, revoked } = config.data
  const isExpired = () => Date.now() >= Date.parse(expiresAt)
  if (revoked || isExpired()) return error(403)

  const body = await readBodyWithLimit(request, maxTicketBytes, signal)
  if (!body.ok) return error(body.reason === 'too_large' ? 413 : 400)
  if (!demoAccessTicket.safeParse(body.text).success) return error(403)
  const digest = createHash('sha256').update(body.text).digest()
  if (!timingSafeEqual(digest, Buffer.from(sha256, 'hex'))) return error(403)

  const invite = checkInviteEligibility(uid)
  if (invite) return error(invite === 'invite_required' ? 403 : 503)

  signal.throwIfAborted()
  // 無効な券は署名枠を消費しない。本文読み取りは別途サイズと時間で制限する。
  const now = performance.now()
  while (attempts.length && now - attempts[0] >= windowMs) attempts.shift()
  if (attempts.length >= maxAttempts || pending >= maxPending) return error(429)
  attempts.push(now)
  pending += 1

  try {
    return await issueToken(request, uid, isExpired, signal)
  } finally {
    pending -= 1
  }
}

async function issueToken(
  request: Request,
  uid: string,
  isExpired: () => boolean,
  signal: AbortSignal,
): Promise<Response> {
  // 交換全体の締切で応答し、App Checkの通信が終わるまで同時枠を維持する。
  const appCheck = await checkAppCheck(request, null)
  if (appCheck) return error(appCheck === 'app_check_invalid' ? 403 : 503)

  signal.throwIfAborted()
  const auth = getAdminAuth()
  if (!(await isDemoAuthPolicyConfigured(signal))) return error(503)
  signal.throwIfAborted()
  const user = await auth.getUser(uid).catch((cause: unknown) => {
    if (
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      cause.code === 'auth/user-not-found'
    ) {
      return null
    }
    throw cause
  })
  if (!user || user.uid !== uid || user.disabled || isExpired()) return error(403)
  if (user.providerData.length || user.email || user.phoneNumber) return error(403)

  signal.throwIfAborted()
  const customToken = await auth.createCustomToken(uid)
  signal.throwIfAborted()
  if (isExpired()) return error(403)
  return Response.json({ customToken }, { headers: noStoreHeaders })
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DEMO_ACCESS_ENABLED !== 'true') return error(503)

  const origin = process.env.DEMO_ACCESS_ORIGIN
  if (!origin || (process.env.NODE_ENV === 'production' && !origin.startsWith('https://'))) {
    return error(503)
  }
  if (request.headers.get('Origin') !== origin || new URL(request.url).search) return error(403)
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'text/plain') {
    return error(415)
  }

  if (Number(request.headers.get('Content-Length')) > maxTicketBytes) return error(413)

  const deadline = new AbortController()
  const signal = AbortSignal.any([request.signal, deadline.signal])
  try {
    // SDKがまだ処理中なら、HTTP応答を打ち切った後も同時枠を保持する。
    return await withinDeadline(deadlineMs, () => exchange(request, signal))
  } catch {
    return error(503)
  } finally {
    deadline.abort()
  }
}
