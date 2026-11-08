import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../../../tests/helpers/mock-cost-control'

import type { GenerateTripRequest } from '@/domain'
import { requestTripGeneration } from '@/features/trip-planner/api-client'
import { GeminiCallError } from '@/server/gemini/client'

import { POST } from './route'

const gemini = vi.hoisted(() => ({ generateJson: vi.fn() }))

vi.mock('@/server/gemini/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/gemini/client')>()),
  createLazyVertexGeminiClient: () => gemini,
}))

// This flow test exercises authenticated requests; dedicated tests verify the guard itself.
vi.mock('@/lib/firebase/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/firebase/admin')>()),
  getAdminAuth: () => ({ verifyIdToken: async () => ({ uid: 'test-actor' }) }),
}))

const request: GenerateTripRequest = {
  date: '2026-11-08',
  region: '京都',
  timeZone: 'Asia/Tokyo',
  preferences: [],
  fixedStops: [
    {
      id: 'fixed-morning',
      name: '固定の庭園',
      kind: 'sight',
      placeId: 'client-claimed-place',
      plannedStartTime: '10:00',
      durationMinutes: 60,
      isFixed: true,
      evidence: [
        {
          id: 'claimed-evidence',
          subject: 'place_identity',
          claim: '施設の同定',
          applicability: '入力者の申告',
          source: { kind: 'places', label: '自己申告' },
          checkedAt: '2026-11-01T12:00:00+09:00',
          status: 'consistent',
          explanation: '入力者による申告',
        },
      ],
    },
  ],
  learnings: [],
}

const draft = (nextStart: string) => ({
  failure: null,
  stops: [
    {
      fixedStopId: 'fixed-morning',
      name: 'AIの改名',
      plannedStartTime: '09:00',
      durationMinutes: 10,
    },
    { fixedStopId: null, name: '昼食', plannedStartTime: nextStart, durationMinutes: 60 },
    { fixedStopId: null, name: '散歩', plannedStartTime: '14:00', durationMinutes: 60 },
  ],
  learningApplications: [],
})

async function runFlow() {
  let status = 0
  let body: unknown
  let url: string | undefined
  let method: string | undefined
  const fetchFn: typeof fetch = async (input, init) => {
    url = String(input)
    method = init?.method
    const headers = new Headers(init?.headers)
    const response = await POST(
      new Request(new URL(String(input), 'http://localhost'), { ...init, headers }),
    )
    status = response.status
    body = await response.clone().json()
    return response
  }
  const result = await requestTripGeneration(request, {
    fetchFn,
    getHeaders: async () =>
      new Headers({
        Authorization: 'Bearer test.id.token',
        'X-Firebase-AppCheck': 'test.app.check',
      }),
  })
  expect(url).toBe('/api/trips/generate')
  expect(method).toBe('POST')
  return { status, body, result }
}

describe('旅程生成のRouteからクライアントまで', () => {
  beforeEach(() => {
    vi.stubEnv('TRIP_GENERATION_ENABLED', 'true')
    gemini.generateJson.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('固定予定を復元した結果の衝突を候補なしとして返す', async () => {
    gemini.generateJson.mockResolvedValue(JSON.stringify(draft('10:30')))
    // AIの時刻のまま衝突を検証すると、この下書きは誤って通る。
    const { status, body, result } = await runFlow()

    expect(status).toBe(422)
    expect(body).toMatchObject({
      status: 'no_candidates',
      message: expect.stringContaining('時刻が重なっている'),
    })
    expect(body).not.toHaveProperty('trip')
    expect(result).toMatchObject({ ok: false, failure: { kind: 'no_candidates' } })
    expect(gemini.generateJson).toHaveBeenCalledTimes(1)
  })

  it('固定予定を入力どおり復元し、自己申告の根拠を未照合にする', async () => {
    gemini.generateJson.mockResolvedValue(JSON.stringify(draft('11:30')))
    const { status, body, result } = await runFlow()

    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'proposed' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('旅程の提案を期待しました')
    // 固定予定をAIの値で上書きしたり、入力の根拠を信用したりする変更を検出する。
    expect(result.trip.stops[0]).toMatchObject({
      id: 'fixed-morning',
      name: '固定の庭園',
      kind: 'sight',
      plannedStartTime: '10:00',
      durationMinutes: 60,
      isFixed: true,
    })
    for (const stop of result.trip.stops) {
      expect(stop.placeId).toBeNull()
      expect(stop.evidence).toEqual([])
    }
    expect(body).toMatchObject({ trip: result.trip })
    expect(gemini.generateJson).toHaveBeenCalledTimes(1)
  })

  it('Geminiの失敗を502と外部サービス失敗で伝え、内部情報を隠す', async () => {
    gemini.generateJson.mockRejectedValue(new GeminiCallError('api_error', 'dummy-secret-value'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status, body, result } = await runFlow()

    expect(status).toBe(502)
    expect(body).toMatchObject({ status: 'external_service_error' })
    expect(body).not.toHaveProperty('trip')
    expect(result).toMatchObject({ ok: false, failure: { kind: 'external_service_error' } })
    expect(JSON.stringify({ body, result, logs: log.mock.calls })).not.toContain(
      'dummy-secret-value',
    )
    expect(gemini.generateJson).toHaveBeenCalledTimes(1)
  })
})
