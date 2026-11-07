import { describe, expect, it, vi } from 'vitest'

import { sampleLearning, sampleTrip } from '@/domain/samples'

import { LEARNING_CANDIDATES_ENDPOINT, requestLearningCandidates } from './api-client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const request = { trip: sampleTrip, revisions: [], feedback: '昼食後は休みたかった' }

describe('requestLearningCandidates', () => {
  it('未承認の候補を受け取る', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ status: 'proposed', learnings: [sampleLearning] }))
    const result = await requestLearningCandidates(request, { fetchFn })

    expect(result).toEqual({ ok: true, learnings: [sampleLearning] })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(LEARNING_CANDIDATES_ENDPOINT)
    expect(init.method).toBe('POST')
  })

  it('承認済みとして返ってきた学びは採用しない（本人の承認なしに受け入れない）', async () => {
    const approved = {
      ...sampleLearning,
      approval: { status: 'approved', decidedAt: '2026-11-08T10:00:00+09:00' },
    }
    const fetchFn = vi.fn().mockResolvedValue(json({ status: 'proposed', learnings: [approved] }))
    expect(await requestLearningCandidates(request, { fetchFn })).toMatchObject({
      ok: false,
      failure: { kind: 'unexpected' },
    })
  })

  it('同じIDの候補が含まれていれば、全体を採用しない（承認の操作が、意図しない候補に作用するため）', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ status: 'proposed', learnings: [sampleLearning, sampleLearning] }))

    expect(await requestLearningCandidates(request, { fetchFn })).toMatchObject({
      ok: false,
      failure: { kind: 'unexpected' },
    })
  })

  it('4件以上・0件の候補は採用しない', async () => {
    for (const count of [0, 4]) {
      const learnings = Array.from({ length: count }, (_, i) => ({
        ...sampleLearning,
        id: `learning-${i}`,
      }))
      const fetchFn = vi.fn().mockResolvedValue(json({ status: 'proposed', learnings }))
      expect(await requestLearningCandidates(request, { fetchFn })).toMatchObject({
        ok: false,
        failure: { kind: 'unexpected' },
      })
    }
  })

  it.each([
    ['no_candidates', 422],
    ['insufficient_information', 422],
    ['external_service_error', 502],
    ['service_unavailable', 503],
    ['invalid_request', 400],
    ['payload_too_large', 413],
  ] as const)('失敗 %s はHTTP %i のときだけ、その種類として扱う', async (status, httpStatus) => {
    const fetchFn = vi.fn().mockResolvedValue(json({ status, message: '説明' }, httpStatus))
    expect(await requestLearningCandidates(request, { fetchFn })).toEqual({
      ok: false,
      failure: { kind: status, message: '説明' },
    })
  })

  it('ステータスが食い違う失敗・proposedが200以外は想定外', async () => {
    const mismatch = vi.fn().mockResolvedValue(json({ status: 'no_candidates', message: 'x' }, 200))
    expect(await requestLearningCandidates(request, { fetchFn: mismatch })).toMatchObject({
      failure: { kind: 'unexpected' },
    })
    const wrongOk = vi
      .fn()
      .mockResolvedValue(json({ status: 'proposed', learnings: [sampleLearning] }, 201))
    expect(await requestLearningCandidates(request, { fetchFn: wrongOk })).toMatchObject({
      failure: { kind: 'unexpected' },
    })
  })

  it('JSONでない本文は想定外、接続失敗は中断', async () => {
    const html = vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }))
    expect(await requestLearningCandidates(request, { fetchFn: html })).toMatchObject({
      failure: { kind: 'unexpected' },
    })
    const down = vi.fn().mockRejectedValue(new TypeError('network'))
    expect(await requestLearningCandidates(request, { fetchFn: down })).toMatchObject({
      failure: { kind: 'interrupted' },
    })
  })
})
