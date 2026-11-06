import {
  ApiError,
  BlockedReason,
  FinishReason,
  GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createGeminiJsonClient,
  createLazyVertexGeminiClient,
  DEFAULT_GEMINI_LOCATION,
  DEFAULT_GEMINI_MODEL,
  GeminiCallError,
  loadGeminiConfig,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  type GenerateContentFn,
} from './client'

const responseOf = (init: Partial<GenerateContentResponse>) =>
  Object.assign(new GenerateContentResponse(), init)

const completed = (text: string, finishReason: FinishReason = FinishReason.STOP) =>
  responseOf({
    candidates: [{ finishReason, content: { role: 'model', parts: [{ text }] } }],
  })

const request = {
  systemInstruction: 'システム指示',
  prompt: 'プロンプト',
  responseJsonSchema: { type: 'object' },
}

const clientWith = (generateContent: GenerateContentFn) =>
  createGeminiJsonClient({ model: 'test-model' }, generateContent)

const failureOf = async (client: ReturnType<typeof clientWith>): Promise<GeminiCallError> => {
  const error = await client.generateJson(request).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (!(error instanceof GeminiCallError)) {
    throw new Error('GeminiCallErrorで拒否されることを期待しました')
  }
  return error
}

describe('createGeminiJsonClient', () => {
  it('JSON出力・スキーマ・システム指示を指定して1回だけ呼び、生成されたJSON文字列を返す', async () => {
    const generateContent = vi.fn<GenerateContentFn>().mockResolvedValue(completed(' {"a":1} '))
    const text = await clientWith(generateContent).generateJson(request)

    expect(text).toBe('{"a":1}')
    expect(generateContent).toHaveBeenCalledTimes(1)
    expect(generateContent.mock.calls[0][0]).toMatchObject({
      model: 'test-model',
      contents: 'プロンプト',
      config: {
        systemInstruction: 'システム指示',
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        candidateCount: 1,
      },
    })
  })

  it('API呼び出しの失敗は api_error とし、HTTPステータスだけを保持する', async () => {
    const apiError = new ApiError({ message: '秘密を含みうる本文', status: 503 })
    const error = await failureOf(clientWith(vi.fn().mockRejectedValue(apiError)))

    expect(error.reason).toBe('api_error')
    expect(error.status).toBe(503)
    expect(error.message).not.toContain('秘密')
    expect(error.cause).toBe(apiError)
  })

  it('ネットワーク断などの一般的な例外も api_error として扱う', async () => {
    const error = await failureOf(clientWith(vi.fn().mockRejectedValue(new Error('ECONNRESET'))))

    expect(error.reason).toBe('api_error')
    expect(error.status).toBeUndefined()
  })

  it('入力が安全性判定で拒否された場合は blocked', async () => {
    const response = responseOf({ promptFeedback: { blockReason: BlockedReason.SAFETY } })
    const error = await failureOf(clientWith(vi.fn().mockResolvedValue(response)))

    expect(error.reason).toBe('blocked')
  })

  it('候補が無い応答は empty_response', async () => {
    const error = await failureOf(clientWith(vi.fn().mockResolvedValue(responseOf({}))))

    expect(error.reason).toBe('empty_response')
  })

  it.each([FinishReason.MAX_TOKENS, FinishReason.SAFETY])(
    '生成が %s で終了した応答は、壊れたJSONの可能性があるため使わない（incomplete）',
    async (finishReason) => {
      const error = await failureOf(
        clientWith(vi.fn().mockResolvedValue(completed('{"a":', finishReason))),
      )

      expect(error.reason).toBe('incomplete')
    },
  )

  it('本文が空または空白だけの応答は empty_response', async () => {
    const error = await failureOf(clientWith(vi.fn().mockResolvedValue(completed('   '))))

    expect(error.reason).toBe('empty_response')
  })
})

describe('loadGeminiConfig', () => {
  it('プロジェクトIDだけ設定すれば、既定のロケーション・モデルを使う', () => {
    expect(loadGeminiConfig({ GOOGLE_CLOUD_PROJECT: 'my-project' })).toEqual({
      project: 'my-project',
      location: DEFAULT_GEMINI_LOCATION,
      model: DEFAULT_GEMINI_MODEL,
    })
  })

  it('ロケーションとモデルを環境変数で切り替えられる（前後の空白は無視する）', () => {
    expect(
      loadGeminiConfig({
        GOOGLE_CLOUD_PROJECT: ' my-project ',
        GOOGLE_CLOUD_LOCATION: ' us-central1 ',
        GEMINI_MODEL: ' gemini-x ',
      }),
    ).toEqual({ project: 'my-project', location: 'us-central1', model: 'gemini-x' })
  })

  it.each([{}, { GOOGLE_CLOUD_PROJECT: '' }, { GOOGLE_CLOUD_PROJECT: '   ' }])(
    'プロジェクトIDが未設定なら not_configured（%j）',
    (env) => {
      let thrown: unknown
      try {
        loadGeminiConfig(env)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(GeminiCallError)
      expect(thrown).toMatchObject({ reason: 'not_configured' })
    },
  )
})

describe('createLazyVertexGeminiClient', () => {
  it('設定が無くても作成でき、呼び出し時に not_configured として拒否する', async () => {
    const client = createLazyVertexGeminiClient({})

    const error = await failureOf(client)
    expect(error.reason).toBe('not_configured')
  })
})

describe('費用の制御（呼び出し回数と出力量の上限）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('SDKへ、自動継続の無効化と出力トークン数の上限を指定する', async () => {
    const generateContent = vi.fn<GenerateContentFn>().mockResolvedValue(completed('{"a":1}'))
    await clientWith(generateContent).generateJson(request)

    const config = generateContent.mock.calls[0][0].config
    expect(config?.automaticContinuation).toBe(false)
    expect(config?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS)
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4096)
  })

  // 継続トークン付きの応答を3回返してから完了する、実SDKに対する偽のHTTP応答。
  const stubContinuingFetch = () => {
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls += 1
      const continuing = calls <= 3
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '{"a":' }] },
              finishReason: continuing ? 'CONTINUATION' : 'STOP',
              ...(continuing ? { continuationToken: `token-${calls}` } : {}),
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchFn)
    return fetchFn
  }

  it('【回帰】実SDKでも、継続トークンを返す応答に対してHTTP呼び出しは1回だけで、不完全として扱う', async () => {
    const fetchFn = stubContinuingFetch()
    const ai = new GoogleGenAI({ apiKey: 'dummy-test-key' })
    const client = createGeminiJsonClient({ model: 'test-model' }, (params) =>
      ai.models.generateContent(params),
    )

    const error = await failureOf(client)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(error.reason).toBe('incomplete')
  })

  it('【対照】自動継続を無効にしなければ、実SDKは内部で複数回HTTPを呼ぶ（上の回帰テストが有効であることの確認）', async () => {
    const fetchFn = stubContinuingFetch()
    const ai = new GoogleGenAI({ apiKey: 'dummy-test-key' })

    await ai.models.generateContent({ model: 'test-model', contents: 'x' })

    expect(fetchFn.mock.calls.length).toBeGreaterThan(1)
  })

  it('受け取る出力が文字数の上限を超えたら、使わずに失敗として扱う', async () => {
    const oversized = '{"a":"' + 'あ'.repeat(MAX_OUTPUT_CHARS) + '"}'
    const error = await failureOf(
      clientWith(vi.fn<GenerateContentFn>().mockResolvedValue(completed(oversized))),
    )

    expect(error.reason).toBe('incomplete')
  })

  it('上限ちょうどの文字数は受け取る（境界）', async () => {
    const exact = 'a'.repeat(MAX_OUTPUT_CHARS)
    const text = await clientWith(
      vi.fn<GenerateContentFn>().mockResolvedValue(completed(exact)),
    ).generateJson(request)

    expect(text).toHaveLength(MAX_OUTPUT_CHARS)
  })
})
