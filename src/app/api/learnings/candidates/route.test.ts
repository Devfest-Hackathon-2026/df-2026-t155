import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '../../../../domain/samples'
import { POST } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const post = () =>
  new Request('http://localhost/api/learnings/candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trip: sampleTrip, revisions: [], feedback: '昼食後は休みたかった' }),
  })

// ネットワークへ出る呼び出しがあれば失敗させる（Geminiへ到達しないことの確認）。
const forbidNetwork = () => {
  const fetchFn = vi.fn(async () => {
    throw new Error('ネットワークへの接続は許可されていません')
  })
  vi.stubGlobal('fetch', fetchFn)
  return fetchFn
}

describe('POST /api/learnings/candidates（実際のRoute）', () => {
  it('機能フラグが未設定なら、Geminiを呼ばずに503を返す', async () => {
    vi.stubEnv('LEARNING_CANDIDATES_ENABLED', '')
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'some-project')
    const fetchFn = forbidNetwork()

    const response = await POST(post())

    expect(response.status).toBe(503)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('有効でもGeminiの接続設定が無ければ、通信せずに502を返す', async () => {
    vi.stubEnv('LEARNING_CANDIDATES_ENABLED', 'true')
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchFn = forbidNetwork()

    const response = await POST(post())

    expect(response.status).toBe(502)
    expect((await response.json()).status).toBe('external_service_error')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
