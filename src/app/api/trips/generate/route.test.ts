import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../../../../tests/helpers/mock-cost-control'

import { sampleGenerateTripRequest } from '../../../../domain/samples'
import { POST } from './route'

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: async () => ({ uid: 'test-actor' }) }),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const post = () =>
  new Request('http://localhost/api/trips/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test.id.token' },
    body: JSON.stringify(sampleGenerateTripRequest),
  })

// ネットワークへ出る呼び出しがあれば失敗させる（Geminiへ到達しないことの確認）。
const forbidNetwork = () => {
  const fetchFn = vi.fn(async () => {
    throw new Error('ネットワークへの接続は許可されていません')
  })
  vi.stubGlobal('fetch', fetchFn)
  return fetchFn
}

describe('POST /api/trips/generate（実際のRoute）', () => {
  it('機能フラグが未設定なら、Geminiを呼ばずに503を返す', async () => {
    vi.stubEnv('TRIP_GENERATION_ENABLED', '')
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'some-project')
    const fetchFn = forbidNetwork()

    const response = await POST(post())

    expect(response.status).toBe(503)
    expect((await response.json()).status).toBe('service_unavailable')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("'true'以外の値（例: 'false'）でも無効", async () => {
    vi.stubEnv('TRIP_GENERATION_ENABLED', 'false')
    const fetchFn = forbidNetwork()

    expect((await POST(post())).status).toBe(503)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('有効でもGeminiの接続設定（プロジェクトID）が無ければ、通信せずに502を返す', async () => {
    vi.stubEnv('TRIP_GENERATION_ENABLED', 'true')
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchFn = forbidNetwork()

    const response = await POST(post())

    expect(response.status).toBe(502)
    expect((await response.json()).status).toBe('external_service_error')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
