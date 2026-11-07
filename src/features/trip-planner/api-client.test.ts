import { describe, expect, it, vi } from 'vitest'

import { sampleGenerateTripRequest, sampleTrip } from '@/domain/samples'

import { GENERATE_TRIP_ENDPOINT, requestTripGeneration } from './api-client'

const respond = (body: unknown, status: number) =>
  vi.fn<typeof fetch>().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

const call = (fetchFn: typeof fetch) =>
  requestTripGeneration(sampleGenerateTripRequest, { fetchFn })

const failureOf = async (fetchFn: typeof fetch) => {
  const result = await call(fetchFn)
  if (result.ok) throw new Error('失敗として扱われることを期待しました')
  return result.failure
}

describe('requestTripGeneration: 正常系', () => {
  it('提案（proposed）を契約で検証して、旅程を返す', async () => {
    const result = await call(respond({ status: 'proposed', trip: sampleTrip }, 200))

    expect(result).toEqual({ ok: true, trip: sampleTrip })
  })

  it('JSONでPOSTし、入力をそのまま本文に載せ、中止用のsignalを渡す', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    const controller = new AbortController()
    await requestTripGeneration(sampleGenerateTripRequest, { fetchFn, signal: controller.signal })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(GENERATE_TRIP_ENDPOINT)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual(sampleGenerateTripRequest)
    expect(init?.signal).toBe(controller.signal)
  })
})

describe('requestTripGeneration: 契約上の失敗', () => {
  it.each([
    ['no_candidates', 422],
    ['insufficient_information', 422],
    ['external_service_error', 502],
  ] as const)('%s は同じ種類の失敗として、サーバーの説明とともに返す', async (status, http) => {
    const failure = await failureOf(respond({ status, message: '説明文' }, http))

    expect(failure).toEqual({ kind: status, message: '説明文' })
  })

  it('入力不備（invalid_request）は専用の種類で返す', async () => {
    const failure = await failureOf(
      respond({ status: 'invalid_request', message: '旅行条件の形式が正しくありません。' }, 400),
    )

    expect(failure).toEqual({
      kind: 'invalid_request',
      message: '旅行条件の形式が正しくありません。',
    })
  })
})

describe('requestTripGeneration: 通信・想定外の応答', () => {
  it('接続できない場合は、応答が無いこととして通信中断（interrupted）で返す', async () => {
    const failure = await failureOf(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('x')))

    expect(failure.kind).toBe('interrupted')
  })

  it('利用者の操作などで中止された場合も、通信中断として返す', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const result = await requestTripGeneration(sampleGenerateTripRequest, {
      fetchFn,
      signal: controller.signal,
    })

    expect(result).toMatchObject({ ok: false, failure: { kind: 'interrupted' } })
  })

  it('本文が大きすぎる（413）場合は、入力を短くする案内ができる専用の種類で返す', async () => {
    const failure = await failureOf(
      respond({ status: 'payload_too_large', message: '旅行条件のデータが大きすぎます。' }, 413),
    )

    expect(failure).toEqual({
      kind: 'payload_too_large',
      message: '旅行条件のデータが大きすぎます。',
    })
  })

  it('生成の停止中（service_unavailable）は専用の種類で返す', async () => {
    const failure = await failureOf(
      respond({ status: 'service_unavailable', message: '旅程の生成は現在利用できません。' }, 503),
    )

    expect(failure).toEqual({
      kind: 'service_unavailable',
      message: '旅程の生成は現在利用できません。',
    })
  })

  it.each([
    ['内部エラー', { status: 'internal_error', message: '内部エラー' }, 500],
    ['未知の形式', { error: 'boom' }, 500],
    ['配列', [], 200],
    ['null', 'null', 200],
  ])('%sは想定外（unexpected）として扱う', async (_name, body, http) => {
    const failure = await failureOf(respond(body, http))

    expect(failure.kind).toBe('unexpected')
  })

  it('JSONでない応答本文は想定外として扱う', async () => {
    const failure = await failureOf(respond('<html>Bad Gateway</html>', 502))

    expect(failure.kind).toBe('unexpected')
  })

  it('契約に違反する旅程（地点が2件）は、200でも採用しない', async () => {
    const broken = { ...sampleTrip, stops: sampleTrip.stops.slice(0, 2) }
    const failure = await failureOf(respond({ status: 'proposed', trip: broken }, 200))

    expect(failure.kind).toBe('unexpected')
  })

  it('HTTPが成功でないのに提案が返る食い違いは採用しない', async () => {
    const failure = await failureOf(respond({ status: 'proposed', trip: sampleTrip }, 502))

    expect(failure.kind).toBe('unexpected')
  })

  it('想定外の応答に、応答本文の内容を利用者向けの説明として載せない', async () => {
    const failure = await failureOf(
      respond({ status: 'internal_error', message: 'SECRET-DETAIL' }, 500),
    )

    expect(failure.message).not.toContain('SECRET-DETAIL')
  })
})

describe('requestTripGeneration: HTTPステータスと本文の整合', () => {
  it.each([201, 202, 500])(
    '提案（proposed）が HTTP %i で返っても、成功として扱わない',
    async (http) => {
      const failure = await failureOf(respond({ status: 'proposed', trip: sampleTrip }, http))

      expect(failure.kind).toBe('unexpected')
    },
  )

  it('提案は、仕様どおりHTTP 200のときだけ成功とする', async () => {
    const result = await call(respond({ status: 'proposed', trip: sampleTrip }, 200))

    expect(result.ok).toBe(true)
  })

  it.each([
    ['no_candidates', 422, [200, 500, 502, 400]],
    ['insufficient_information', 422, [200, 500, 502, 400]],
    ['external_service_error', 502, [200, 500, 422, 503]],
  ] as const)('%s は HTTP %i のときだけ、その失敗として扱う', async (status, expected, wrong) => {
    expect(await failureOf(respond({ status, message: '説明' }, expected))).toEqual({
      kind: status,
      message: '説明',
    })
    for (const http of wrong) {
      const failure = await failureOf(respond({ status, message: '説明' }, http))
      expect(failure.kind, `HTTP ${http}`).toBe('unexpected')
    }
  })

  it.each([
    ['invalid_request', 400, 500],
    ['payload_too_large', 413, 400],
    ['service_unavailable', 503, 500],
  ] as const)(
    'API層の %s は HTTP %i のときだけ扱い、食い違えば想定外とする',
    async (status, expected, wrong) => {
      const body = { status, message: '説明' }

      expect((await failureOf(respond(body, expected))).kind).toBe(status)
      expect((await failureOf(respond(body, wrong))).kind).toBe('unexpected')
    },
  )

  it('想定外として扱う応答に、サーバーの本文を利用者向けの説明として載せない', async () => {
    const failure = await failureOf(respond({ status: 'no_candidates', message: 'SECRET' }, 500))

    expect(failure.kind).toBe('unexpected')
    expect(failure.message).not.toContain('SECRET')
  })
})

describe('requestTripGeneration: 本文の受信中の中断', () => {
  // ヘッダーは届いたが、本文の途中で通信が切れる応答。
  const brokenBody = (status: number) =>
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":'))
            controller.error(new TypeError('network error'))
          },
        }),
        { status },
      ),
    )

  it.each([200, 422, 502])(
    'HTTP %i のヘッダー後に本文が途切れたら、通信中断（interrupted）とする',
    async (http) => {
      const failure = await failureOf(brokenBody(http))

      expect(failure.kind).toBe('interrupted')
    },
  )

  it('本文が最後まで届いて不正なJSONなら、通信中断ではなく想定外とする', async () => {
    const failure = await failureOf(respond('{"status":', 200))

    expect(failure.kind).toBe('unexpected')
  })

  it('本文の受信中にAbortされても、通信中断として返す（結果の破棄は呼び出し側）', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(stream) {
            controller.signal.addEventListener('abort', () =>
              stream.error(new DOMException('aborted', 'AbortError')),
            )
          },
        }),
        { status: 200 },
      ),
    )
    const pending = requestTripGeneration(sampleGenerateTripRequest, {
      fetchFn,
      signal: controller.signal,
    })
    controller.abort()

    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'interrupted' } })
  })
})
