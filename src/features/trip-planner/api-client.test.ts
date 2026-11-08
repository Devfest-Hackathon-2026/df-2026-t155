import { describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning, sampleGenerateTripRequest, sampleTrip } from '@/domain/samples'
import {
  createSessionScope,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'
import type { ScopedLearningSelection } from '@/features/learning-reuse/selection-scope'
import type { GenerateTripConditions } from '@/server/trip-generation/http-request'

import { GENERATE_TRIP_ENDPOINT, requestTripGeneration } from './api-client'

// 画面が組み立てる旅行条件（学びの選択は含まない）。
const { date, region, timeZone, preferences, fixedStops } = sampleGenerateTripRequest
const conditions: GenerateTripConditions = { date, region, timeZone, preferences, fixedStops }

// 認証SDKは使わない。応答の採用前に確認する「現在のセッション」だけを差し替える（user-a・世代1）。
const authState = vi.hoisted(() => ({
  snapshot: { uid: 'user-a', token: 'test.token', generation: 1 },
}))
vi.mock('@/lib/auth/client', () => ({
  getAuthSnapshot: async () => authState.snapshot,
  isAuthSessionCurrent: (uid: string, generation: number) =>
    uid === authState.snapshot.uid && generation === authState.snapshot.generation,
  registerAuthSessionOperation: () => () => undefined,
}))

const protectedHeaders = async () =>
  new Headers({ Authorization: 'Bearer test.id.token', 'X-Firebase-AppCheck': 'test.app.check' })

const respond = (body: unknown, status: number) =>
  vi.fn<typeof fetch>().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

const call = (fetchFn: typeof fetch) =>
  requestTripGeneration(conditions, { fetchFn, getHeaders: protectedHeaders })

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
    await requestTripGeneration(conditions, {
      fetchFn,
      getHeaders: protectedHeaders,
      signal: controller.signal,
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(GENERATE_TRIP_ENDPOINT)
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    // 本文は旅行条件と、選択（なければ空）だけ。承認済みの学びの本文は載らない。
    expect(JSON.parse(String(init?.body))).toEqual({ ...conditions, learningSelections: [] })
    expect(init?.signal).toBe(controller.signal)
  })
})

it.each([
  [401, 'unauthorized'],
  [403, 'unauthorized'],
  [429, 'rate_limited'],
])('保護APIのHTTP %sを専用の案内へ分ける', async (status, kind) => {
  expect(await failureOf(respond('not JSON', status))).toMatchObject({ kind })
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
    const result = await requestTripGeneration(conditions, {
      fetchFn,
      getHeaders: protectedHeaders,
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
    const pending = requestTripGeneration(conditions, {
      fetchFn,
      getHeaders: protectedHeaders,
      signal: controller.signal,
    })
    controller.abort()

    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'interrupted' } })
  })
})

describe('requestTripGeneration: 保護API（Bearer＋App Check）', () => {
  it('Authorization と X-Firebase-AppCheck の両方を付けて送り、Content-Type も保つ', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    await call(fetchFn)

    const headers = new Headers(fetchFn.mock.calls[0][1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer test.id.token')
    expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it.each([
    ['App Checkを用意できない', 'AppCheckUnavailableError', 'app_check_unavailable'],
    ['認証情報を用意できない', 'ClientAuthError', 'auth_required'],
  ] as const)('%s場合は送信せず（fail-closed）、%s として返す', async (_label, name, kind) => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    const getHeaders = vi.fn().mockRejectedValue(Object.assign(new Error('生の詳細'), { name }))
    const result = await requestTripGeneration(conditions, { fetchFn, getHeaders })

    expect(result).toMatchObject({ ok: false, failure: { kind } })
    expect(JSON.stringify(result)).not.toContain('生の詳細')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(getHeaders).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
  ] as const)(
    'HTTP %i は本文の形に関わらず %s とし、サーバーの文言を出さず、再送しない',
    async (status, kind) => {
      const fetchFn = respond({ status: 'invalid_request', message: 'サーバー内部の詳細' }, status)
      const failure = await failureOf(fetchFn)

      expect(failure.kind).toBe(kind)
      expect(failure.message).not.toContain('サーバー内部の詳細')
      expect(fetchFn).toHaveBeenCalledTimes(1)
    },
  )

  it('503は従来どおり service_unavailable（保護・機能停止）で、401・429とは別の種類', async () => {
    const fetchFn = respond({ status: 'service_unavailable', message: '停止中' }, 503)
    expect((await failureOf(fetchFn)).kind).toBe('service_unavailable')
  })
})

describe('requestTripGeneration: 学びの選択（{ id, version } だけを、認証セッションと照合して送る）', () => {
  const sessionA: SessionScope = createSessionScope('user-a', 1)
  const sessionB: SessionScope = createSessionScope('user-b', 2)
  const selection = (scope: SessionScope): ScopedLearningSelection => ({
    scope,
    value: [{ id: sampleApprovedLearning.id, version: 3 }],
  })
  const scopedHeaders = vi.fn(async () => new Headers({ Authorization: 'Bearer scope.token' }))
  const operation = () => ({
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    dispose: vi.fn(),
  })
  const send = (
    fetchFn: typeof fetch,
    learningSelection: ScopedLearningSelection | null,
    current: SessionScope = sessionA,
  ) =>
    requestTripGeneration(conditions, {
      fetchFn,
      getHeaders: protectedHeaders,
      learningSelection,
      captureScope: async () => current,
      getHeadersForScope: scopedHeaders,
      beginOperation: () => operation(),
    })

  it('本文には選択の { id, version } だけを載せ、学びの本文・承認状態は載せない', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    const result = await send(fetchFn, selection(sessionA))

    expect(result.ok).toBe(true)
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body))
    expect(body.learningSelections).toEqual([{ id: sampleApprovedLearning.id, version: 3 }])
    expect(body).not.toHaveProperty('learnings')
    expect(JSON.stringify(body)).not.toContain(sampleApprovedLearning.content)
    // 選んだ時点のセッションのヘッダーで送る（現在のUIDで作り直さない）。
    expect(scopedHeaders).toHaveBeenCalledWith(sessionA)
    expect(new Headers(fetchFn.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer scope.token',
    )
  })

  it('旅行条件に旧形式の learnings が混ざっていても、本文には載せない', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    await requestTripGeneration(
      { ...conditions, learnings: [sampleApprovedLearning] } as GenerateTripConditions,
      { fetchFn, getHeaders: protectedHeaders },
    )

    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body))
    expect(body).not.toHaveProperty('learnings')
    expect(body.learningSelections).toEqual([])
  })

  it('選択がなければ（null・空）、通常のヘッダーで空の選択を送る', async () => {
    for (const none of [null, { scope: sessionA, value: [] }]) {
      const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
      await send(fetchFn, none)
      expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).learningSelections).toEqual([])
    }
    expect(scopedHeaders).not.toHaveBeenCalled()
  })

  it('選んだ後に認証セッションが変わっていたら、何も送らず session_changed（学びを外して続けない）', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    const result = await send(fetchFn, selection(sessionA), sessionB)

    expect(result).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('同じUIDでも認証世代が違えば別のセッションとして、送らない', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    const result = await send(fetchFn, selection(createSessionScope('user-a', 2)), sessionA)

    expect(result).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('ヘッダー取得時にセッションが変わっていたら送らない', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    const result = await requestTripGeneration(conditions, {
      fetchFn,
      learningSelection: selection(sessionA),
      captureScope: async () => sessionA,
      getHeadersForScope: async () => {
        throw new SessionChangedError()
      },
    })

    expect(result).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('応答を採用する直前にセッションが変わっていたら、生成された旅程を捨てる', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    const changing = {
      signal: new AbortController().signal,
      dispose: vi.fn(),
      assertCurrent: vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw new SessionChangedError()
        }),
    }
    const result = await requestTripGeneration(conditions, {
      fetchFn,
      learningSelection: selection(sessionA),
      captureScope: async () => sessionA,
      getHeadersForScope: scopedHeaders,
      beginOperation: () => changing,
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
    expect(changing.dispose).toHaveBeenCalled()
  })

  it('選択の形式が不正（重複ID）なら送らず、入力内容の問題として知らせる', async () => {
    const fetchFn = respond({ status: 'proposed', trip: sampleTrip }, 200)
    const duplicated: ScopedLearningSelection = {
      scope: sessionA,
      value: [
        { id: 'learning-a', version: 1 },
        { id: 'learning-a', version: 2 },
      ],
    }
    const result = await send(fetchFn, duplicated)

    expect(result).toMatchObject({ ok: false, failure: { kind: 'invalid_request' } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('409 selection_changed は選び直しの案内として、旅程なしで返す', async () => {
    const failure = await failureOf(
      respond({ status: 'selection_changed', message: '選んだ学びが変更されました' }, 409),
    )
    expect(failure.kind).toBe('selection_changed')
  })

  it('503 learnings_unavailable は、機能停止（service_unavailable）とは別の失敗として扱う', async () => {
    const unavailable = await failureOf(
      respond({ status: 'learnings_unavailable', message: '学びを確認できません' }, 503),
    )
    const stopped = await failureOf(
      respond({ status: 'service_unavailable', message: '停止中' }, 503),
    )
    expect(unavailable.kind).toBe('learnings_unavailable')
    expect(stopped.kind).toBe('service_unavailable')
  })

  it('ステータスが食い違う selection_changed（200など）は信用しない', async () => {
    const failure = await failureOf(respond({ status: 'selection_changed', message: 'x' }, 500))
    expect(failure.kind).toBe('unexpected')
  })
})
