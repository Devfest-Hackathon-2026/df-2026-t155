import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../../tests/helpers/mock-cost-control'

import { sampleTrip } from '../../domain/samples'
import {
  MAX_VERIFY_REQUEST_BYTES,
  handleVerifyTripRequest,
  isTripVerificationEnabled,
} from './handler'
import type { VerifyTripResult } from './verify-trip'

// トークンの検証は実際のRouteテストで確認し、ここでは認証済みのHTTP処理を検証する。
vi.mock('../costly-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../costly-api')>()),
  requireCostlyApiActor: async () => ({ uid: 'test-actor' }),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

const verified: VerifyTripResult = {
  status: 'verified',
  trip: sampleTrip,
  calls: { places: 3, routes: 2 },
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/trips/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })

const setup = (result: VerifyTripResult = verified, enabled = true) => {
  const verify = vi.fn().mockResolvedValue(result)
  return { verify, deps: { isEnabled: () => enabled, verify } }
}

const validBody = JSON.stringify({ trip: sampleTrip })

describe('POST /api/trips/verify', () => {
  it('旅程を検証して照合し、200で返す（内部の呼び出し回数は返さない）', async () => {
    const { verify, deps } = setup()
    const response = await handleVerifyTripRequest(post(validBody), deps)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json()
    expect(body.status).toBe('verified')
    expect(body.trip.id).toBe(sampleTrip.id)
    expect(body).not.toHaveProperty('calls')
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('予定の時刻が重なっている旅程は、400で返し、照合もMapsの呼び出しもしない', async () => {
    const { verify, deps } = setup()
    const overlapping = {
      ...sampleTrip,
      learningApplications: [],
      stops: sampleTrip.stops.map((stop, index) =>
        index === 1 ? { ...stop, durationMinutes: 150 } : stop,
      ),
    }
    const response = await handleVerifyTripRequest(
      post(JSON.stringify({ trip: overlapping })),
      deps,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ status: 'invalid_request' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('verify が invalid_trip を返したら、400 invalid_request（メッセージはそのまま）', async () => {
    const { deps } = setup({ status: 'invalid_trip', message: '時刻が重なっています' })
    const response = await handleVerifyTripRequest(post(validBody), deps)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      status: 'invalid_request',
      message: '時刻が重なっています',
    })
  })

  it('移動手段の指定（travelModes）などの未知の項目は、無視せず、400で拒否する', async () => {
    const { verify, deps } = setup()
    const response = await handleVerifyTripRequest(
      post(JSON.stringify({ trip: sampleTrip, travelModes: ['drive'] })),
      deps,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ status: 'invalid_request' })
    // 車の指定が反映されたと誤解させない。照合も、Mapsの呼び出しもしない。
    expect(verify).not.toHaveBeenCalled()
  })

  it('外部サービスの失敗は502で返し、旅程は返さない', async () => {
    const { deps } = setup({ status: 'external_service_error', message: '照合できませんでした' })
    const response = await handleVerifyTripRequest(post(validBody), deps)

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      status: 'external_service_error',
      message: '照合できませんでした',
    })
  })

  it('機能フラグが無効なら503を返し、Mapsも本文の読み取りもしない', async () => {
    const { verify, deps } = setup(verified, false)
    const request = post(validBody)
    const response = await handleVerifyTripRequest(request, deps)

    expect(response.status).toBe(503)
    expect(verify).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
  })

  it('JSON以外のContent-Typeは415', async () => {
    const { verify, deps } = setup()
    const response = await handleVerifyTripRequest(
      post(validBody, { 'Content-Type': 'text/plain' }),
      deps,
    )

    expect(response.status).toBe(415)
    expect(verify).not.toHaveBeenCalled()
  })

  it('宣言された大きさが上限を超えれば、本文を読まず413', async () => {
    const { verify, deps } = setup()
    const response = await handleVerifyTripRequest(
      post(validBody, { 'Content-Length': String(MAX_VERIFY_REQUEST_BYTES + 1) }),
      deps,
    )

    expect(response.status).toBe(413)
    expect(verify).not.toHaveBeenCalled()
  })

  it('実際の本文が上限を超えれば413', async () => {
    const { verify, deps } = setup()
    const huge = JSON.stringify({ trip: sampleTrip, pad: 'x'.repeat(MAX_VERIFY_REQUEST_BYTES) })
    const response = await handleVerifyTripRequest(post(huge), deps)

    expect(response.status).toBe(413)
    expect(verify).not.toHaveBeenCalled()
  })

  it('JSONでない本文は400', async () => {
    const { verify, deps } = setup()
    const response = await handleVerifyTripRequest(post('{broken'), deps)

    expect(response.status).toBe(400)
    expect(verify).not.toHaveBeenCalled()
  })

  it('旅程の形式が正しくなければ400（問題の場所を示す）', async () => {
    const { verify, deps } = setup()
    const response = await handleVerifyTripRequest(
      post(JSON.stringify({ trip: { ...sampleTrip, stops: [] } })),
      deps,
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.status).toBe('invalid_request')
    expect(body.issues.some((issue: { path: string }) => issue.path.startsWith('trip.stops'))).toBe(
      true,
    )
    expect(verify).not.toHaveBeenCalled()
  })

  it('照合中の想定外の例外は500にし、内容を漏らさない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const verify = vi.fn().mockRejectedValue(new Error('秘密のトークン abc'))
    const response = await handleVerifyTripRequest(post(validBody), {
      isEnabled: () => true,
      verify,
    })

    expect(response.status).toBe(500)
    const text = JSON.stringify(await response.json())
    expect(text).not.toContain('秘密')
  })

  it('照合結果が契約に反していれば、クライアントへ流さず500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = {
      status: 'verified',
      trip: { ...sampleTrip, stops: [] },
      calls: { places: 0, routes: 0 },
    } as unknown as VerifyTripResult
    const { deps } = setup(broken)
    const response = await handleVerifyTripRequest(post(validBody), deps)

    expect(response.status).toBe(500)
  })
})

describe('isTripVerificationEnabled', () => {
  it('trueのときだけ有効（未設定・他の値は無効）', () => {
    expect(isTripVerificationEnabled({ TRIP_VERIFICATION_ENABLED: 'true' })).toBe(true)
    expect(isTripVerificationEnabled({ TRIP_VERIFICATION_ENABLED: ' true ' })).toBe(true)
    expect(isTripVerificationEnabled({})).toBe(false)
    expect(isTripVerificationEnabled({ TRIP_VERIFICATION_ENABLED: '1' })).toBe(false)
    expect(isTripVerificationEnabled({ TRIP_VERIFICATION_ENABLED: 'false' })).toBe(false)
  })
})
