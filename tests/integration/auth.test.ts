import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import '../helpers/mock-cost-control'

import { GET } from '../../src/app/api/auth/session/route'
import { POST as candidates } from '../../src/app/api/learnings/candidates/route'
import { POST as generate } from '../../src/app/api/trips/generate/route'
import { POST as revise } from '../../src/app/api/trips/revise/route'
import { POST as verify } from '../../src/app/api/trips/verify/route'
import { sampleReviseTripRequest, sampleTrip } from '../../src/domain/samples'
import { sampleGenerateTripBody } from '../helpers/generate-request'
import { requireActor, requireOwner } from '../../src/lib/auth/server'
import { getAdminAuth } from '../../src/lib/firebase/admin'

const paidAdapters = vi.hoisted(() => ({
  generateJson: vi.fn(),
  searchPlaces: vi.fn(),
  computeRoute: vi.fn(),
}))

// AuthだけをEmulatorに接続する。課金対象のアダプターは全経路で差し替える。
vi.mock('@/server/gemini/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/gemini/client')>()),
  createLazyVertexGeminiClient: () => ({ generateJson: paidAdapters.generateJson }),
}))
vi.mock('@/server/maps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/maps')>()),
  createLazyMapsClient: () => ({
    searchPlaces: paidAdapters.searchPlaces,
    computeRoute: paidAdapters.computeRoute,
  }),
}))

const apps: FirebaseApp[] = []

async function createSession(name: string) {
  const app = initializeApp({ projectId: 'demo-groundtrip', apiKey: 'demo-api-key' }, name)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const { user } = await signInAnonymously(auth)
  const token = await user.getIdToken()
  const request = new Request('http://localhost/api/auth/session?uid=untrusted-user', {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { user, request }
}

// Auth Emulator限定。署名なしトークンのクレーム検査・失効検査を確認し、
// 本番の暗号学的な署名検証を検証したとは扱わない。
function withEmulatorClaims(request: Request, changes: Record<string, string | number>) {
  const token = request.headers.get('authorization')?.slice('Bearer '.length)
  if (!token) throw new Error('Emulatorテストの認証がありません')
  const [header, payload] = token.split('.')
  const claims: Record<string, unknown> = JSON.parse(Buffer.from(payload, 'base64url').toString())
  const changed = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url')
  return new Request(request.url, {
    headers: { Authorization: `Bearer ${header}.${changed}.` },
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const mock of Object.values(paidAdapters)) mock.mockReset()
})

afterAll(async () => {
  await Promise.all(apps.map((app) => deleteApp(app)))
})

describe('Firebase Auth Emulator＋実Admin SDK＋Route Handler', () => {
  it('匿名認証したA/Bを区別し、検証された本人のUIDのみを返す', async () => {
    const a = await createSession('integration-a')
    const b = await createSession('integration-b')
    expect(a.user.uid === b.user.uid).toBe(false)
    expect(a.user.isAnonymous).toBe(true)
    const response = await GET(a.request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ uid: a.user.uid })
    const actor = await requireActor(a.request)
    expect(() => requireOwner(actor, a.user.uid)).not.toThrow()
    expect(() => requireOwner(actor, b.user.uid)).toThrow()
  })

  it('未認証・不正トークンを拒否する', async () => {
    const noAuth = await GET(new Request('http://localhost/api/auth/session'))
    expect(noAuth.status).toBe(401)
    const invalid = await GET(
      new Request('http://localhost/api/auth/session', {
        headers: { Authorization: 'Bearer invalid.invalid.invalid' },
      }),
    )
    expect(invalid.status).toBe(401)
  })

  it('無効化されたユーザーの既存トークンを拒否する', async () => {
    const session = await createSession('integration-disabled')
    await getAdminAuth().updateUser(session.user.uid, { disabled: true })
    const response = await GET(session.request)
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('session_revoked')
  })

  it('削除されたユーザーの既存トークンを拒否する', async () => {
    const session = await createSession('integration-deleted')
    await getAdminAuth().deleteUser(session.user.uid)
    const response = await GET(session.request)
    expect(response.status).toBe(401)
  })

  it('期限切れのEmulatorトークンを拒否する', async () => {
    const session = await createSession('integration-expired')
    const response = await GET(withEmulatorClaims(session.request, { exp: 1 }))
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('token_expired')
  })

  it.each(['aud', 'iss'])('異なるプロジェクトの%sを拒否する', async (claim) => {
    const session = await createSession(`integration-project-${apps.length}`)
    const value = claim === 'aud' ? 'other-project' : 'https://securetoken.google.com/other-project'
    const response = await GET(withEmulatorClaims(session.request, { [claim]: value }))
    expect(response.status).toBe(401)
  })

  it('失効前に認証されたセッションを拒否する', async () => {
    const session = await createSession('integration-revoked')
    await getAdminAuth().revokeRefreshTokens(session.user.uid)
    const response = await GET(withEmulatorClaims(session.request, { auth_time: 1 }))
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('session_revoked')
  })
})

const paidRoutes = [
  [
    '/api/trips/generate',
    'TRIP_GENERATION_ENABLED',
    generate,
    sampleGenerateTripBody(),
    paidAdapters.generateJson,
  ],
  [
    '/api/trips/verify',
    'TRIP_VERIFICATION_ENABLED',
    verify,
    { trip: sampleTrip },
    paidAdapters.searchPlaces,
  ],
  [
    '/api/trips/revise',
    'TRIP_REVISION_ENABLED',
    revise,
    sampleReviseTripRequest,
    paidAdapters.generateJson,
  ],
  [
    '/api/learnings/candidates',
    'LEARNING_CANDIDATES_ENABLED',
    candidates,
    { trip: sampleTrip, revisions: [], feedback: '昼食後は休みたかった' },
    paidAdapters.generateJson,
  ],
] as const

describe.each(paidRoutes)('POST %s のAuth Emulator統合', (path, flag, post, input, paidCall) => {
  function request(authorization?: string | null) {
    return new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization && { Authorization: authorization }),
      },
      body: JSON.stringify(input),
    })
  }

  it('実Admin SDKで検証できた要求だけが課金アダプターへ進む', async () => {
    vi.stubEnv(flag, 'true')
    const session = await createSession(`costly-${flag}`)
    const authorization = session.request.headers.get('authorization')
    const expired = withEmulatorClaims(session.request, { exp: 1 }).headers.get('authorization')

    async function expectRejected(incoming: Request, code: string) {
      const response = await post(incoming)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: { code, message: expect.any(String) } })
      expect(incoming.bodyUsed).toBe(false)
      for (const mock of Object.values(paidAdapters)) expect(mock).not.toHaveBeenCalled()
    }

    await expectRejected(request(), 'unauthenticated')
    await expectRejected(request('Bearer invalid.invalid.invalid'), 'invalid_token')
    await expectRejected(request(expired), 'token_expired')

    // 認証後の動作を確かめるため、最初の有料処理をモックで失敗させる。
    paidCall.mockRejectedValue(new Error('mocked provider failure'))
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await post(request(authorization))
    expect(response.status).toBe(502)
    expect(paidCall).toHaveBeenCalled()

    await getAdminAuth().revokeRefreshTokens(session.user.uid)
    // Emulatorの時刻粒度に依存せず、失効前に認証されたトークンとして検証する。
    const revoked = withEmulatorClaims(session.request, { auth_time: 1 }).headers.get(
      'authorization',
    )
    paidCall.mockClear()
    logs.mockClear()
    await expectRejected(request(revoked), 'session_revoked')
    expect(logs).not.toHaveBeenCalled()
  })
})
