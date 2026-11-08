import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createCustomToken, getUser, verifyToken, isDemoAuthPolicyConfigured } = vi.hoisted(() => ({
  createCustomToken: vi.fn(),
  getUser: vi.fn(),
  verifyToken: vi.fn(),
  isDemoAuthPolicyConfigured: vi.fn(),
}))
vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ createCustomToken, getUser }),
  getAdminAppCheck: () => ({ verifyToken }),
}))

vi.mock('@/server/demo-auth-policy', () => ({ isDemoAuthPolicyConfigured }))

const origin = 'https://groundtrip-example.hosted.app'
const ticket = 'a'.repeat(43)
const uid = 'test-demo-uid'
const config = {
  sha256: createHash('sha256').update(ticket).digest('hex'),
  uid,
  expiresAt: '2035-01-01T00:00:00Z',
  revoked: false,
}
let exchange: typeof import('./route').POST

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('DEMO_ACCESS_ENABLED', 'true')
  vi.stubEnv('DEMO_ACCESS_ORIGIN', origin)
  vi.stubEnv('DEMO_ACCESS_TICKET', JSON.stringify(config))
  vi.stubEnv('COSTLY_API_INVITED_UIDS', JSON.stringify([uid]))
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'test-app')
  isDemoAuthPolicyConfigured.mockResolvedValue(true)
  getUser.mockResolvedValue({ uid, disabled: false, providerData: [] })
  createCustomToken.mockResolvedValue('test.custom.token')
  verifyToken.mockResolvedValue({ appId: 'test-app' })
  exchange = (await import('./route')).POST
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function request(body = ticket, headers?: Record<string, string>) {
  return new Request(`${origin}/api/access/exchange`, {
    method: 'POST',
    body,
    headers: {
      Origin: origin,
      'Content-Type': 'text/plain',
      'X-Firebase-AppCheck': 'test.app.check',
      ...headers,
    },
  })
}

describe('アクセス券交換API', () => {
  it('App Hostingへ直接POSTし、招待済みの設定UIDだけのトークンを返す', async () => {
    const response = await exchange(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ customToken: 'test.custom.token' })
    expect(verifyToken).toHaveBeenCalledExactlyOnceWith('test.app.check')
    expect(getUser).toHaveBeenCalledExactlyOnceWith(uid)
    expect(createCustomToken).toHaveBeenCalledExactlyOnceWith(uid)
    expect(verifyToken).toHaveBeenCalledBefore(getUser)
    expect(getUser).toHaveBeenCalledBefore(createCustomToken)
  })

  it.each<[string, { body?: string; invited?: string; expiresAt?: string; revoked?: boolean }]>([
    ['不正な券', { body: 'x'.repeat(43) }],
    ['期限切れ', { expiresAt: '2000-01-01T00:00:00Z' }],
    ['失効済み', { revoked: true }],
    ['招待から除外', { invited: '[]' }],
  ])('%sをSDKへ渡さず同じ403で拒否する', async (_, { body, invited, ...overrides }) => {
    vi.stubEnv('DEMO_ACCESS_TICKET', JSON.stringify({ ...config, ...overrides }))
    if (invited) vi.stubEnv('COSTLY_API_INVITED_UIDS', invited)
    const response = await exchange(request(body))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ status: 'denied' })
    expect(verifyToken).not.toHaveBeenCalled()
    expect(getUser).not.toHaveBeenCalled()
    expect(createCustomToken).not.toHaveBeenCalled()
  })

  it.each([
    ['フラグ無効', 'DEMO_ACCESS_ENABLED', 'false'],
    ['券設定の破損', 'DEMO_ACCESS_TICKET', 'malformed'],
    ['招待設定の破損', 'COSTLY_API_INVITED_UIDS', 'malformed'],
  ])('%sの場合に安全側へ停止する', async (_, variable, value) => {
    vi.stubEnv(variable, value)
    expect((await exchange(request())).status).toBe(503)
    expect(verifyToken).not.toHaveBeenCalled()
    expect(createCustomToken).not.toHaveBeenCalled()
  })

  it.each([
    [{ Origin: 'https://other.example' }, 403],
    [{ 'Content-Type': 'application/json' }, 415],
  ])('Originと媒体型をSDKの前で確認する', async (headers, status) => {
    expect((await exchange(request(ticket, headers))).status).toBe(status)
    expect(verifyToken).not.toHaveBeenCalled()
    expect(createCustomToken).not.toHaveBeenCalled()
  })

  it('宣言された本文サイズが上限を超えていれば読み取る前に拒否する', async () => {
    const incoming = request(ticket, { 'Content-Length': '2048' })
    expect((await exchange(incoming)).status).toBe(413)
    expect(incoming.bodyUsed).toBe(false)
    expect(verifyToken).not.toHaveBeenCalled()
    expect(getUser).not.toHaveBeenCalled()
  })

  it('本文の上限を検証し、SDKを呼ばない', async () => {
    expect((await exchange(request('x'.repeat(2048)))).status).toBe(413)
    expect(verifyToken).not.toHaveBeenCalled()
  })

  it('異なるアプリ、欠落、無効なApp Checkを拒否する', async () => {
    expect((await exchange(request(ticket, { 'X-Firebase-AppCheck': '' }))).status).toBe(403)
    verifyToken.mockResolvedValueOnce({ appId: 'other-app' })
    expect((await exchange(request())).status).toBe(403)
    verifyToken.mockRejectedValueOnce({ code: 'app-check/invalid-argument' })
    expect((await exchange(request())).status).toBe(403)
    expect(getUser).not.toHaveBeenCalled()
    expect(createCustomToken).not.toHaveBeenCalled()
  })

  it('App Check障害を秘匿し、署名しない', async () => {
    verifyToken.mockRejectedValue({ cause: { code: 'key-fetch-error' }, message: ticket })
    const response = await exchange(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'unavailable' })
    expect(createCustomToken).not.toHaveBeenCalled()
  })

  it('対象UIDが無効、存在しない、または一致しなければ署名しない', async () => {
    getUser.mockResolvedValueOnce({ uid, disabled: true })
    getUser.mockRejectedValueOnce({ code: 'auth/user-not-found' })
    getUser.mockResolvedValueOnce({ uid: 'different', disabled: false })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await exchange(request())).status).toBe(403)
    }
    expect(createCustomToken).not.toHaveBeenCalled()
  })

  it('Auth/IAM障害を秘匿する', async () => {
    getUser.mockRejectedValueOnce(new Error(ticket))
    createCustomToken.mockRejectedValueOnce(new Error(ticket))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await exchange(request())
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'unavailable' })
    }
  })

  it('同時枠を超える要求をSDKに渡さない', async () => {
    const gate = Promise.withResolvers<string>()
    createCustomToken.mockReturnValue(gate.promise)
    const first = exchange(request())
    const second = exchange(request())
    try {
      const rejected = await exchange(request())
      expect(rejected.status).toBe(429)
      expect(rejected.headers.get('Retry-After')).toBe('60')
    } finally {
      gate.resolve('test.custom.token')
      expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([
        200, 200,
      ])
    }
    expect(createCustomToken).toHaveBeenCalledTimes(2)
  })

  it('署名のタイムアウト後もSDKが終了するまで同時枠を保持する', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<string>()
    createCustomToken.mockReturnValue(gate.promise)
    const first = exchange(request())
    const second = exchange(request())
    await vi.advanceTimersByTimeAsync(8000)
    expect((await first).status).toBe(503)
    expect((await second).status).toBe(503)
    expect((await exchange(request())).status).toBe(429)
    expect(createCustomToken).toHaveBeenCalledTimes(2)
    gate.resolve('test.custom.token')
    await vi.advanceTimersByTimeAsync(0)
    expect((await exchange(request())).status).toBe(200)
  })

  it('App Checkの通信が残る場合も同時枠を維持し、締切後は署名しない', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<{ appId: string }>()
    verifyToken.mockReturnValue(gate.promise)
    const first = exchange(request())
    const second = exchange(request())
    await vi.advanceTimersByTimeAsync(8000)
    expect((await first).status).toBe(503)
    expect((await second).status).toBe(503)
    expect((await exchange(request())).status).toBe(429)
    expect(verifyToken).toHaveBeenCalledTimes(2)
    gate.resolve({ appId: 'test-app' })
    await vi.advanceTimersByTimeAsync(0)
    expect(getUser).not.toHaveBeenCalled()
    expect(createCustomToken).not.toHaveBeenCalled()
    expect((await exchange(request())).status).toBe(200)
  })

  it('不正券を連投されてもインスタンス内の署名枠を消費しない', async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      expect((await exchange(request('x'.repeat(43)))).status).toBe(403)
    }
    expect(verifyToken).not.toHaveBeenCalled()
    expect((await exchange(request())).status).toBe(200)
  })

  it('照合できた券の繰り返しはインスタンス内で制限する', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await exchange(request())).status).toBe(200)
    }
    expect((await exchange(request())).status).toBe(429)
    expect(createCustomToken).toHaveBeenCalledTimes(12)
  })

  it('自己削除禁止の設定が確認できない場合は署名しない', async () => {
    isDemoAuthPolicyConfigured.mockResolvedValue(false)
    expect((await exchange(request())).status).toBe(503)
    expect(createCustomToken).not.toHaveBeenCalled()
  })

  it('ログイン情報が連携済みのUIDへ発行しない', async () => {
    getUser.mockResolvedValue({
      uid,
      disabled: false,
      providerData: [{ providerId: 'google.com' }],
    })
    expect((await exchange(request())).status).toBe(403)
    expect(createCustomToken).not.toHaveBeenCalled()
  })
})
