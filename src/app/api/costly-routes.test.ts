import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleReviseTripRequest, sampleTrip } from '@/domain/samples'

import { sampleGenerateTripBody } from '../../../tests/helpers/generate-request'

import { GET as session } from './auth/session/route'
import { POST as candidates } from './learnings/candidates/route'
import { POST as generate } from './trips/generate/route'
import { POST as revise } from './trips/revise/route'
import { POST as verify } from './trips/verify/route'

const { verifyIdToken, verifyAppCheck, reserveCost, generateJson, searchPlaces, computeRoute } =
  vi.hoisted(() => ({
    verifyIdToken: vi.fn(),
    verifyAppCheck: vi.fn(),
    reserveCost: vi.fn(),
    generateJson: vi.fn(),
    searchPlaces: vi.fn(),
    computeRoute: vi.fn(),
  }))
vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken }),
  getAdminAppCheck: () => ({ verifyToken: verifyAppCheck }),
}))
vi.mock('@/server/cost-control/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/cost-control/store')>()),
  reserveCost,
}))
vi.mock('@/server/gemini/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/gemini/client')>()),
  createLazyVertexGeminiClient: () => ({ generateJson }),
}))
vi.mock('@/server/maps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/maps')>()),
  createLazyMapsClient: () => ({ searchPlaces, computeRoute }),
}))

const token = 'private.id.token'
const privateDetails = 'private UID, API key and SDK diagnostics'
const authHeader = `Bearer ${token}`

const routes = [
  ['/api/trips/generate', 'TRIP_GENERATION_ENABLED', generate, sampleGenerateTripBody()],
  ['/api/trips/verify', 'TRIP_VERIFICATION_ENABLED', verify, { trip: sampleTrip }],
  ['/api/trips/revise', 'TRIP_REVISION_ENABLED', revise, sampleReviseTripRequest],
  [
    '/api/learnings/candidates',
    'LEARNING_CANDIDATES_ENABLED',
    candidates,
    { trip: sampleTrip, revisions: [], feedback: '昼食後は休みたかった' },
  ],
] as const

beforeEach(() => {
  vi.resetAllMocks()
  verifyIdToken.mockResolvedValue({ uid: 'verified-uid' })
  verifyAppCheck.mockResolvedValue({ appId: 'test-app' })
  reserveCost.mockResolvedValue({
    kind: 'allowed',
    workAvailableMs: 150_000,
    release: async () => undefined,
  })
  vi.stubEnv('COSTLY_API_INVITED_UIDS', '["verified-uid"]')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'test-app')
  vi.stubEnv('COSTLY_API_DEMO_ENABLED', '')
  vi.stubEnv('DEMO_ACCESS_ENABLED', undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('unexpected network call')
    }),
  )
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('App Hostingへの直接アクセスで通常の認証疎通ができる', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DEMO_ACCESS_ENABLED', 'false')
  const response = await session(
    new Request('https://groundtrip-example.hosted.app/api/auth/session', {
      headers: { Authorization: authHeader },
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ uid: 'verified-uid' })
  expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith(token, true)
  expect(verifyAppCheck).not.toHaveBeenCalled()
  expect(reserveCost).not.toHaveBeenCalled()
})

describe.each(routes)('POST %s の認証と公開停止', (path, flag, post, input) => {
  function request(authorization?: string, body = JSON.stringify(input)) {
    return new Request(`https://groundtrip-example.hosted.app${path}`, {
      method: 'POST',
      headers: {
        'X-Firebase-AppCheck': 'test.app.check',
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body,
    })
  }

  function expectStoppedBeforeBody(incoming: Request) {
    expect(incoming.bodyUsed).toBe(false)
    expect(reserveCost).not.toHaveBeenCalled()
    expect(generateJson).not.toHaveBeenCalled()
    expect(searchPlaces).not.toHaveBeenCalled()
    expect(computeRoute).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  }

  it.each([undefined, 'Basic malformed', authHeader])(
    'フラグ無効なら認証情報と本文に関係なく停止する (%s)',
    async (authorization) => {
      vi.stubEnv(flag, 'false')
      const incoming = request(authorization, '{broken')
      const response = await post(incoming)

      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ status: 'service_unavailable' })
      expect(verifyIdToken).not.toHaveBeenCalled()
      expectStoppedBeforeBody(incoming)
    },
  )

  it('利用制限がない間は、本番でフラグを有効にしても停止する', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv(flag, 'true')
    const incoming = request(authHeader)
    const response = await post(incoming)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'service_unavailable' })
    expect(verifyIdToken).not.toHaveBeenCalled()
    expectStoppedBeforeBody(incoming)
  })

  it.each(['true', 'false'])(
    '本番への直接要求は交換フラグ %s に関わらず #58 の認証・利用枠を通す',
    async (exchangeFlag) => {
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('COSTLY_API_DEMO_ENABLED', 'true')
      vi.stubEnv('DEMO_ACCESS_ENABLED', exchangeFlag)
      vi.stubEnv(flag, 'true')
      reserveCost.mockResolvedValue({ kind: 'limited', scope: 'global' })
      const response = await post(request(authHeader))
      expect(response.status).toBe(429)
      expect(await response.json()).toMatchObject({ error: { code: 'global_limit' } })
      expect(verifyIdToken).toHaveBeenCalledBefore(verifyAppCheck)
      expect(verifyAppCheck).toHaveBeenCalledBefore(reserveCost)
      expect(generateJson).not.toHaveBeenCalled()
      expect(searchPlaces).not.toHaveBeenCalled()
      expect(computeRoute).not.toHaveBeenCalled()
    },
  )

  it('本番の招待デモフラグを指定しても利用枠を取得できなければ停止する', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('COSTLY_API_DEMO_ENABLED', 'true')
    vi.stubEnv(flag, 'true')
    reserveCost.mockResolvedValue({ kind: 'unavailable' })
    vi.stubEnv('DEMO_ACCESS_ENABLED', 'false')
    const response = await post(request(authHeader))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'protection_unavailable' } })
    expect(verifyIdToken).toHaveBeenCalledBefore(verifyAppCheck)
    expect(verifyAppCheck).toHaveBeenCalledBefore(reserveCost)
    expect(generateJson).not.toHaveBeenCalled()
    expect(searchPlaces).not.toHaveBeenCalled()
    expect(computeRoute).not.toHaveBeenCalled()
  })

  it.each([
    [undefined, 'unauthenticated'],
    ['Bearer invalid', 'invalid_token'],
  ])('Bearerトークンがなければ本文のUIDで認証しない (%s)', async (authorization, code) => {
    vi.stubEnv(flag, 'true')
    const incoming = request(authorization, JSON.stringify({ ...input, uid: 'verified-uid' }))
    const response = await post(incoming)

    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(verifyIdToken).not.toHaveBeenCalled()
    expectStoppedBeforeBody(incoming)
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([
    ['auth/invalid-id-token', 401, 'invalid_token'],
    ['auth/id-token-expired', 401, 'token_expired'],
    ['auth/id-token-revoked', 401, 'session_revoked'],
    ['auth/user-disabled', 401, 'session_revoked'],
    ['auth/network-request-failed', 503, 'auth_unavailable'],
  ])('SDKの検証失敗 %s では課金処理を始めない', async (sdkCode, status, code) => {
    vi.stubEnv(flag, 'true')
    verifyIdToken.mockRejectedValue(
      Object.assign(new Error(privateDetails + token), { code: sdkCode }),
    )
    const incoming = request(authHeader)
    const response = await post(incoming)

    expect(response.status).toBe(status)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const body: unknown = await response.json()
    expect(body).toEqual({ error: { code, message: expect.any(String) } })
    expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith(token, true)
    expectStoppedBeforeBody(incoming)
    expect(JSON.stringify(body)).not.toContain(privateDetails)
    expect(JSON.stringify(body)).not.toContain(token)
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(logs).not.toContain(privateDetails)
    expect(logs).not.toContain(token)
    if (status === 401) expect(console.error).not.toHaveBeenCalled()
  })

  it('招待されていないUIDはApp Check・枠予約・下流に進まない', async () => {
    vi.stubEnv(flag, 'true')
    verifyIdToken.mockResolvedValue({ uid: 'uninvited' })
    const incoming = request(authHeader)
    const response = await post(incoming)

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'invite_required' } })
    expect(verifyAppCheck).not.toHaveBeenCalled()
    expectStoppedBeforeBody(incoming)
  })

  it.each([
    ['missing', 403, 'app_check_invalid'],
    ['wrong_app', 403, 'app_check_invalid'],
    ['expired', 403, 'app_check_invalid'],
    ['outage', 503, 'app_check_unavailable'],
  ])('App Check拒否 %s では枠予約と課金処理を行わない', async (kind, status, code) => {
    vi.stubEnv(flag, 'true')
    const incoming = request(authHeader)
    if (kind === 'missing') incoming.headers.delete('X-Firebase-AppCheck')
    if (kind === 'wrong_app') verifyAppCheck.mockResolvedValue({ appId: 'other-app' })
    if (kind === 'expired')
      verifyAppCheck.mockRejectedValue({ code: 'app-check/app-check-token-expired' })
    if (kind === 'outage')
      verifyAppCheck.mockRejectedValue({
        code: 'app-check/invalid-argument',
        cause: { code: 'key-fetch-error', details: privateDetails },
      })

    const response = await post(incoming)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: { code, message: expect.any(String) } })
    expectStoppedBeforeBody(incoming)
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([
    [{ kind: 'limited', scope: 'uid' }, 429, 'uid_limit'],
    [{ kind: 'limited', scope: 'global' }, 429, 'global_limit'],
    [{ kind: 'unavailable' }, 503, 'protection_unavailable'],
  ])('認証成功後も利用枠の拒否 %j では下流に進まない', async (admission, status, code) => {
    vi.stubEnv(flag, 'true')
    reserveCost.mockResolvedValue(admission)
    const response = await post(request(authHeader))

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(verifyAppCheck).toHaveBeenCalledWith('test.app.check')
    expect(verifyAppCheck).toHaveBeenCalledBefore(reserveCost)
    expect(generateJson).not.toHaveBeenCalled()
    expect(searchPlaces).not.toHaveBeenCalled()
    expect(computeRoute).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('枠ストアが例外を投げても機密情報を出さず課金処理を停止する', async () => {
    vi.stubEnv(flag, 'true')
    reserveCost.mockRejectedValue(new Error(privateDetails))
    const response = await post(request(authHeader))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'protection_unavailable', message: expect.any(String) },
    })
    expect(generateJson).not.toHaveBeenCalled()
    expect(searchPlaces).not.toHaveBeenCalled()
    expect(computeRoute).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('認証成功後だけ下流処理に進み、例外に含まれる機密情報を返さない', async () => {
    vi.stubEnv(flag, 'true')
    const failure = Object.assign(new Error(privateDetails), { name: token })
    generateJson.mockRejectedValue(failure)
    searchPlaces.mockRejectedValue(failure)
    const response = await post(request(authHeader))

    expect(response.status).toBe(502)
    expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith(token, true)
    const paidCall = post === verify ? searchPlaces : generateJson
    expect(paidCall).toHaveBeenCalled()
    expect(verifyIdToken).toHaveBeenCalledBefore(paidCall)
    expect(JSON.stringify(paidCall.mock.calls)).not.toContain(token)
    expect(fetch).not.toHaveBeenCalled()
    const body = await response.text()
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(body).not.toContain(privateDetails)
    expect(body).not.toContain(token)
    expect(logs).not.toContain(privateDetails)
    expect(logs).not.toContain(token)
  })
})
