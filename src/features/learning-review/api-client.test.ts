import { describe, expect, it, vi } from 'vitest'

import { sampleLearning, sampleTrip } from '@/domain/samples'

import { LEARNING_CANDIDATES_ENDPOINT, requestLearningCandidates } from './api-client'

const protectedHeaders = async () =>
  new Headers({ Authorization: 'Bearer test.id.token', 'X-Firebase-AppCheck': 'test.app.check' })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const request = { trip: sampleTrip, revisions: [], feedback: '昼食後は休みたかった' }

describe('requestLearningCandidates', () => {
  it('未承認の候補を受け取る', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ status: 'proposed', learnings: [sampleLearning] }))
    const result = await requestLearningCandidates(request, {
      fetchFn,
      getHeaders: protectedHeaders,
    })

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
    expect(
      await requestLearningCandidates(request, { fetchFn, getHeaders: protectedHeaders }),
    ).toMatchObject({
      ok: false,
      failure: { kind: 'unexpected' },
    })
  })

  it('同じIDの候補が含まれていれば、全体を採用しない（承認の操作が、意図しない候補に作用するため）', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ status: 'proposed', learnings: [sampleLearning, sampleLearning] }))

    expect(
      await requestLearningCandidates(request, { fetchFn, getHeaders: protectedHeaders }),
    ).toMatchObject({
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
      expect(
        await requestLearningCandidates(request, { fetchFn, getHeaders: protectedHeaders }),
      ).toMatchObject({
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
    expect(
      await requestLearningCandidates(request, { fetchFn, getHeaders: protectedHeaders }),
    ).toEqual({
      ok: false,
      failure: { kind: status, message: '説明' },
    })
  })

  it('ステータスが食い違う失敗・proposedが200以外は想定外', async () => {
    const mismatch = vi.fn().mockResolvedValue(json({ status: 'no_candidates', message: 'x' }, 200))
    expect(
      await requestLearningCandidates(request, { fetchFn: mismatch, getHeaders: protectedHeaders }),
    ).toMatchObject({
      failure: { kind: 'unexpected' },
    })
    const wrongOk = vi
      .fn()
      .mockResolvedValue(json({ status: 'proposed', learnings: [sampleLearning] }, 201))
    expect(
      await requestLearningCandidates(request, { fetchFn: wrongOk, getHeaders: protectedHeaders }),
    ).toMatchObject({
      failure: { kind: 'unexpected' },
    })
  })

  it('JSONでない本文は想定外、接続失敗は中断', async () => {
    const html = vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }))
    expect(
      await requestLearningCandidates(request, { fetchFn: html, getHeaders: protectedHeaders }),
    ).toMatchObject({
      failure: { kind: 'unexpected' },
    })
    const down = vi.fn().mockRejectedValue(new TypeError('network'))
    expect(
      await requestLearningCandidates(request, { fetchFn: down, getHeaders: protectedHeaders }),
    ).toMatchObject({
      failure: { kind: 'interrupted' },
    })
  })
})

describe('requestLearningCandidates: 保護API（Bearer＋App Check）', () => {
  it('Authorization と X-Firebase-AppCheck の両方を付けて送る', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ status: 'proposed', learnings: [sampleLearning] }))
    await requestLearningCandidates(request, { fetchFn, getHeaders: protectedHeaders })

    const headers = new Headers(fetchFn.mock.calls[0][1].headers)
    expect(headers.get('Authorization')).toBe('Bearer test.id.token')
    expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it.each([
    ['AppCheckUnavailableError', 'app_check_unavailable'],
    ['ClientAuthError', 'auth_required'],
  ] as const)('%s でヘッダーを用意できなければ送信しない（%s）', async (name, kind) => {
    const fetchFn = vi.fn()
    const getHeaders = vi.fn().mockRejectedValue(Object.assign(new Error('生の詳細'), { name }))
    const result = await requestLearningCandidates(request, { fetchFn, getHeaders })

    expect(result).toMatchObject({ ok: false, failure: { kind } })
    expect(JSON.stringify(result)).not.toContain('生の詳細')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
  ] as const)('HTTP %i は %s として固定の文言で返し、再送しない', async (status, kind) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ status: 'service_unavailable', message: '内部の詳細' }, status))
    const result = await requestLearningCandidates(request, {
      fetchFn,
      getHeaders: protectedHeaders,
    })

    expect(result).toMatchObject({ ok: false, failure: { kind } })
    expect(JSON.stringify(result)).not.toContain('内部の詳細')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
