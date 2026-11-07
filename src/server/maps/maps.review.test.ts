import { describe, expect, it, vi } from 'vitest'

import { createMapsAuth } from './auth'
import { createMapsClient, MapsCallError } from './index'

// PR #21 のレビュー対応の回帰テスト（営業時間の空配列・例外の機密・認証の期限・数値の検証）。

const SECRET = 'SECRET-RESPONSE-FRAGMENT'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const setup = (respond: () => Promise<Response> | Response = () => jsonResponse({})) => {
  const fetchFn = vi.fn<typeof fetch>(async () => respond())
  const client = createMapsClient({
    auth: createMapsAuth('test-project', async () => 'test-token'),
    fetchFn,
  })
  return { client, fetchFn }
}

const failureOf = async (promise: Promise<unknown>): Promise<MapsCallError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (!(error instanceof MapsCallError)) {
    throw new Error('MapsCallErrorで拒否されることを期待しました')
  }
  return error
}

describe('営業時間：空配列と欠落の区別', () => {
  const place = {
    id: 'ChIJ-sample-1',
    displayName: { text: '清水寺' },
    location: { latitude: 34.9949, longitude: 135.785 },
  }
  const hoursOf = async (regularOpeningHours?: unknown, include = true) => {
    const { client } = setup(() =>
      jsonResponse({
        places: [
          { ...place, ...(regularOpeningHours === undefined ? {} : { regularOpeningHours }) },
        ],
      }),
    )
    const result = await client.searchPlaces({ query: '清水寺', includeOpeningHours: include })
    return result.status === 'found' ? result.candidates[0].openingHours : undefined
  }

  it('periodsが空配列なら、欠落にせず、空の配列として保持する', async () => {
    expect(await hoursOf({ periods: [] })).toEqual({ status: 'available', periods: [] })
  })

  it('periodsが無い（regularOpeningHoursだけ・何も無い）なら、欠落（unavailable）', async () => {
    expect(await hoursOf({})).toEqual({ status: 'unavailable' })
    expect(await hoursOf(undefined)).toEqual({ status: 'unavailable' })
  })

  it('要求していなければ、空配列でも not_requested', async () => {
    expect(await hoursOf({ periods: [] }, false)).toEqual({ status: 'not_requested' })
  })
})

// 例外全体（メッセージ・stack・原因・追加の項目）を対象に、機密が残らないことを確かめる。
describe('例外に機密情報を保持しない', () => {
  const everythingOf = async (error: MapsCallError): Promise<string> => {
    const { inspect } = await import('node:util')
    return [
      error.message,
      error.stack ?? '',
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      inspect(error, { depth: 10, showHidden: true }),
    ].join('\n')
  }

  it('認証の例外：メッセージにトークンを含む例外でも、causeに保持しない', async () => {
    const client = createMapsClient({
      auth: createMapsAuth('p', async () => {
        throw new Error(`credential detail ${SECRET}`)
      }),
      fetchFn: vi.fn<typeof fetch>(),
    })
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.cause).toBeUndefined()
    expect(await everythingOf(error)).not.toContain(SECRET)
  })

  it('応答がJSONでない：解析エラーの断片（応答の内容）を、causeに保持しない', async () => {
    const { client } = setup(() => new Response(`{"token": "${SECRET}", broken`, { status: 200 }))
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.reason).toBe('invalid_response')
    expect(error.cause).toBeUndefined()
    expect(await everythingOf(error)).not.toContain(SECRET)
  })

  it('接続失敗・時間切れ：外部の例外を、causeに保持しない', async () => {
    for (const thrown of [
      new TypeError(`fetch failed ${SECRET}`),
      Object.assign(new Error(`aborted ${SECRET}`), { name: 'TimeoutError' }),
    ]) {
      const client = createMapsClient({
        auth: createMapsAuth('p', async () => 'tok'),
        fetchFn: vi.fn<typeof fetch>().mockRejectedValue(thrown),
      })
      const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

      expect(error.cause).toBeUndefined()
      expect(await everythingOf(error)).not.toContain(SECRET)
    }
  })

  it('HTTPエラー：エラー本文のメッセージを、どこにも保持しない（状態名だけ）', async () => {
    const { client } = setup(() =>
      jsonResponse({ error: { status: 'PERMISSION_DENIED', message: SECRET } }, 403),
    )
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.apiStatus).toBe('PERMISSION_DENIED')
    expect(await everythingOf(error)).not.toContain(SECRET)
  })
})

describe('認証の期限', () => {
  it('認証が期限内に終わらなければ timeout とし、Mapsを呼ばない', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const client = createMapsClient({
      auth: createMapsAuth('p', () => new Promise<string>(() => undefined)),
      fetchFn,
      timeoutMs: 30,
    })

    expect((await failureOf(client.searchPlaces({ query: '清水寺' }))).reason).toBe('timeout')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('期限のあとで、遅れて認証が完了しても、Mapsを呼ばない', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}))
    let finish: (token: string) => void = () => undefined
    const client = createMapsClient({
      auth: createMapsAuth('p', () => new Promise<string>((resolve) => (finish = resolve))),
      fetchFn,
      timeoutMs: 20,
    })

    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))
    finish('late-token')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(error.reason).toBe('timeout')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('期限のあとで、認証が失敗しても、未処理の拒否を起こさない', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let fail: (error: Error) => void = () => undefined
      const client = createMapsClient({
        auth: createMapsAuth('p', () => new Promise<string>((_, reject) => (fail = reject))),
        fetchFn: vi.fn<typeof fetch>(),
        timeoutMs: 20,
      })
      await failureOf(
        client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
      )
      fail(new Error('late failure'))
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('期限内に認証が終われば、通常どおり呼び出す', async () => {
    const { client, fetchFn } = setup()
    await client.searchPlaces({ query: '清水寺' })

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('外部APIの数値の検証', () => {
  const basePlace = { id: 'ChIJ-x', displayName: { text: '清水寺' } }

  it.each([
    [-90, -180, true],
    [90, 180, true],
    [90.0001, 0, false],
    [-90.0001, 0, false],
    [0, 180.0001, false],
    [0, -180.0001, false],
  ])('座標（緯度%d・経度%d）の範囲：受け入れ=%s', async (latitude, longitude, ok) => {
    const { client } = setup(() =>
      jsonResponse({ places: [{ ...basePlace, location: { latitude, longitude } }] }),
    )
    const run = client.searchPlaces({ query: '清水寺' })

    if (ok) expect((await run).status).toBe('found')
    else expect((await failureOf(run)).reason).toBe('invalid_response')
  })

  const routeWith = (route: unknown) => {
    const { client } = setup(() => jsonResponse({ routes: [route] }))
    return client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' })
  }

  it('Infinityになる所要時間は、正常な結果にせず invalid_response', async () => {
    const huge = `${'9'.repeat(400)}s`
    expect((await failureOf(routeWith({ duration: huge }))).reason).toBe('invalid_response')
  })

  it('現実的な上限（7日）を超える所要時間は invalid_response。上限ちょうどは受け入れる', async () => {
    const limit = 7 * 24 * 60 * 60
    expect(await routeWith({ duration: `${limit}s` })).toMatchObject({
      status: 'found',
      durationSeconds: limit,
    })
    expect((await failureOf(routeWith({ duration: `${limit + 1}s` }))).reason).toBe(
      'invalid_response',
    )
  })

  it('範囲外の距離（負・小数・上限超過）は invalid_response。上限ちょうどは受け入れる', async () => {
    for (const distanceMeters of [-1, 1.5, 20_000_001]) {
      expect((await failureOf(routeWith({ duration: '60s', distanceMeters }))).reason).toBe(
        'invalid_response',
      )
    }
    expect(await routeWith({ duration: '60s', distanceMeters: 20_000_000 })).toMatchObject({
      status: 'found',
    })
  })
})

describe('認証の実装が通常の例外を投げる場合（再レビュー対応）', () => {
  it('MapsAuthが通常のErrorを投げても、元の例外を伝播させず auth_failed にする', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const client = createMapsClient({
      auth: {
        async getHeaders() {
          throw new Error(`raw credential error ${SECRET}`)
        },
      },
      fetchFn,
    })
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.reason).toBe('auth_failed')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('MapsAuthが文字列など、Errorでない値を投げても auth_failed', async () => {
    const client = createMapsClient({
      auth: {
        async getHeaders() {
          throw SECRET
        },
      },
      fetchFn: vi.fn<typeof fetch>(),
    })

    expect((await failureOf(client.searchPlaces({ query: '清水寺' }))).reason).toBe('auth_failed')
  })
})

describe('apiStatus は、Googleの既知のエラー名だけを保持する（再レビュー対応）', () => {
  const statusOf = async (apiStatus: string) => {
    const { client } = setup(() => jsonResponse({ error: { status: apiStatus } }, 400))
    return (await failureOf(client.searchPlaces({ query: '清水寺' }))).apiStatus
  }

  it.each([
    'INVALID_ARGUMENT',
    'PERMISSION_DENIED',
    'RESOURCE_EXHAUSTED',
    'UNAUTHENTICATED',
    'UNAVAILABLE',
    'DEADLINE_EXCEEDED',
    'INTERNAL',
  ])('既知の名前 %s は保持する', async (name) => {
    expect(await statusOf(name)).toBe(name)
  })

  it.each([
    'SECRET_TOKEN_VALUE',
    'USER_EMAIL_EXAMPLE',
    'INVALID_ARGUMENT_EXTRA',
    'invalid_argument',
    'A'.repeat(40),
    '',
  ])('既知でない名前（文字種・長さが合っても）%s は保持しない', async (name) => {
    expect(await statusOf(name)).toBeUndefined()
  })
})

describe('認証の期限：単調時計での管理（再レビュー対応）', () => {
  // 同期的に時間を消費して、イベントループを塞ぐ（期限のタイマーが実行できない状況を再現する）。
  const blockFor = (ms: number) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      // 待つ
    }
  }

  it('タイマーが遅れて、認証の成功が先に処理されても、期限を過ぎていればMapsを呼ばない', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}))
    const client = createMapsClient({
      auth: {
        async getHeaders() {
          // タイマー（30ms）が実行される前に、同期的に60msを消費してから、認証を成功させる。
          blockFor(60)
          return { Authorization: 'Bearer late', 'X-Goog-User-Project': 'p' }
        },
      },
      fetchFn,
      timeoutMs: 30,
    })

    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.reason).toBe('timeout')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('期限内に認証が終われば、残りの時間で送信する（認証に使った時間を差し引く）', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      seenSignal = init?.signal ?? undefined
      return jsonResponse({})
    })
    const client = createMapsClient({
      auth: {
        async getHeaders() {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { Authorization: 'Bearer ok', 'X-Goog-User-Project': 'p' }
        },
      },
      fetchFn,
      timeoutMs: 5000,
    })

    await client.searchPlaces({ query: '清水寺' })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(seenSignal?.aborted).toBe(false)
  })

  it('認証に時間を使い切ったあとに送信が始まる場合も、残り時間が尽きていれば送らない', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}))
    const client = createMapsClient({
      auth: {
        async getHeaders() {
          await new Promise((resolve) => setTimeout(resolve, 15))
          blockFor(30)
          return { Authorization: 'Bearer ok', 'X-Goog-User-Project': 'p' }
        },
      },
      fetchFn,
      timeoutMs: 40,
    })

    expect(
      (
        await failureOf(
          client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
        )
      ).reason,
    ).toBe('timeout')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('認証がMapsCallErrorを投げる場合（再々レビュー対応）', () => {
  const clientWithAuth = (getHeaders: () => Promise<Record<string, string>>) => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}))
    return { client: createMapsClient({ auth: { getHeaders }, fetchFn }), fetchFn }
  }
  const everything = (error: MapsCallError) =>
    [
      error.message,
      error.stack ?? '',
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ].join('\n')

  it('認証処理がMapsCallErrorを投げても、元の例外を再送出せず、安全なauth_failedに変換する', async () => {
    const { client, fetchFn } = clientWithAuth(async () => {
      throw new MapsCallError('not_configured', `credential detail ${SECRET}`, {
        status: 401,
        apiStatus: 'PERMISSION_DENIED',
      })
    })
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.reason).toBe('auth_failed')
    expect(error.status).toBeUndefined()
    expect(error.apiStatus).toBeUndefined()
    expect(error.cause).toBeUndefined()
    expect(everything(error)).not.toContain(SECRET)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'network', 'api_error', 'invalid_response', 'unsupported_mode'] as const)(
    '認証処理が投げた MapsCallError(%s) も、timeoutなどとして扱わず、auth_failed にする',
    async (reason) => {
      const { client } = clientWithAuth(async () => {
        throw new MapsCallError(reason, `detail ${SECRET}`)
      })
      const error = await failureOf(
        client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
      )

      expect(error.reason).toBe('auth_failed')
      expect(everything(error)).not.toContain(SECRET)
    },
  )

  it('アダプター自身の期限切れだけが timeout になる（認証が終わらない場合）', async () => {
    const client = createMapsClient({
      auth: { getHeaders: () => new Promise<Record<string, string>>(() => undefined) },
      fetchFn: vi.fn<typeof fetch>(),
      timeoutMs: 25,
    })

    expect((await failureOf(client.searchPlaces({ query: '清水寺' }))).reason).toBe('timeout')
  })
})

describe('送受信の期限（再々レビュー対応）', () => {
  // 同期的に時間を消費して、イベントループを塞ぐ（期限のタイマーが実行できない状況を再現する）。
  const blockFor = (ms: number) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      // 待つ
    }
  }
  const goodHeaders = { Authorization: 'Bearer ok', 'X-Goog-User-Project': 'p' }

  it('送信の準備に時間がかかり、期限を過ぎたら、Mapsを呼び出さない', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}))
    // ヘッダーの取り出し（送信の準備）で、時間を消費する。
    const slowHeaders = { ...goodHeaders }
    Object.defineProperty(slowHeaders, 'Authorization', {
      enumerable: true,
      get() {
        blockFor(60)
        return 'Bearer ok'
      },
    })
    const client = createMapsClient({
      auth: { getHeaders: async () => slowHeaders },
      fetchFn,
      timeoutMs: 30,
    })

    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.reason).toBe('timeout')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('本文の受信が完了した時点で期限を過ぎていたら（タイマーが遅れて、正常に終了しても）、成功にしない', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      blockFor(60)
      return jsonResponse({ places: [] })
    })
    const client = createMapsClient({
      auth: { getHeaders: async () => goodHeaders },
      fetchFn,
      timeoutMs: 30,
    })

    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.reason).toBe('timeout')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('期限内に終われば、通常どおり成功する（確認が、正常な呼び出しを妨げない）', async () => {
    const { client } = setup(() => jsonResponse({ places: [] }))

    expect(await client.searchPlaces({ query: '清水寺' })).toEqual({ status: 'no_candidates' })
  })

  it('認証に使った時間は、HTTP側の期限から差し引かれる（合計で期限を超えない）', async () => {
    const hang = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const client = createMapsClient({
      auth: {
        getHeaders: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80))
          return goodHeaders
        },
      },
      fetchFn: hang,
      timeoutMs: 200,
    })
    const startedAt = performance.now()

    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))
    const elapsed = performance.now() - startedAt

    expect(error.reason).toBe('timeout')
    // 認証80ms＋HTTP（残り約120ms）≒200ms。差し引かれていなければ、約280ms。
    expect(elapsed).toBeLessThan(260)
    expect(elapsed).toBeGreaterThanOrEqual(150)
  })

  it('HTTP側に渡す期限は、認証に使った時間だけ短くなる', async () => {
    let seen: AbortSignal | undefined
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      seen = init?.signal ?? undefined
      return jsonResponse({})
    })
    const client = createMapsClient({
      auth: {
        getHeaders: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100))
          return goodHeaders
        },
      },
      fetchFn,
      timeoutMs: 400,
    })
    await client.searchPlaces({ query: '清水寺' })

    // 残りは約300ms。400msの期限ではなく、約300msで中止される信号が渡される。
    await new Promise((resolve) => setTimeout(resolve, 340))
    expect(seen?.aborted).toBe(true)
  })
})
