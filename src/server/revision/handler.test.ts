import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../../tests/helpers/mock-cost-control'

import type { ReviseTripResponse } from '../../domain'
import { sampleReviseTripRequest, sampleRevision } from '../../domain/samples'
import { MAX_REVISE_REQUEST_BYTES, handleReviseTripRequest, isTripRevisionEnabled } from './handler'

// トークンの検証は実際のRouteテストで確認し、ここでは認証済みのHTTP処理を検証する。
vi.mock('../costly-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../costly-api')>()),
  requireCostlyApiActor: async () => ({ uid: 'test-actor' }),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

const proposed: ReviseTripResponse = { status: 'proposed', revisions: [sampleRevision] }

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/trips/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })

const setup = (response: ReviseTripResponse = proposed, enabled = true) => {
  const revise = vi.fn().mockResolvedValue(response)
  return { revise, deps: { isEnabled: () => enabled, revise } }
}

const validBody = JSON.stringify(sampleReviseTripRequest)

describe('POST /api/trips/revise', () => {
  it('入力を検証し、未承認のRevisionを200で返す', async () => {
    const { revise, deps } = setup()
    const response = await handleReviseTripRequest(post(validBody), deps)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json()
    expect(body.status).toBe('proposed')
    expect(body.revisions[0].approval).toEqual({ status: 'pending' })
    expect(revise).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no_candidates', 422],
    ['insufficient_information', 422],
    ['external_service_error', 502],
  ] as const)('失敗 %s はHTTP %i で返す（更新後の旅程を含めない）', async (status, httpStatus) => {
    const { deps } = setup({ status, message: '説明' })
    const response = await handleReviseTripRequest(post(validBody), deps)

    expect(response.status).toBe(httpStatus)
    expect(await response.json()).toEqual({ status, message: '説明' })
  })

  it('機能フラグが無効なら503を返し、AI・Mapsも本文の読み取りもしない', async () => {
    const { revise, deps } = setup(proposed, false)
    const request = post(validBody)
    const response = await handleReviseTripRequest(request, deps)

    expect(response.status).toBe(503)
    expect(revise).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
  })

  it('JSON以外のContent-Typeは415', async () => {
    const { revise, deps } = setup()
    const response = await handleReviseTripRequest(
      post(validBody, { 'Content-Type': 'text/plain' }),
      deps,
    )

    expect(response.status).toBe(415)
    expect(revise).not.toHaveBeenCalled()
  })

  it.each(['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON'])(
    'Content-Type %s は受理する',
    async (contentType) => {
      const { revise, deps } = setup()
      const response = await handleReviseTripRequest(
        post(validBody, { 'Content-Type': contentType }),
        deps,
      )

      expect(response.status).toBe(200)
      expect(revise).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['application/jsonp', 'application/json-patch+json', 'text/plain'])(
    'Content-Type %s は415',
    async (contentType) => {
      const { revise, deps } = setup()
      const response = await handleReviseTripRequest(
        post(validBody, { 'Content-Type': contentType }),
        deps,
      )

      expect(response.status).toBe(415)
      expect(revise).not.toHaveBeenCalled()
    },
  )

  it('大きすぎる入力は413（宣言・実際とも）', async () => {
    const { revise, deps } = setup()
    const declared = await handleReviseTripRequest(
      post(validBody, { 'Content-Length': String(MAX_REVISE_REQUEST_BYTES + 1) }),
      deps,
    )
    const actual = await handleReviseTripRequest(
      post(
        JSON.stringify({ ...sampleReviseTripRequest, pad: 'x'.repeat(MAX_REVISE_REQUEST_BYTES) }),
      ),
      deps,
    )

    expect(declared.status).toBe(413)
    expect(actual.status).toBe(413)
    expect(revise).not.toHaveBeenCalled()
  })

  it('JSONでない本文は400', async () => {
    const { revise, deps } = setup()
    const response = await handleReviseTripRequest(post('{broken'), deps)

    expect(response.status).toBe(400)
    expect(revise).not.toHaveBeenCalled()
  })

  it('固定された予定・存在しない予定を対象にした入力は400（AIを呼ばない）', async () => {
    const { revise, deps } = setup()
    for (const targetStopId of ['stop-morning', 'stop-unknown']) {
      const response = await handleReviseTripRequest(
        post(JSON.stringify({ ...sampleReviseTripRequest, targetStopId })),
        deps,
      )
      expect(response.status).toBe(400)
      expect((await response.json()).issues[0].path).toBe('targetStopId')
    }
    expect(revise).not.toHaveBeenCalled()
  })

  it('予定の時刻が重なっている旅程は400（AI・Mapsを呼ばない）', async () => {
    const { revise, deps } = setup()
    const overlapping = {
      ...sampleReviseTripRequest,
      trip: {
        ...sampleReviseTripRequest.trip,
        // 昼食（12:00開始）が、14:00開始の展示にかかる長さになる。
        stops: sampleReviseTripRequest.trip.stops.map((stop) =>
          stop.id === 'stop-lunch' ? { ...stop, durationMinutes: 180 } : stop,
        ),
      },
    }
    const response = await handleReviseTripRequest(post(JSON.stringify(overlapping)), deps)

    expect(response.status).toBe(400)
    expect((await response.json()).status).toBe('invalid_request')
    expect(revise).not.toHaveBeenCalled()
  })

  it('想定外の例外は500にし、内容を漏らさない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const revise = vi.fn().mockRejectedValue(new Error('秘密のトークン abc'))
    const response = await handleReviseTripRequest(post(validBody), {
      isEnabled: () => true,
      revise,
    })

    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('秘密')
  })

  it('承認済みのRevisionなど、契約に反する応答は、流さずに500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const approved = {
      status: 'proposed',
      revisions: [
        {
          ...sampleRevision,
          approval: { status: 'approved', decidedAt: '2026-11-08T12:00:00+09:00' },
        },
      ],
    } as unknown as ReviseTripResponse
    const { deps } = setup(approved)
    const response = await handleReviseTripRequest(post(validBody), deps)

    expect(response.status).toBe(500)
  })
})

describe('isTripRevisionEnabled', () => {
  it('trueのときだけ有効', () => {
    expect(isTripRevisionEnabled({ TRIP_REVISION_ENABLED: 'true' })).toBe(true)
    expect(isTripRevisionEnabled({})).toBe(false)
    expect(isTripRevisionEnabled({ TRIP_REVISION_ENABLED: '1' })).toBe(false)
  })
})
