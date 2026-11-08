import { describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import { AuthRequiredError, VERIFY_TRIP_ENDPOINT, requestTripVerification } from './api-client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const withEvidence = () => ({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop, index) =>
    index === 0 ? { ...stop, placeId: 'ChIJ-verified' } : stop,
  ),
})

describe('requestTripVerification', () => {
  it('旅程を送り、根拠が付いた旅程を受け取る', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ status: 'verified', trip: withEvidence() }))

    const result = await requestTripVerification(sampleTrip, { fetchFn })

    expect(result).toEqual({ ok: true, trip: withEvidence() })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(VERIFY_TRIP_ENDPOINT)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ trip: JSON.parse(JSON.stringify(sampleTrip)) })
  })

  it.each([
    ['external_service_error', 502],
    ['service_unavailable', 503],
    ['invalid_request', 400],
    ['payload_too_large', 413],
  ] as const)('失敗 %s はHTTP %i のときだけ、その種類として扱う', async (status, httpStatus) => {
    const fetchFn = vi.fn().mockResolvedValue(json({ status, message: '説明' }, httpStatus))
    const result = await requestTripVerification(sampleTrip, { fetchFn })
    expect(result).toEqual({ ok: false, failure: { kind: status, message: '説明' } })
  })

  it('ステータスと本文が食い違う応答は想定外', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ status: 'external_service_error', message: '説明' }, 200))
    const result = await requestTripVerification(sampleTrip, { fetchFn })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'unexpected' } })
  })

  it('verifiedでもHTTP 200でなければ想定外', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ status: 'verified', trip: sampleTrip }, 201))
    const result = await requestTripVerification(sampleTrip, { fetchFn })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'unexpected' } })
  })

  it('予定の内容・時刻・固定が書き換えられて返ったら、採用しない', async () => {
    const tampered = (change: (stop: (typeof sampleTrip.stops)[number]) => object) =>
      json({
        status: 'verified',
        trip: {
          ...sampleTrip,
          stops: sampleTrip.stops.map((stop, index) =>
            index === 1 ? { ...stop, ...change(stop) } : stop,
          ),
        },
      })

    for (const change of [
      () => ({ name: '別の店' }),
      () => ({ plannedStartTime: '23:00' }),
      () => ({ durationMinutes: 5 }),
      (stop: (typeof sampleTrip.stops)[number]) => ({ isFixed: !stop.isFixed }),
    ]) {
      const fetchFn = vi.fn().mockResolvedValue(tampered(change))
      const result = await requestTripVerification(sampleTrip, { fetchFn })
      expect(result).toMatchObject({ ok: false, failure: { kind: 'unexpected' } })
    }
  })

  it('予定の種別（kind）が、変更・削除・追加されて返ったら、採用しない', async () => {
    type Stop = (typeof sampleTrip.stops)[number]
    const withKind = (kind: Stop['kind']) => ({
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop, index) => {
        if (index !== 1) return stop
        // 種別を外した予定（サンプルの予定は、種別を持たない）に、必要なら種別を付ける。
        return kind === undefined ? { ...stop } : { ...stop, kind }
      }),
    })
    const respond = (trip: unknown) => vi.fn().mockResolvedValue(json({ status: 'verified', trip }))

    // 変更（meal → sight）、削除（meal → なし）、追加（なし → meal）。
    for (const [sent, received] of [
      [withKind('meal'), withKind('sight')],
      [withKind('meal'), withKind(undefined)],
      [withKind(undefined), withKind('meal')],
    ]) {
      const result = await requestTripVerification(sent, { fetchFn: respond(received) })
      expect(result).toMatchObject({ ok: false, failure: { kind: 'unexpected' } })
    }

    // 種別が同じなら、採用する。
    const same = await requestTripVerification(withKind('meal'), {
      fetchFn: respond(withKind('meal')),
    })
    expect(same.ok).toBe(true)
  })

  it('学びの反映（learningApplications）や希望条件（preferences）が書き換えられて返ったら、採用しない', async () => {
    const tampered = [
      {
        ...sampleTrip,
        learningApplications: sampleTrip.learningApplications.map((item) => ({
          ...item,
          explanation: '書き換えられた説明',
        })),
      },
      { ...sampleTrip, learningApplications: [] },
      { ...sampleTrip, preferences: [...sampleTrip.preferences, '勝手に足した希望'] },
    ]
    for (const trip of tampered) {
      const fetchFn = vi.fn().mockResolvedValue(json({ status: 'verified', trip }))
      const result = await requestTripVerification(sampleTrip, { fetchFn })
      expect(result).toMatchObject({ ok: false, failure: { kind: 'unexpected' } })
    }
  })

  it('キーの並び順が違うだけの同じ内容は、採用する', async () => {
    const reverseKeys = (value: object): Record<string, unknown> =>
      Object.fromEntries(Object.entries(value).reverse())
    // 送る旅程のキーの並びを、契約の定義順と変えておく（応答は契約の並びで返る）。
    const sent = {
      ...reverseKeys(sampleTrip),
      stops: sampleTrip.stops.map(reverseKeys),
    } as unknown as typeof sampleTrip
    const fetchFn = vi.fn().mockResolvedValue(json({ status: 'verified', trip: withEvidence() }))

    const result = await requestTripVerification(sent, { fetchFn })

    expect(result.ok).toBe(true)
  })

  it('別の旅程（ID違い・版違い）が返ったら採用しない', async () => {
    for (const other of [
      { ...sampleTrip, id: 'trip-other' },
      { ...sampleTrip, version: sampleTrip.version + 1 },
    ]) {
      const fetchFn = vi.fn().mockResolvedValue(json({ status: 'verified', trip: other }))
      const result = await requestTripVerification(sampleTrip, { fetchFn })
      expect(result).toMatchObject({ ok: false, failure: { kind: 'unexpected' } })
    }
  })

  it('契約に反する旅程・JSONでない本文は想定外', async () => {
    const broken = vi
      .fn()
      .mockResolvedValue(json({ status: 'verified', trip: { ...sampleTrip, stops: [] } }))
    expect(await requestTripVerification(sampleTrip, { fetchFn: broken })).toMatchObject({
      ok: false,
      failure: { kind: 'unexpected' },
    })

    const html = vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }))
    expect(await requestTripVerification(sampleTrip, { fetchFn: html })).toMatchObject({
      ok: false,
      failure: { kind: 'unexpected' },
    })
  })

  it('接続できない・中止されたときは「中断」として扱う', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('network'))
    expect(await requestTripVerification(sampleTrip, { fetchFn })).toMatchObject({
      ok: false,
      failure: { kind: 'interrupted' },
    })
  })
})

describe('requestTripVerification: 認証・利用制限', () => {
  const authBodies = [
    [
      '本文がJSON（サーバーの標準のエラー形式）',
      JSON.stringify({ status: 'unauthorized', message: 'x' }),
    ],
    ['本文がHTML', '<html>Unauthorized</html>'],
    ['本文が空', ''],
  ] as const

  it.each([401, 403])(
    'HTTP %i は「認証が必要・失効」として扱い、結果を採用しない',
    async (status) => {
      for (const [, body] of authBodies) {
        const fetchFn = vi.fn().mockResolvedValue(new Response(body, { status }))
        const result = await requestTripVerification(sampleTrip, { fetchFn })
        expect(result).toEqual({
          ok: false,
          failure: {
            kind: 'unauthorized',
            message:
              '認証、招待、またはアプリの検証が通りませんでした。認証の有効期限が切れているか、このアカウントは利用できない可能性があります。',
          },
        })
      }
    },
  )

  it('HTTP 429 は「利用制限」として扱い、結果を採用しない（本文の形に依存しない）', async () => {
    for (const [, body] of authBodies) {
      const fetchFn = vi.fn().mockResolvedValue(new Response(body, { status: 429 }))
      const result = await requestTripVerification(sampleTrip, { fetchFn })
      expect(result).toEqual({
        ok: false,
        failure: { kind: 'rate_limited', message: '利用の回数が上限に達しています。' },
      })
    }
  })

  it('401・403・429 は、本文が「verified」の形でも採用しない', async () => {
    for (const status of [401, 403, 429]) {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(json({ status: 'verified', trip: withEvidence() }, status))
      const result = await requestTripVerification(sampleTrip, { fetchFn })
      expect(result.ok).toBe(false)
    }
  })

  it('認証と利用制限は、サーバーの本文の文言を表示に使わない（固定の文言を使う）', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ status: 'rate_limited', message: '内部の事情を含む文言' }, 429))
    const result = await requestTripVerification(sampleTrip, { fetchFn })
    expect(JSON.stringify(result)).not.toContain('内部の事情')
  })

  it('認証情報を用意できず送信しなかったとき（AuthRequiredError）は、通信の中断と区別する', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new AuthRequiredError())
    const result = await requestTripVerification(sampleTrip, { fetchFn })
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: 'auth_required',
        message: '認証情報を取得できなかったため、照合の依頼を送信しませんでした。',
      },
    })
  })

  it('認証基盤のエラー（ClientAuthError）は、その文言のまま、通信の中断と区別して伝える', async () => {
    const error = Object.assign(
      new Error('認証サービスに接続できません。時間をおいて再試行してください'),
      {
        name: 'ClientAuthError',
        code: 'unavailable',
      },
    )
    const fetchFn = vi.fn().mockRejectedValue(error)
    const result = await requestTripVerification(sampleTrip, { fetchFn })
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'auth_required', message: error.message },
    })
  })

  it('認証と無関係な例外（ネットワーク断・中止）は、これまでどおり「中断」', async () => {
    for (const error of [new TypeError('network'), new DOMException('aborted', 'AbortError')]) {
      const fetchFn = vi.fn().mockRejectedValue(error)
      expect(await requestTripVerification(sampleTrip, { fetchFn })).toMatchObject({
        ok: false,
        failure: { kind: 'interrupted' },
      })
    }
  })
})
