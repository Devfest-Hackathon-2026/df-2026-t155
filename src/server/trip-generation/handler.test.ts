import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../../tests/helpers/mock-cost-control'

import { GenerateTripResponseSchema, type GenerateTripResponse } from '../../domain'
import { sampleApprovedLearning, sampleGenerateTripRequest, sampleTrip } from '../../domain/samples'
import { sampleGenerateTripBody } from '../../../tests/helpers/generate-request'
import { LearningSelectionError } from '../learning-reuse/selection'
import { handleGenerateTripRequest, isTripGenerationEnabled, MAX_REQUEST_BYTES } from './handler'

// トークンの検証は実際のRouteテストで確認し、ここでは認証済みのHTTP処理を検証する。
vi.mock('../costly-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../costly-api')>()),
  requireCostlyApiActor: async () => ({ uid: 'test-actor' }),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/trips/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })

const postJson = (value: unknown) => post(JSON.stringify(value))

// 選択を解決する側は、既定では呼ばれない想定（呼ばれたらテストが失敗する）。
const handlerReturning = (
  response: GenerateTripResponse,
  resolveLearnings = vi.fn().mockRejectedValue(new Error('学びの解決は呼ばれない想定')),
) => {
  const generate = vi.fn().mockResolvedValue(response)
  return { generate, resolveLearnings, deps: { isEnabled: () => true, resolveLearnings, generate } }
}

describe('POST /api/trips/generate: 正常系', () => {
  it('入力を検証し、生成結果を200とキャッシュ禁止ヘッダーで返す', async () => {
    const { generate, resolveLearnings, deps } = handlerReturning({
      status: 'proposed',
      trip: sampleTrip,
    })
    const response = await handleGenerateTripRequest(postJson(sampleGenerateTripBody()), deps)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json()
    expect(GenerateTripResponseSchema.safeParse(body).success).toBe(true)
    expect(body.status).toBe('proposed')
    expect(generate).toHaveBeenCalledTimes(1)
    // 選択がなければ学びは空で、保存先は読まない。
    expect(generate.mock.calls[0][0]).toEqual({ ...sampleGenerateTripRequest, learnings: [] })
    expect(resolveLearnings).not.toHaveBeenCalled()
  })

  it.each([
    ['no_candidates', 422],
    ['insufficient_information', 422],
    ['external_service_error', 502],
  ] as const)('失敗 %s はHTTP %i で共通契約の失敗ペイロードを返す', async (status, httpStatus) => {
    const { deps } = handlerReturning({ status, message: '失敗の説明' })
    const response = await handleGenerateTripRequest(postJson(sampleGenerateTripBody()), deps)

    expect(response.status).toBe(httpStatus)
    expect(await response.json()).toEqual({ status, message: '失敗の説明' })
  })

  it('Content-Typeにcharsetが付いていても受け付ける', async () => {
    const { deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const request = post(JSON.stringify(sampleGenerateTripBody()), {
      'Content-Type': 'application/json; charset=utf-8',
    })
    expect((await handleGenerateTripRequest(request, deps)).status).toBe(200)
  })
})

describe('POST /api/trips/generate: 入力の拒否（外部呼び出しをしない）', () => {
  it('JSON以外のContent-Typeは415', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const request = post(JSON.stringify(sampleGenerateTripBody()), {
      'Content-Type': 'text/plain',
    })
    const response = await handleGenerateTripRequest(request, deps)

    expect(response.status).toBe(415)
    expect((await response.json()).status).toBe('unsupported_media_type')
    expect(generate).not.toHaveBeenCalled()
  })

  it('JSONとして解釈できない本文は400', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const response = await handleGenerateTripRequest(post('{壊れたJSON'), deps)

    expect(response.status).toBe(400)
    expect((await response.json()).status).toBe('invalid_request')
    expect(generate).not.toHaveBeenCalled()
  })

  it('契約に違反する入力は400で、どの項目が不正かを返す', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const invalid = { ...sampleGenerateTripRequest, date: '2026/11/08', unknownKey: true }
    const response = await handleGenerateTripRequest(postJson(invalid), deps)

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.status).toBe('invalid_request')
    expect(body.issues.length).toBeGreaterThan(0)
    expect(generate).not.toHaveBeenCalled()
  })

  it('旧形式の learnings（承認済みの本文）を含む入力は、承認済みに見えても400で拒否する（自己申告を信用しない）', async () => {
    const { generate, resolveLearnings, deps } = handlerReturning({
      status: 'proposed',
      trip: sampleTrip,
    })
    const legacy = { ...sampleGenerateTripBody(), learnings: [sampleApprovedLearning] }
    const response = await handleGenerateTripRequest(postJson(legacy), deps)

    expect(response.status).toBe(400)
    expect((await response.json()).status).toBe('invalid_request')
    expect(generate).not.toHaveBeenCalled()
    expect(resolveLearnings).not.toHaveBeenCalled()
  })

  it('learnings だけの旧形式（learningSelections なし）も400', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const legacy = { ...sampleGenerateTripRequest }
    const response = await handleGenerateTripRequest(postJson(legacy), deps)

    expect(response.status).toBe(400)
    expect(generate).not.toHaveBeenCalled()
  })

  it.each([
    ['版のないID', [{ id: 'learning-a' }]],
    ['IDだけの文字列', ['learning-a']],
    ['版が0', [{ id: 'learning-a', version: 0 }]],
    ['本文が付いた選択', [{ id: 'learning-a', version: 1, content: '本文' }]],
    [
      'IDの重複',
      [
        { id: 'learning-a', version: 1 },
        { id: 'learning-a', version: 2 },
      ],
    ],
  ])('学びの選択が不正（%s）なら400で、保存先も生成も呼ばない', async (_label, selections) => {
    const { generate, resolveLearnings, deps } = handlerReturning({
      status: 'proposed',
      trip: sampleTrip,
    })
    const body = { ...sampleGenerateTripBody(), learningSelections: selections }
    const response = await handleGenerateTripRequest(postJson(body), deps)

    expect(response.status).toBe(400)
    expect(resolveLearnings).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('空の本文は400', async () => {
    const { deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    expect((await handleGenerateTripRequest(post(''), deps)).status).toBe(400)
  })

  it('本文が上限を超える場合は413（ヘッダー申告が無くても本文の大きさで拒否する）', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const huge = { ...sampleGenerateTripBody(), preferences: ['あ'.repeat(MAX_REQUEST_BYTES)] }
    const response = await handleGenerateTripRequest(postJson(huge), deps)

    expect(response.status).toBe(413)
    expect((await response.json()).status).toBe('payload_too_large')
    expect(generate).not.toHaveBeenCalled()
  })

  it('Content-Lengthが上限を超える申告は本文を読まずに413', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const request = post(JSON.stringify(sampleGenerateTripRequest), {
      'Content-Length': String(MAX_REQUEST_BYTES + 1),
    })
    const response = await handleGenerateTripRequest(request, deps)

    expect(response.status).toBe(413)
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('POST /api/trips/generate: 想定外の失敗', () => {
  it('生成処理が例外を投げたら500とし、例外の内容を応答に含めない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generate = vi.fn().mockRejectedValue(new Error('Bearer dummy-secret-value'))
    const response = await handleGenerateTripRequest(postJson(sampleGenerateTripBody()), {
      isEnabled: () => true,
      resolveLearnings: vi.fn(),
      generate,
    })

    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).toContain('internal_error')
    expect(text).not.toContain('dummy-secret-value')
  })

  it('生成処理の応答が共通契約に違反していたら500とし、クライアントへ流さない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // 型としては通るが、3〜4地点という契約に違反する応答。
    const broken: GenerateTripResponse = {
      status: 'proposed',
      trip: { ...sampleTrip, stops: sampleTrip.stops.slice(0, 2) },
    }
    const { deps } = handlerReturning(broken)
    const response = await handleGenerateTripRequest(postJson(sampleGenerateTripBody()), deps)

    expect(response.status).toBe(500)
    expect((await response.json()).status).toBe('internal_error')
  })
})

describe('POST /api/trips/generate: 機能フラグ（認証・利用制限が入るまで既定は無効）', () => {
  it.each([undefined, '', 'false', '1', 'TRUE', 'yes'])(
    'TRIP_GENERATION_ENABLED=%s は無効として扱う',
    (value) => {
      expect(isTripGenerationEnabled({ TRIP_GENERATION_ENABLED: value })).toBe(false)
    },
  )

  it('未設定の環境でも無効（既定は停止）', () => {
    expect(isTripGenerationEnabled({})).toBe(false)
  })

  it("'true'（前後の空白は許容）のときだけ有効", () => {
    expect(isTripGenerationEnabled({ TRIP_GENERATION_ENABLED: 'true' })).toBe(true)
    expect(isTripGenerationEnabled({ TRIP_GENERATION_ENABLED: ' true ' })).toBe(true)
  })

  it('無効の間は503を返し、生成（Gemini呼び出し）も本文の読み取りもしない', async () => {
    const generate = vi.fn()
    const request = postJson(sampleGenerateTripBody())
    const resolveLearnings = vi.fn()
    const response = await handleGenerateTripRequest(request, {
      isEnabled: () => false,
      resolveLearnings,
      generate,
    })

    expect(response.status).toBe(503)
    expect((await response.json()).status).toBe('service_unavailable')
    expect(generate).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
  })

  it('不正な入力でも、無効の間は入力の検証より先に503を返す', async () => {
    const generate = vi.fn()
    const response = await handleGenerateTripRequest(post('{壊れたJSON'), {
      isEnabled: () => false,
      resolveLearnings: vi.fn(),
      generate,
    })

    expect(response.status).toBe(503)
  })
})

describe('POST /api/trips/generate: 学びの選択（{ id, version } だけを受け、サーバーが解決する）', () => {
  const selections = [{ id: sampleApprovedLearning.id, version: 2 }]

  it('選択を検証済みActorのUID・地域とともにresolverへ渡し、解決された学びだけを生成に渡す', async () => {
    const resolveLearnings = vi.fn().mockResolvedValue([sampleApprovedLearning])
    const { generate, deps } = handlerReturning(
      { status: 'proposed', trip: sampleTrip },
      resolveLearnings,
    )
    const response = await handleGenerateTripRequest(
      postJson(sampleGenerateTripBody(selections)),
      deps,
    )

    expect(response.status).toBe(200)
    // UIDは本文ではなく、認証済みActor（このテストでは 'test-actor'）から取る。
    expect(resolveLearnings).toHaveBeenCalledWith('test-actor', sampleTrip.region, selections)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0]).toEqual({
      ...sampleGenerateTripRequest,
      learnings: [sampleApprovedLearning],
    })
    // 内部の要求には選択の欄は残らない。
    expect(generate.mock.calls[0][0]).not.toHaveProperty('learningSelections')
  })

  it('選んだ学びが変更・撤回されていたら409 selection_changed。生成（Gemini）は呼ばない', async () => {
    const resolveLearnings = vi
      .fn()
      .mockRejectedValue(new LearningSelectionError('selection_changed'))
    const { generate, deps } = handlerReturning(
      { status: 'proposed', trip: sampleTrip },
      resolveLearnings,
    )
    const response = await handleGenerateTripRequest(
      postJson(sampleGenerateTripBody(selections)),
      deps,
    )

    expect(response.status).toBe(409)
    expect((await response.json()).status).toBe('selection_changed')
    expect(generate).not.toHaveBeenCalled()
  })

  it('保存済みの学びを確認できなければ503 learnings_unavailable（機能停止の service_unavailable とは別）', async () => {
    const resolveLearnings = vi.fn().mockRejectedValue(new LearningSelectionError('unavailable'))
    const { generate, deps } = handlerReturning(
      { status: 'proposed', trip: sampleTrip },
      resolveLearnings,
    )
    const response = await handleGenerateTripRequest(
      postJson(sampleGenerateTripBody(selections)),
      deps,
    )

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('learnings_unavailable')
    expect(body.message).toContain('学びを使わずに')
    expect(generate).not.toHaveBeenCalled()
  })

  it('resolverの想定外の例外は500とし、内容を応答に含めない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const resolveLearnings = vi.fn().mockRejectedValue(new Error('Bearer dummy-secret-value'))
    const { generate, deps } = handlerReturning(
      { status: 'proposed', trip: sampleTrip },
      resolveLearnings,
    )
    const response = await handleGenerateTripRequest(
      postJson(sampleGenerateTripBody(selections)),
      deps,
    )

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('dummy-secret-value')
    expect(generate).not.toHaveBeenCalled()
  })

  it('学びを含む生成が32KBを超える本文制限の影響を受けない（解決された学びは本文の大きさに数えない）', async () => {
    const longLearning = { ...sampleApprovedLearning, content: 'あ'.repeat(120) }
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...longLearning,
      id: 'learning-' + index,
    }))
    const resolveLearnings = vi.fn().mockResolvedValue(many)
    const { generate, deps } = handlerReturning(
      { status: 'proposed', trip: sampleTrip },
      resolveLearnings,
    )
    const request = postJson(
      sampleGenerateTripBody(many.map((learning) => ({ id: learning.id, version: 1 }))),
    )
    const response = await handleGenerateTripRequest(request, deps)

    expect(response.status).toBe(200)
    expect(generate.mock.calls[0][0].learnings).toHaveLength(40)
  })
})

// 本文をストリームで与えるリクエスト（Content-Lengthなし）を作る。
const streamRequest = (stream: ReadableStream<Uint8Array>) =>
  new Request('http://localhost/api/trips/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit)

describe('POST /api/trips/generate: 本文のストリーム読み取り', () => {
  it('上限を超えた時点で読み取りを中止し、残りを読み込まない（413）', async () => {
    let pulled = 0
    let cancelled = false
    const chunk = new Uint8Array(10 * 1024).fill(0x61)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(chunk) // 終わらない巨大な本文
      },
      cancel() {
        cancelled = true
      },
    })
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const response = await handleGenerateTripRequest(streamRequest(stream), deps)

    expect(response.status).toBe(413)
    expect((await response.json()).status).toBe('payload_too_large')
    expect(cancelled).toBe(true)
    // 上限（32KB）を超えた直後で止まる。全量を読み込もうとしていない。
    expect(pulled).toBeLessThan(10)
    expect(generate).not.toHaveBeenCalled()
  })

  it('読み取り中にストリームが失敗しても、安全に400を返す', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"date":'))
        controller.error(new Error('接続が切断されました'))
      },
    })
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const response = await handleGenerateTripRequest(streamRequest(stream), deps)

    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('invalid_request')
    expect(text).not.toContain('切断')
    expect(generate).not.toHaveBeenCalled()
  })

  it('複数のチャンクに分かれた本文（日本語の文字の途中で分割されても）を正しく読む', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(sampleGenerateTripBody()))
    // 3バイト文字の途中（1バイト目の直後）を含む、細かい分割。
    const chunks = [0, 7, 8, 9, 10, 31, 200].map((start, index, all) =>
      bytes.slice(start, all[index + 1] ?? bytes.length),
    )
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk))
        controller.close()
      },
    })
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const response = await handleGenerateTripRequest(streamRequest(stream), deps)

    expect(response.status).toBe(200)
    expect(generate.mock.calls[0][0]).toEqual({ ...sampleGenerateTripRequest, learnings: [] })
  })

  it('上限ちょうどの本文は受け付け、1バイト超えると拒否する（境界）', async () => {
    const withPadding = (size: number) => {
      const base = JSON.stringify({ pad: '' })
      return '{"pad":"' + 'a'.repeat(size - base.length) + '"}'
    }
    const { deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })

    const exact = await handleGenerateTripRequest(post(withPadding(MAX_REQUEST_BYTES)), deps)
    // 上限内なので読み取りは成功し、内容が契約違反であるため400（413ではない）。
    expect((await exact.json()).status).toBe('invalid_request')

    const over = await handleGenerateTripRequest(post(withPadding(MAX_REQUEST_BYTES + 1)), deps)
    expect(over.status).toBe(413)
  })

  it('UTF-8として不正なバイト列は400', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))
        controller.close()
      },
    })
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const response = await handleGenerateTripRequest(streamRequest(stream), deps)

    expect(response.status).toBe(400)
    expect(generate).not.toHaveBeenCalled()
  })
})
