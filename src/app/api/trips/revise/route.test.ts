import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleReviseTripRequest } from '../../../../domain/samples'
import { POST } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const post = () =>
  new Request('http://localhost/api/trips/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sampleReviseTripRequest),
  })

// ネットワークへ出る呼び出しがあれば失敗させる（GeminiやMapsへ到達しないことの確認）。
const forbidNetwork = () => {
  const fetchFn = vi.fn(async () => {
    throw new Error('ネットワークへの接続は許可されていません')
  })
  vi.stubGlobal('fetch', fetchFn)
  return fetchFn
}

describe('POST /api/trips/revise（実際のRoute）', () => {
  it('機能フラグが未設定なら、GeminiもMapsも呼ばずに503を返す', async () => {
    vi.stubEnv('TRIP_REVISION_ENABLED', '')
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'some-project')
    const fetchFn = forbidNetwork()

    const response = await POST(post())

    expect(response.status).toBe(503)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('有効でも接続設定が無ければ、通信せずに502を返し、更新後の旅程は返さない', async () => {
    vi.stubEnv('TRIP_REVISION_ENABLED', 'true')
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchFn = forbidNetwork()

    const response = await POST(post())

    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.status).toBe('external_service_error')
    expect(body).not.toHaveProperty('revisions')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
