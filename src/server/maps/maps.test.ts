import { describe, expect, it, vi } from 'vitest'

import { createMapsAuth, loadMapsConfig } from './auth'
import { createLazyMapsClient, createMapsClient, MapsCallError, type MapsClient } from './index'
import { PLACES_SEARCH_TEXT_URL } from './places'
import { ROUTES_COMPUTE_URL } from './routes'

const SECRET_TOKEN = 'ya-secret-token-value'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const setup = (respond: () => Promise<Response> | Response = () => jsonResponse({})) => {
  const fetchFn = vi.fn<typeof fetch>(async () => respond())
  const getAccessToken = vi.fn(async () => SECRET_TOKEN)
  const client = createMapsClient({
    auth: createMapsAuth('test-project', getAccessToken),
    fetchFn,
  })
  return { client, fetchFn, getAccessToken }
}

const failureOf = async (promise: Promise<unknown>): Promise<MapsCallError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (!(error instanceof MapsCallError))
    throw new Error('MapsCallErrorで拒否されることを期待しました')
  return error
}

const bodyOf = (fetchFn: ReturnType<typeof setup>['fetchFn']) =>
  JSON.parse(String(fetchFn.mock.calls[0][1]?.body))

describe('共通の送信（認証・ヘッダー・UTF-8・再試行なし）', () => {
  it('ADCのOAuthトークンと課金プロジェクトを付け、APIキーは使わない', async () => {
    const { client, fetchFn } = setup()
    await client.searchPlaces({ query: '清水寺' })

    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toBe(PLACES_SEARCH_TEXT_URL)
    expect(String(url)).not.toContain('key=')
    const headers = new Headers(init?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${SECRET_TOKEN}`)
    expect(headers.get('X-Goog-User-Project')).toBe('test-project')
    expect(headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(headers.get('X-Goog-Api-Key')).toBeNull()
    expect(init?.method).toBe('POST')
  })

  it('日本語のクエリを、文字化けさせずにUTF-8で送る', async () => {
    const { client, fetchFn } = setup()
    await client.searchPlaces({ query: '総本家 ゆどうふ 奥丹清水 京都' })

    const sent = String(fetchFn.mock.calls[0][1]?.body)
    expect(bodyOf(fetchFn).textQuery).toBe('総本家 ゆどうふ 奥丹清水 京都')
    expect(new TextDecoder().decode(new TextEncoder().encode(sent))).toBe(sent)
  })

  it('失敗しても自動で再試行しない（課金される呼び出しを増やさない）', async () => {
    const { client, fetchFn } = setup(() => jsonResponse({ error: { status: 'UNAVAILABLE' } }, 503))
    await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('Places: searchPlaces', () => {
  const place = {
    id: 'ChIJ-sample-1',
    displayName: { text: '清水寺', languageCode: 'ja' },
    formattedAddress: '日本、京都府京都市東山区清水１丁目２９４',
    location: { latitude: 34.9949, longitude: 135.785 },
    businessStatus: 'OPERATIONAL',
  }

  it('施設を共通の形に正規化して返す（営業時間は要求しなければ not_requested）', async () => {
    const { client } = setup(() => jsonResponse({ places: [place] }))
    const result = await client.searchPlaces({ query: '清水寺' })

    expect(result).toEqual({
      status: 'found',
      candidates: [
        {
          placeId: 'ChIJ-sample-1',
          name: '清水寺',
          address: '日本、京都府京都市東山区清水１丁目２９４',
          location: { latitude: 34.9949, longitude: 135.785 },
          businessStatus: 'OPERATIONAL',
          openingHours: { status: 'not_requested' },
        },
      ],
    })
  })

  it('既定では営業時間（Enterprise）を要求せず、必要なときだけ要求する', async () => {
    const withoutHours = setup()
    await withoutHours.client.searchPlaces({ query: '清水寺' })
    const withHours = setup()
    await withHours.client.searchPlaces({ query: '清水寺', includeOpeningHours: true })

    const mask = (s: ReturnType<typeof setup>) =>
      new Headers(s.fetchFn.mock.calls[0][1]?.headers).get('X-Goog-FieldMask')
    expect(mask(withoutHours)).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus',
    )
    expect(mask(withHours)).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.regularOpeningHours.periods',
    )
  })

  it('営業時間を、曜日（0=日曜）・時・分つきで返す。minuteが無ければ0', async () => {
    const periods = [
      { open: { day: 6, hour: 9 }, close: { day: 6, hour: 17, minute: 30 } },
      { open: { day: 0, hour: 0, minute: 0 } },
    ]
    const { client } = setup(() =>
      jsonResponse({ places: [{ ...place, regularOpeningHours: { periods } }] }),
    )
    const result = await client.searchPlaces({ query: '清水寺', includeOpeningHours: true })

    expect(result.status === 'found' && result.candidates[0].openingHours).toEqual({
      status: 'available',
      periods: [
        { open: { day: 6, hour: 9, minute: 0 }, close: { day: 6, hour: 17, minute: 30 } },
        { open: { day: 0, hour: 0, minute: 0 }, close: undefined },
      ],
    })
  })

  it('営業時間を要求したのにデータが無い施設は unavailable（営業とも休みとも解釈しない）', async () => {
    const { client } = setup(() => jsonResponse({ places: [place] }))
    const result = await client.searchPlaces({ query: '清水寺', includeOpeningHours: true })

    expect(result.status === 'found' && result.candidates[0].openingHours).toEqual({
      status: 'unavailable',
    })
  })

  it('一部の営業時間の形式が不正でも、施設同定と他施設の営業時間を維持する', async () => {
    const { client } = setup(() =>
      jsonResponse({
        places: [
          { ...place, regularOpeningHours: { periods: [{ open: { day: 8, hour: 9 } }] } },
          { ...place, id: 'second', regularOpeningHours: { periods: [] } },
        ],
      }),
    )
    const result = await client.searchPlaces({ query: '清水寺', includeOpeningHours: true })
    expect(result.status).toBe('found')
    if (result.status !== 'found') throw new Error('施設が見つかりません')
    expect(result.candidates.map((candidate) => candidate.openingHours)).toEqual([
      { status: 'invalid' },
      { status: 'available', periods: [] },
    ])
    expect(result.candidates[0].placeId).toBe(place.id)
  })

  it('HTTP 200の空応答は「候補なし」（失敗ではない）', async () => {
    expect(await setup(() => jsonResponse({})).client.searchPlaces({ query: 'zzz' })).toEqual({
      status: 'no_candidates',
    })
    expect(
      await setup(() => jsonResponse({ places: [] })).client.searchPlaces({ query: 'zzz' }),
    ).toEqual({
      status: 'no_candidates',
    })
  })

  it('同名の候補が複数あるときは、順序を保って全件返す（選別は照合側）', async () => {
    const second = { ...place, id: 'ChIJ-sample-2', displayName: { text: '清水寺 別院' } }
    const { client } = setup(() => jsonResponse({ places: [place, second] }))
    const result = await client.searchPlaces({ query: '清水寺', maxResultCount: 2 })

    expect(result.status === 'found' && result.candidates.map((c) => c.placeId)).toEqual([
      'ChIJ-sample-1',
      'ChIJ-sample-2',
    ])
  })

  it('名称が無い施設は、空の名称で返す（名称一致の対象にならない）', async () => {
    const { client } = setup(() => jsonResponse({ places: [{ id: 'ChIJ-noname' }] }))
    const result = await client.searchPlaces({ query: '何か' })

    expect(result.status === 'found' && result.candidates[0]).toMatchObject({
      placeId: 'ChIJ-noname',
      name: '',
    })
  })

  it('検索範囲の偏り（locationBias）と件数・言語を指定できる', async () => {
    const { client, fetchFn } = setup()
    await client.searchPlaces({
      query: '昼食',
      maxResultCount: 2,
      locationBias: { latitude: 35, longitude: 135.78, radiusMeters: 15_000 },
    })

    expect(bodyOf(fetchFn)).toEqual({
      textQuery: '昼食',
      languageCode: 'ja',
      maxResultCount: 2,
      locationBias: { circle: { center: { latitude: 35, longitude: 135.78 }, radius: 15_000 } },
    })
  })

  it.each([
    ['空のクエリ', { query: '   ' }],
    ['長すぎるクエリ', { query: 'あ'.repeat(301) }],
    ['件数が多すぎる', { query: '清水寺', maxResultCount: 6 }],
    [
      '半径が大きすぎる',
      { query: '清水寺', locationBias: { latitude: 35, longitude: 135, radiusMeters: 60_000 } },
    ],
    [
      '緯度が範囲外',
      { query: '清水寺', locationBias: { latitude: 95, longitude: 135, radiusMeters: 100 } },
    ],
  ])('不正な指定（%s）は、APIを呼ばずに拒否し、値を含めない', async (_name, options) => {
    const { client, fetchFn, getAccessToken } = setup()
    const error = await failureOf(client.searchPlaces(options))

    expect(error.reason).toBe('invalid_request')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(error.message).not.toContain('清水寺')
  })

  it('応答の形式が想定と異なる場合は invalid_response', async () => {
    for (const body of [
      { places: 'x' },
      { places: [{ displayName: { text: 'ID無し' } }] },
      'null-not-json{',
    ]) {
      const { client } = setup(() => jsonResponse(body))
      expect((await failureOf(client.searchPlaces({ query: '清水寺' }))).reason).toBe(
        'invalid_response',
      )
    }
  })
})

describe('Routes: computeRoute', () => {
  const route = (duration: string, distanceMeters = 800) => ({
    routes: [{ duration, distanceMeters }],
  })

  it('所要時間と距離を返し、分は切り上げる（余裕の比較を安全側に倒す）', async () => {
    const cases: [string, number, number][] = [
      ['612s', 612, 11],
      ['600s', 600, 10],
      ['601s', 601, 11],
      ['0s', 0, 0],
    ]
    for (const [duration, seconds, minutes] of cases) {
      const { client } = setup(() => jsonResponse(route(duration)))
      expect(
        await client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
      ).toEqual({ status: 'found', durationSeconds: seconds, minutes, distanceMeters: 800 })
    }
  })

  it('出発地・目的地をPlace IDで指定し、所要時間と距離だけを要求する', async () => {
    const { client, fetchFn } = setup(() => jsonResponse(route('300s')))
    await client.computeRoute({
      originPlaceId: 'PLACE-A',
      destinationPlaceId: 'PLACE-B',
      mode: 'DRIVE',
    })

    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toBe(ROUTES_COMPUTE_URL)
    expect(new Headers(init?.headers).get('X-Goog-FieldMask')).toBe(
      'routes.duration,routes.distanceMeters',
    )
    expect(bodyOf(fetchFn)).toEqual({
      origin: { placeId: 'PLACE-A' },
      destination: { placeId: 'PLACE-B' },
      travelMode: 'DRIVE',
      languageCode: 'ja-JP',
    })
  })

  it('HTTP 200の空応答は「経路なし」で、移動時間0や到達可能とは解釈しない', async () => {
    for (const body of [{}, { routes: [] }]) {
      const { client } = setup(() => jsonResponse(body))
      expect(
        await client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
      ).toEqual({ status: 'no_route' })
    }
  })

  it('公共交通（TRANSIT）は対象外で、APIを呼ばずに拒否する', async () => {
    const { client, fetchFn } = setup()
    const options = { originPlaceId: 'A', destinationPlaceId: 'B', mode: 'TRANSIT' }
    // @ts-expect-error TRANSITは型として受け付けない。実行時の防御も確認する。
    const pending = client.computeRoute(options)
    const error = await failureOf(pending)

    expect(error.reason).toBe('unsupported_mode')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('Place IDが空なら、APIを呼ばずに拒否する', async () => {
    const { client, fetchFn } = setup()
    const error = await failureOf(
      client.computeRoute({ originPlaceId: ' ', destinationPlaceId: 'B', mode: 'WALK' }),
    )

    expect(error.reason).toBe('invalid_request')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each(['abc', '12', '-5s', '1.5.2s'])(
    '所要時間の形式が不正（%s）なら invalid_response',
    async (duration) => {
      const { client } = setup(() => jsonResponse(route(duration)))
      const error = await failureOf(
        client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
      )

      expect(error.reason).toBe('invalid_response')
    },
  )
})

describe('呼び出しの失敗（Places・Routes共通）', () => {
  const calls: [string, (client: MapsClient) => Promise<unknown>][] = [
    ['Places', (client) => client.searchPlaces({ query: '清水寺' })],
    [
      'Routes',
      (client) =>
        client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
    ],
  ]

  it.each(calls)(
    '%s: HTTPエラーは api_error とし、ステータスとGoogleの状態名だけを保持する',
    async (_name, call) => {
      for (const [status, apiStatus] of [
        [403, 'PERMISSION_DENIED'],
        [429, 'RESOURCE_EXHAUSTED'],
        [500, 'INTERNAL'],
      ] as const) {
        const body = {
          error: { code: status, status: apiStatus, message: `SECRET-DETAIL ${SECRET_TOKEN}` },
        }
        const { client } = setup(() => jsonResponse(body, status))
        const error = await failureOf(call(client))

        expect(error.reason).toBe('api_error')
        expect(error.status).toBe(status)
        expect(error.apiStatus).toBe(apiStatus)
        expect(error.message).not.toContain('SECRET-DETAIL')
        expect(error.message).not.toContain(SECRET_TOKEN)
      }
    },
  )

  it.each(calls)('%s: JSONでないエラー本文でも api_error（状態名なし）', async (_name, call) => {
    const { client } = setup(() => new Response('<html>Bad Gateway</html>', { status: 502 }))
    const error = await failureOf(call(client))

    expect(error).toMatchObject({ reason: 'api_error', status: 502, apiStatus: undefined })
  })

  it.each(calls)('%s: 接続できない場合は network', async (_name, call) => {
    const client = createMapsClient({
      auth: createMapsAuth('p', async () => 'tok'),
      fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')),
    })

    expect((await failureOf(call(client))).reason).toBe('network')
  })

  it.each(calls)(
    '%s: 応答が遅い場合は、時間切れで timeout（実際にAbortSignalで中止する）',
    async (_name, call) => {
      const hang = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          }),
      )
      const client = createMapsClient({
        auth: createMapsAuth('p', async () => 'tok'),
        fetchFn: hang,
        timeoutMs: 30,
      })

      expect((await failureOf(call(client))).reason).toBe('timeout')
    },
  )

  it.each(calls)('%s: 本文の受信中に切れた場合は network', async (_name, call) => {
    const broken = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('network error'))
          },
        }),
        { status: 200 },
      ),
    )
    const client = createMapsClient({
      auth: createMapsAuth('p', async () => 'tok'),
      fetchFn: broken,
    })

    expect((await failureOf(call(client))).reason).toBe('network')
  })
})

describe('認証と設定', () => {
  it('トークンを取得できなければ、APIを呼ばずに auth_failed とし、原因の内容を載せない', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const client = createMapsClient({
      auth: createMapsAuth('p', async () => {
        throw new Error(`credential detail ${SECRET_TOKEN}`)
      }),
      fetchFn,
    })
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.reason).toBe('auth_failed')
    expect(error.message).not.toContain(SECRET_TOKEN)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('トークンが空でも auth_failed（認証なしで送らない）', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const client = createMapsClient({ auth: createMapsAuth('p', async () => null), fetchFn })

    expect((await failureOf(client.searchPlaces({ query: '清水寺' }))).reason).toBe('auth_failed')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([{}, { GOOGLE_CLOUD_PROJECT: '  ' }])(
    'プロジェクトIDが未設定なら not_configured（%j）',
    (env) => {
      let thrown: unknown
      try {
        loadMapsConfig(env)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toMatchObject({ reason: 'not_configured' })
    },
  )

  it('遅延クライアントは、設定が無くても作成でき、呼び出し時に not_configured として拒否する', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchFn)
    try {
      const client = createLazyMapsClient({})

      expect((await failureOf(client.searchPlaces({ query: '清水寺' }))).reason).toBe(
        'not_configured',
      )
      expect(
        (
          await failureOf(
            client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
          )
        ).reason,
      ).toBe('not_configured')
      expect(fetchFn).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
