import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleReviseTripRequest } from '@/domain/samples'
import { COSTS } from '@/server/cost-control/costs'
import { PersistenceError } from '@/server/persistence/errors'
import { FirestoreTripStore } from '@/server/persistence/trips'

import { POST as apply } from './trips/[tripId]/revisions/[revisionId]/apply/route'
import {
  GET as getReport,
  POST as resolveReport,
} from './trips/[tripId]/revision-reports/[stopId]/route'
import { POST as revise } from './trips/revise/route'

// 部分修正の3経路（生成・適用・本人報告）が、課金・保存の共通の保護を通ることの検証。
// 招待外UID・App Check拒否・機能停止・利用枠の拒否で、Gemini・Maps・業務DBへ進まないことを確かめる。
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
  getAdminFirestore: () => ({}),
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
const authHeader = `Bearer ${token}`
const write = vi.fn()
const tripContext = { params: Promise.resolve({ tripId: 'trip-1', revisionId: 'revision-1' }) }
const reportContext = { params: Promise.resolve({ tripId: 'trip-1', stopId: 'stop-1' }) }

// 業務DBに触れる保存層。拒否された要求で呼ばれないことを確かめる。
const store = {} as {
  prepare: ReturnType<typeof vi.spyOn>
  apply: ReturnType<typeof vi.spyOn>
  report: ReturnType<typeof vi.spyOn>
  resolve: ReturnType<typeof vi.spyOn>
}

interface Case {
  name: string
  flags: Record<string, string>
  // 無効にすると、認証より前に停止するフラグ。保存の有無だけを切り替えるフラグは含めない。
  stopFlags: string[]
  cost: object
  body: unknown
  method: 'GET' | 'POST'
  call: (request: Request) => Promise<Response>
  // 保存層の入口。成功経路で、予約の後に呼ばれる。
  entry: () => ReturnType<typeof vi.fn>
}

const cases: Case[] = [
  {
    name: 'POST /api/trips/revise（保存有効）',
    flags: { TRIP_REVISION_ENABLED: 'true', PERSISTENCE_ENABLED: 'true' },
    stopFlags: ['TRIP_REVISION_ENABLED'],
    cost: COSTS.reviseWithReports,
    body: sampleReviseTripRequest,
    method: 'POST',
    call: revise,
    entry: () => store.prepare,
  },
  {
    name: 'POST .../revisions/{revisionId}/apply',
    flags: { TRIP_REVISION_APPLY_ENABLED: 'true', PERSISTENCE_ENABLED: 'true' },
    stopFlags: ['TRIP_REVISION_APPLY_ENABLED', 'PERSISTENCE_ENABLED'],
    cost: COSTS.applyRevision,
    body: { expectedVersion: 0, confirm: true },
    method: 'POST',
    call: (request) => apply(request, tripContext),
    entry: () => store.apply,
  },
  {
    name: 'GET .../revision-reports/{stopId}',
    flags: { PERSISTENCE_ENABLED: 'true' },
    stopFlags: ['PERSISTENCE_ENABLED'],
    cost: COSTS.getRevisionReport,
    body: undefined,
    method: 'GET',
    call: (request) => getReport(request, reportContext),
    entry: () => store.report,
  },
  {
    name: 'POST .../revision-reports/{stopId}',
    flags: { PERSISTENCE_ENABLED: 'true' },
    stopFlags: ['PERSISTENCE_ENABLED'],
    cost: COSTS.resolveRevisionReport,
    body: { expectedVersion: 0, expectedReportVersion: 0, confirm: true },
    method: 'POST',
    call: (request) => resolveReport(request, reportContext),
    entry: () => store.resolve,
  },
]

beforeEach(() => {
  vi.resetAllMocks()
  store.prepare = vi.spyOn(FirestoreTripStore.prototype, 'prepareRevisionGeneration')
  store.apply = vi.spyOn(FirestoreTripStore.prototype, 'applyRevision')
  store.report = vi.spyOn(FirestoreTripStore.prototype, 'revisionReport')
  store.resolve = vi.spyOn(FirestoreTripStore.prototype, 'resolveRevisionReport')
  verifyIdToken.mockResolvedValue({ uid: 'verified-uid' })
  verifyAppCheck.mockResolvedValue({ appId: 'test-app' })
  reserveCost.mockResolvedValue({
    kind: 'allowed',
    workAvailableMs: 150_000,
    release: async () => undefined,
    revokeWrite: async () => undefined,
    write,
  })
  store.prepare.mockRejectedValue(new PersistenceError('version_conflict'))
  store.apply.mockRejectedValue(new PersistenceError('version_conflict'))
  store.report.mockRejectedValue(new PersistenceError('version_conflict'))
  store.resolve.mockRejectedValue(new PersistenceError('version_conflict'))
  vi.stubEnv('COSTLY_API_INVITED_UIDS', '["verified-uid"]')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'test-app')
  vi.stubEnv('COSTLY_API_DEMO_ENABLED', '')
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

describe.each(cases)('$name の保護', (entry) => {
  const { flags, stopFlags, cost, body, method, call } = entry

  function enable(except?: string) {
    for (const [name, value] of Object.entries(flags)) {
      vi.stubEnv(name, name === except ? 'false' : value)
    }
  }

  function request(authorization: string | undefined = authHeader, text?: string) {
    return new Request('http://localhost/api/trips/trip-1', {
      method,
      headers: {
        'X-Firebase-AppCheck': 'test.app.check',
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      ...(body === undefined ? {} : { body: text ?? JSON.stringify(body) }),
    })
  }

  // 拒否された要求は、予約も下流（Gemini・Maps・業務DB）も呼ばない。
  function expectNoDownstream() {
    expect(generateJson).not.toHaveBeenCalled()
    expect(searchPlaces).not.toHaveBeenCalled()
    expect(computeRoute).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    for (const spy of Object.values(store)) expect(spy).not.toHaveBeenCalled()
  }

  it.each(stopFlags)('機能フラグ %s が無効なら認証も予約もせず停止する', async (name) => {
    enable(name)
    const incoming = request(authHeader, '{broken')
    const response = await call(incoming)

    expect(response.status).toBe(503)
    expect(verifyIdToken).not.toHaveBeenCalled()
    expect(reserveCost).not.toHaveBeenCalled()
    if (body !== undefined) expect(incoming.bodyUsed).toBe(false)
    expectNoDownstream()
  })

  it('本番では共通のデモフラグがない間、フラグを有効にしても停止する', async () => {
    enable()
    vi.stubEnv('NODE_ENV', 'production')
    const response = await call(request())

    expect(response.status).toBe(503)
    expect(verifyIdToken).not.toHaveBeenCalled()
    expect(reserveCost).not.toHaveBeenCalled()
    expectNoDownstream()
  })

  it.each([undefined, 'Bearer invalid'])('Bearerがなければ認証失敗 (%s)', async (authorization) => {
    enable()
    verifyIdToken.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'auth/invalid-id-token' }),
    )
    const response = await call(request(authorization ?? ''))

    expect(response.status).toBe(401)
    expect(reserveCost).not.toHaveBeenCalled()
    expectNoDownstream()
  })

  it('招待されていないUIDは、App Check・予約・下流に進まない', async () => {
    enable()
    verifyIdToken.mockResolvedValue({ uid: 'uninvited' })
    const response = await call(request())

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'invite_required' } })
    expect(verifyAppCheck).not.toHaveBeenCalled()
    expect(reserveCost).not.toHaveBeenCalled()
    expectNoDownstream()
  })

  it.each([
    ['missing', 403, 'app_check_invalid'],
    ['wrong_app', 403, 'app_check_invalid'],
    ['outage', 503, 'app_check_unavailable'],
  ])('App Check拒否 %s では予約も下流もない', async (kind, status, code) => {
    enable()
    const incoming = request()
    if (kind === 'missing') incoming.headers.delete('X-Firebase-AppCheck')
    if (kind === 'wrong_app') verifyAppCheck.mockResolvedValue({ appId: 'other-app' })
    if (kind === 'outage') {
      verifyAppCheck.mockRejectedValue({
        code: 'app-check/invalid-argument',
        cause: { code: 'key-fetch-error' },
      })
    }
    const response = await call(incoming)

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(reserveCost).not.toHaveBeenCalled()
    expectNoDownstream()
  })

  it.each([
    [{ kind: 'limited', scope: 'uid' }, 429, 'uid_limit'],
    [{ kind: 'limited', scope: 'global' }, 429, 'global_limit'],
    [{ kind: 'unavailable' }, 503, 'protection_unavailable'],
  ])('利用枠の拒否 %j では下流に進まない', async (admission, status, code) => {
    enable()
    reserveCost.mockResolvedValue(admission)
    const response = await call(request())

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(reserveCost).toHaveBeenCalledExactlyOnceWith('verified-uid', cost)
    expectNoDownstream()
  })

  it('予約の例外では、機密情報を出さず下流に進まない', async () => {
    enable()
    reserveCost.mockRejectedValue(new Error('private SDK diagnostics'))
    const response = await call(request())

    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private SDK diagnostics')
    expectNoDownstream()
  })

  it('許可された後だけ、同じ予約量で保存層の入口に進む', async () => {
    enable()
    generateJson.mockRejectedValue(new Error('stop after reservation'))
    const response = await call(request())

    expect(reserveCost).toHaveBeenCalledExactlyOnceWith('verified-uid', cost)
    expect(verifyAppCheck).toHaveBeenCalledBefore(reserveCost)
    expect(reserveCost).toHaveBeenCalledBefore(entry.entry())
    expect(entry.entry()).toHaveBeenCalledTimes(1)
    // 保存層の失敗（版の不一致）は409。予約の後なので、Mapsを呼ぶ前に止まる。
    expect(response.status).toBe(409)
    expect(searchPlaces).not.toHaveBeenCalled()
    expect(computeRoute).not.toHaveBeenCalled()
    expect(generateJson).not.toHaveBeenCalled()
  })
})

describe('保存層に渡す書き込み権', () => {
  const headers = {
    Authorization: authHeader,
    'X-Firebase-AppCheck': 'test.app.check',
    'Content-Type': 'application/json',
  }

  it('本人報告の記録・解消は、予約した操作の書き込み権（write）で確定する', async () => {
    vi.stubEnv('TRIP_REVISION_ENABLED', 'true')
    vi.stubEnv('PERSISTENCE_ENABLED', 'true')
    vi.stubEnv('COSTLY_API_DEMO_ENABLED', '')
    const body = JSON.stringify({ expectedVersion: 0, expectedReportVersion: 0, confirm: true })
    store.prepare.mockRejectedValue(new PersistenceError('version_conflict'))
    store.resolve.mockRejectedValue(new PersistenceError('version_conflict'))
    await revise(
      new Request('http://localhost/api/trips/revise', {
        method: 'POST',
        headers,
        body: JSON.stringify(sampleReviseTripRequest),
      }),
    )
    await resolveReport(
      new Request('http://localhost/api', { method: 'POST', headers, body }),
      reportContext,
    )

    // 保存層に渡るのは操作の `write` であり、素のFirestoreクライアントではない。
    expect(store.prepare.mock.calls[0][2]).toBeTypeOf('function')
    expect(store.resolve.mock.calls[0][4]).toBeTypeOf('function')
  })

  it('適用は、書き込み権と中断確認を持つ操作を受け取る', async () => {
    vi.stubEnv('TRIP_REVISION_APPLY_ENABLED', 'true')
    vi.stubEnv('PERSISTENCE_ENABLED', 'true')
    await apply(
      new Request('http://localhost/api', {
        method: 'POST',
        headers,
        body: JSON.stringify({ expectedVersion: 0, confirm: true }),
      }),
      tripContext,
    )

    const guard = store.apply.mock.calls[0][5]
    expect(guard).toMatchObject({ write: expect.any(Function), assertActive: expect.any(Function) })
  })
})

describe('保存を無効にした生成', () => {
  it('保存の読み書きを予約に含めず、生成の予約量だけで進む', async () => {
    vi.stubEnv('TRIP_REVISION_ENABLED', 'true')
    vi.stubEnv('PERSISTENCE_ENABLED', 'false')
    generateJson.mockRejectedValue(new Error('stop after reservation'))
    await revise(
      new Request('http://localhost/api/trips/revise', {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'X-Firebase-AppCheck': 'test.app.check',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReviseTripRequest),
      }),
    )

    expect(reserveCost).toHaveBeenCalledExactlyOnceWith('verified-uid', COSTS.revise)
    expect(store.prepare).not.toHaveBeenCalled()
  })
})
