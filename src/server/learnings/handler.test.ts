import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../../tests/helpers/mock-cost-control'

import { sampleLearning, sampleRevision, sampleTrip } from '../../domain/samples'
import {
  MAX_LEARNING_REQUEST_BYTES,
  handleLearningCandidatesRequest,
  isLearningCandidatesEnabled,
} from './handler'
import type { LearningCandidatesResponse } from './generate-candidates'

// トークンの検証は実際のRouteテストで確認し、ここでは認証済みのHTTP処理を検証する。
vi.mock('../costly-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../costly-api')>()),
  requireCostlyApiActor: async () => ({ uid: 'test-actor' }),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

const validInput = { trip: sampleTrip, revisions: [], feedback: '昼食後は休みたかった' }
const proposed: LearningCandidatesResponse = { status: 'proposed', learnings: [sampleLearning] }

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/learnings/candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })

const setup = (response: LearningCandidatesResponse = proposed, enabled = true) => {
  const generate = vi.fn().mockResolvedValue(response)
  return { generate, deps: { isEnabled: () => enabled, generate } }
}

describe('POST /api/learnings/candidates', () => {
  it('入力を検証し、未承認の学びの候補を200で返す', async () => {
    const { generate, deps } = setup()
    const response = await handleLearningCandidatesRequest(post(JSON.stringify(validInput)), deps)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json()
    expect(body.status).toBe('proposed')
    expect(body.learnings[0].approval).toEqual({ status: 'pending' })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no_candidates', 422],
    ['insufficient_information', 422],
    ['external_service_error', 502],
  ] as const)('失敗 %s はHTTP %i で返す', async (status, httpStatus) => {
    const { deps } = setup({ status, message: '説明' })
    const response = await handleLearningCandidatesRequest(post(JSON.stringify(validInput)), deps)

    expect(response.status).toBe(httpStatus)
    expect(await response.json()).toEqual({ status, message: '説明' })
  })

  it('機能フラグが無効なら503を返し、AIも本文の読み取りもしない', async () => {
    const { generate, deps } = setup(proposed, false)
    const request = post(JSON.stringify(validInput))
    const response = await handleLearningCandidatesRequest(request, deps)

    expect(response.status).toBe(503)
    expect((await response.json()).status).toBe('service_unavailable')
    expect(generate).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
  })

  it.each([undefined, '', 'false', '1', 'TRUE'])(
    'LEARNING_CANDIDATES_ENABLED=%s は無効として扱う',
    (value) => {
      expect(isLearningCandidatesEnabled({ LEARNING_CANDIDATES_ENABLED: value })).toBe(false)
      expect(isLearningCandidatesEnabled({ LEARNING_CANDIDATES_ENABLED: 'true' })).toBe(true)
    },
  )

  it('JSON以外のContent-Typeは415', async () => {
    const { generate, deps } = setup()
    const response = await handleLearningCandidatesRequest(
      post(JSON.stringify(validInput), { 'Content-Type': 'text/plain' }),
      deps,
    )

    expect(response.status).toBe(415)
    expect(generate).not.toHaveBeenCalled()
  })

  it.each([
    ['JSONでない本文', '{壊れた'],
    ['空の本文', ''],
    ['必須項目なし', JSON.stringify({ feedback: '感想' })],
    [
      '別の旅程の変更履歴',
      JSON.stringify({ ...validInput, revisions: [{ ...sampleRevision, tripId: 'trip-other' }] }),
    ],
    ['未知のキー', JSON.stringify({ ...validInput, owner: 'someone' })],
  ])('不正な入力（%s）は400で、AIを呼ばない', async (_name, body) => {
    const { generate, deps } = setup()
    const response = await handleLearningCandidatesRequest(post(body), deps)

    expect(response.status).toBe(400)
    expect((await response.json()).status).toBe('invalid_request')
    expect(generate).not.toHaveBeenCalled()
  })

  it('本文が上限を超える場合は413（本文を読み切らずに拒否する）', async () => {
    const { generate, deps } = setup()
    const huge = JSON.stringify({
      ...validInput,
      feedback: 'あ'.repeat(MAX_LEARNING_REQUEST_BYTES),
    })
    const response = await handleLearningCandidatesRequest(post(huge), deps)

    expect(response.status).toBe(413)
    expect(generate).not.toHaveBeenCalled()
  })

  it('生成処理が例外を投げたら500とし、内容を応答に含めない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generate = vi.fn().mockRejectedValue(new Error('Bearer dummy-secret'))
    const response = await handleLearningCandidatesRequest(post(JSON.stringify(validInput)), {
      isEnabled: () => true,
      generate,
    })

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('dummy-secret')
  })

  it('承認済みの学びを含む応答は、契約違反として返さない（500）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const approved = {
      ...sampleLearning,
      approval: { status: 'approved' as const, decidedAt: '2026-11-08T20:00:00+09:00' },
    }
    const { deps } = setup({ status: 'proposed', learnings: [approved] })
    const response = await handleLearningCandidatesRequest(post(JSON.stringify(validInput)), deps)

    expect(response.status).toBe(500)
  })

  it('学びが4件以上の応答は、契約違反として返さない（500）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const four = Array.from({ length: 4 }, (_, index) => ({ ...sampleLearning, id: `l-${index}` }))
    const { deps } = setup({ status: 'proposed', learnings: four })

    expect(
      (await handleLearningCandidatesRequest(post(JSON.stringify(validInput)), deps)).status,
    ).toBe(500)
  })
})
