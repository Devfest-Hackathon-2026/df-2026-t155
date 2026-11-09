import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../../../tests/helpers/mock-cost-control'

import { requestTripGeneration } from '@/features/trip-planner/api-client'
import { sampleApprovedLearning } from '@/domain/samples'
import { GeminiCallError } from '@/server/gemini/client'
import type { GenerateTripConditions } from '@/server/trip-generation/http-request'

import { POST } from './route'

const gemini = vi.hoisted(() => ({ generateJson: vi.fn() }))
// 保存済みの学び（サーバー側の正本）。選択の解決に使われる。
const store = vi.hoisted(() => ({ listVersionedApproved: vi.fn() }))

vi.mock('@/server/persistence/learnings', () => ({
  FirestoreLearningStore: class {
    listVersionedApproved = store.listVersionedApproved
  },
}))

vi.mock('@/server/gemini/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/gemini/client')>()),
  createLazyVertexGeminiClient: () => gemini,
}))

// This flow test exercises authenticated requests; dedicated tests verify the guard itself.
vi.mock('@/lib/firebase/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/firebase/admin')>()),
  getAdminAuth: () => ({ verifyIdToken: async () => ({ uid: 'test-actor' }) }),
}))

const request: GenerateTripConditions = {
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

// 学びの再利用：本文のlearningsは受け付けず、{ id, version } をサーバーが保存済みの現行版と照合して解決する。
describe('旅程生成のRoute：学びの選択', () => {
  const base = request
  const selection = { id: sampleApprovedLearning.id, version: 2 }

  const post = (body: unknown) =>
    POST(
      new Request('http://localhost/api/trips/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test.id.token',
          'X-Firebase-AppCheck': 'test.app.check',
        },
        body: JSON.stringify(body),
      }),
    )

  beforeEach(() => {
    vi.stubEnv('TRIP_GENERATION_ENABLED', 'true')
    gemini.generateJson.mockReset()
    store.listVersionedApproved.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('選択を本人（認証済みUID）の保存済みデータで解決し、その学びだけをGeminiへ渡す', async () => {
    store.listVersionedApproved.mockResolvedValue([
      { version: 2, learning: sampleApprovedLearning },
      {
        version: 1,
        learning: { ...sampleApprovedLearning, id: 'unselected', content: '選択していない学び' },
      },
    ])
    const explanation = '昼食の後に休憩を設けた。'
    gemini.generateJson.mockResolvedValue(
      JSON.stringify({
        ...draft('11:30'),
        learningApplications: [{ learningId: selection.id, stopIndexes: [1], explanation }],
      }),
    )

    const response = await post({ ...base, learningSelections: [selection] })

    expect(response.status).toBe(200)
    // UIDは本文ではなく検証済みトークンから取る。
    expect(store.listVersionedApproved).toHaveBeenCalledWith('test-actor')
    expect(gemini.generateJson).toHaveBeenCalledTimes(1)
    const { prompt } = gemini.generateJson.mock.calls[0][0]
    expect(JSON.parse(prompt.slice(prompt.indexOf('{'))).approvedLearnings).toEqual([
      {
        id: selection.id,
        category: sampleApprovedLearning.category,
        content: sampleApprovedLearning.content,
      },
    ])
    const { trip } = await response.json()
    expect(trip.learningApplications).toEqual([
      { learningId: selection.id, targetStopIds: [trip.stops[1].id], explanation },
    ])
  })

  it('本文に承認済みの学び（旧形式のlearnings）を付けても400。Geminiも保存先も呼ばない', async () => {
    const forged = { ...sampleApprovedLearning, content: '偽の学び（クライアント申告）' }
    const response = await post({ ...base, learningSelections: [], learnings: [forged] })

    expect(response.status).toBe(400)
    expect(gemini.generateJson).not.toHaveBeenCalled()
    expect(store.listVersionedApproved).not.toHaveBeenCalled()
  })

  it('版が現行と違えば409 selection_changed。Geminiを呼ばない', async () => {
    store.listVersionedApproved.mockResolvedValue([
      { version: 3, learning: sampleApprovedLearning },
    ])

    const response = await post({ ...base, learningSelections: [selection] })

    expect(response.status).toBe(409)
    expect((await response.json()).status).toBe('selection_changed')
    expect(gemini.generateJson).not.toHaveBeenCalled()
  })

  it('他人の学びのID（本人の一覧にない）は409。本文は返さない', async () => {
    store.listVersionedApproved.mockResolvedValue([])

    const response = await post({ ...base, learningSelections: [selection] })

    expect(response.status).toBe(409)
    expect(JSON.stringify(await response.json())).not.toContain(sampleApprovedLearning.content)
    expect(gemini.generateJson).not.toHaveBeenCalled()
  })

  it.each([
    ['未承認', { approval: { status: 'pending' } }, 503, 'learnings_unavailable'],
    ['適用範囲外', { scope: { kind: 'region', region: '奈良市' } }, 409, 'selection_changed'],
  ])('%sの学びを渡されても、Geminiを呼ばず失敗する', async (_case, patch, status, error) => {
    store.listVersionedApproved.mockResolvedValue([
      { version: 2, learning: { ...sampleApprovedLearning, ...patch } },
    ])

    const response = await post({ ...base, learningSelections: [selection] })

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ status: error })
    expect(gemini.generateJson).not.toHaveBeenCalled()
  })

  it('保存先の障害は503 learnings_unavailable（内部の詳細を含めない）。Geminiを呼ばない', async () => {
    store.listVersionedApproved.mockRejectedValue(new Error('firestore dummy-secret-value'))

    const response = await post({ ...base, learningSelections: [selection] })

    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).toContain('learnings_unavailable')
    expect(text).not.toContain('dummy-secret-value')
    expect(gemini.generateJson).not.toHaveBeenCalled()
  })

  it('選択が空なら保存先を読まず、学びなしで生成する', async () => {
    gemini.generateJson.mockResolvedValue(JSON.stringify(draft('11:30')))

    const response = await post({ ...base, learningSelections: [] })

    expect(response.status).toBe(200)
    expect(store.listVersionedApproved).not.toHaveBeenCalled()
  })
})
