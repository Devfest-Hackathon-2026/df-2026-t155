import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai'

// Vertex AI経由のGemini呼び出しアダプター。SDKの生レスポンスは外へ出さず、
// 生成されたJSON文字列だけを返す。認証はサーバーのADC（サービスアカウント）で行い、
// APIキーやトークンをクライアントへ渡さない。

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'
export const DEFAULT_GEMINI_LOCATION = 'global'
// 1回の旅程生成に許す時間。SDKの自動再試行は無効にし、課金される呼び出しを増やさない。
export const GEMINI_TIMEOUT_MS = 45_000
// 出力の上限。旅程の下書き（最大4地点のJSON）は数百トークン程度だが、思考に使われる
// トークンも含まれる可能性があるため、十分な余裕を持たせた上で費用の上限を決める。
// 実Gemini（gemini-3.5-flash）で通常の生成が収まることは未確認のため、確認後に見直す。
export const MAX_OUTPUT_TOKENS = 8192
// 受け取るJSON文字列の上限（4地点の下書きに対して十分大きく、暴走した出力を弾ける大きさ）。
export const MAX_OUTPUT_CHARS = 16_000

export type GeminiCallFailureReason =
  'not_configured' | 'api_error' | 'blocked' | 'incomplete' | 'empty_response'

// 原因の区分だけを運ぶ。プロンプトや利用者の入力、認証情報はメッセージに含めない。
export class GeminiCallError extends Error {
  readonly reason: GeminiCallFailureReason
  readonly status?: number

  constructor(
    reason: GeminiCallFailureReason,
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GeminiCallError'
    this.reason = reason
    this.status = options?.status
  }
}

export interface GeminiJsonRequest {
  systemInstruction: string
  prompt: string
  responseJsonSchema: unknown
}

export interface GeminiJsonClient {
  // スキーマに沿ったJSON文字列を返す。内容の検証は呼び出し側が行う。
  generateJson(request: GeminiJsonRequest, signal?: AbortSignal): Promise<string>
}

export interface GeminiConfig {
  project: string
  location: string
  model: string
}

export function loadGeminiConfig(env: Record<string, string | undefined>): GeminiConfig {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim()
  if (!project) {
    throw new GeminiCallError('not_configured', 'GOOGLE_CLOUD_PROJECTが設定されていません')
  }
  return {
    project,
    location: env.GOOGLE_CLOUD_LOCATION?.trim() || DEFAULT_GEMINI_LOCATION,
    model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
  }
}

export type GenerateContentFn = (
  params: GenerateContentParameters,
) => Promise<GenerateContentResponse>

// SDK呼び出しを注入できるようにし、単体テストで実際のVertex AIへ接続しない。
export function createGeminiJsonClient(
  config: Pick<GeminiConfig, 'model'>,
  generateContent: GenerateContentFn,
): GeminiJsonClient {
  return {
    async generateJson({ systemInstruction, prompt, responseJsonSchema }, signal) {
      let response: GenerateContentResponse
      try {
        signal?.throwIfAborted()
        response = await generateContent({
          model: config.model,
          contents: prompt,
          config: {
            ...(signal && { abortSignal: signal }),
            systemInstruction,
            responseMimeType: 'application/json',
            responseJsonSchema,
            candidateCount: 1,
            // SDKは既定で、継続トークンを受け取るたびに同じリクエストを自動で再送する
            // （各リクエストに課金が発生する）。1リクエスト1呼び出しにするため無効にする。
            automaticContinuation: false,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        })
      } catch (cause) {
        const status = cause instanceof ApiError ? cause.status : undefined
        throw new GeminiCallError('api_error', 'Gemini APIの呼び出しに失敗しました', {
          cause,
          status,
        })
      }

      if (response.promptFeedback?.blockReason) {
        throw new GeminiCallError('blocked', 'リクエストがGeminiの安全性判定で拒否されました')
      }
      const candidate = response.candidates?.[0]
      if (!candidate) {
        throw new GeminiCallError('empty_response', 'Geminiの応答に候補がありません')
      }
      if (candidate.finishReason !== undefined && candidate.finishReason !== FinishReason.STOP) {
        // MAX_TOKENS・CONTINUATION等で途中終了したJSONは壊れているため、使わない。
        throw new GeminiCallError(
          'incomplete',
          `Geminiの生成が完了しませんでした（${candidate.finishReason}）`,
        )
      }
      const text = response.text?.trim()
      if (!text) {
        throw new GeminiCallError('empty_response', 'Geminiの応答が空です')
      }
      // トークン数の上限とは別に、受け取る文字列の大きさも制限する。
      if (text.length > MAX_OUTPUT_CHARS) {
        throw new GeminiCallError('incomplete', 'Geminiの出力が上限を超えました')
      }
      return text
    },
  }
}

export function createVertexGeminiClient(config: GeminiConfig): GeminiJsonClient {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: config.project,
    location: config.location,
    httpOptions: { timeout: GEMINI_TIMEOUT_MS, retryOptions: { attempts: 1 } },
  })
  return createGeminiJsonClient(config, (params) => ai.models.generateContent(params))
}

// 設定の読み込みと接続の準備を最初の呼び出しまで遅らせる。環境変数が未設定でも
// ビルドやモジュール読み込みは失敗せず、呼び出し時にGeminiCallErrorとして扱える。
export function createLazyVertexGeminiClient(
  env: Record<string, string | undefined>,
): GeminiJsonClient {
  let client: GeminiJsonClient | undefined
  return {
    async generateJson(request, signal) {
      client ??= createVertexGeminiClient(loadGeminiConfig(env))
      return client.generateJson(request, signal)
    },
  }
}
