import {
  GenerateTripRequestSchema,
  GenerateTripResponseSchema,
  type GenerateTripRequest,
  type GenerateTripResponse,
} from '../../domain'

// POST /api/trips/generate のHTTP処理。Route Handlerは薄く保ち、検証とステータスの対応は
// ここでテストできるようにする。認証・レート制限は未実装（認証は#10の範囲）。
// 課金を伴う外部呼び出しの入口なので、認証・利用制限が入るまでは機能フラグ（既定は無効）で
// 停止しておく。無効の間はGeminiを呼ばず、リクエスト本文も読まない。

// 旅行条件として十分大きい上限。巨大な入力でプロンプトの費用が膨らむのを防ぐ。
export const MAX_REQUEST_BYTES = 32 * 1024

// 認証・利用制限が入るまでは既定で無効。TRIP_GENERATION_ENABLED=true のときだけ受け付ける。
// 'true'以外の値・未設定はすべて無効として扱う。
export const isTripGenerationEnabled = (env: Record<string, string | undefined>): boolean =>
  env.TRIP_GENERATION_ENABLED?.trim() === 'true'

export interface GenerateTripHandlerDeps {
  // 旅程生成を受け付けるか（機能フラグ）。リクエストごとに評価する。
  isEnabled: () => boolean
  generate: (request: GenerateTripRequest) => Promise<GenerateTripResponse>
}

// 共通契約（GenerateTripResponse）に含まれない、API層だけのエラー。
export type ApiErrorStatus =
  | 'service_unavailable'
  | 'invalid_request'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'internal_error'

export interface ApiErrorBody {
  status: ApiErrorStatus
  message: string
  issues?: { path: string; message: string }[]
}

const HEADERS = { 'Cache-Control': 'no-store' }

const errorResponse = (httpStatus: number, body: ApiErrorBody): Response =>
  Response.json(body, { status: httpStatus, headers: HEADERS })

const HTTP_STATUS_BY_FAILURE = {
  no_candidates: 422,
  insufficient_information: 422,
  external_service_error: 502,
} as const

type BodyReadResult = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' }

// 本文をストリームで読み、上限を超えた時点で読み取りを中止する。
// 全量を読み込んでから大きさを判定すると、巨大な本文でメモリを消費してしまう。
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<BodyReadResult> {
  if (!request.body) return { ok: true, text: '' }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    // 接続の切断など、ストリームの読み取り失敗。
    return { ok: false, reason: 'unreadable' }
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(merged) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

export async function handleGenerateTripRequest(
  request: Request,
  deps: GenerateTripHandlerDeps,
): Promise<Response> {
  if (!deps.isEnabled()) {
    return errorResponse(503, {
      status: 'service_unavailable',
      message: '旅程の生成は現在利用できません。',
    })
  }

  // 単純なフォーム送信など、JSON以外の形式で外部呼び出しを起こされないようにする。
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, {
      status: 'unsupported_media_type',
      message: 'Content-Typeにapplication/jsonを指定してください。',
    })
  }

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return errorResponse(413, {
      status: 'payload_too_large',
      message: '旅行条件のデータが大きすぎます。',
    })
  }

  const bodyRead = await readBodyWithLimit(request, MAX_REQUEST_BYTES)
  if (!bodyRead.ok) {
    return bodyRead.reason === 'too_large'
      ? errorResponse(413, {
          status: 'payload_too_large',
          message: '旅行条件のデータが大きすぎます。',
        })
      : errorResponse(400, {
          status: 'invalid_request',
          message: 'リクエスト本文を読み取れませんでした。',
        })
  }

  let json: unknown
  try {
    json = JSON.parse(bodyRead.text)
  } catch {
    return errorResponse(400, {
      status: 'invalid_request',
      message: 'リクエストをJSONとして解釈できません。',
    })
  }

  const parsedRequest = GenerateTripRequestSchema.safeParse(json)
  if (!parsedRequest.success) {
    return errorResponse(400, {
      status: 'invalid_request',
      message: '旅行条件の形式が正しくありません。',
      issues: parsedRequest.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }

  let result: GenerateTripResponse
  try {
    result = await deps.generate(parsedRequest.data)
  } catch (error) {
    console.error('[trip-generation] 想定外のエラー', error instanceof Error ? error.name : error)
    return errorResponse(500, {
      status: 'internal_error',
      message: '旅程の生成中に予期しないエラーが発生しました。',
    })
  }

  // 返却前にも共通契約で検証し、契約に反する応答をクライアントへ流さない。
  const parsedResponse = GenerateTripResponseSchema.safeParse(result)
  if (!parsedResponse.success) {
    console.error('[trip-generation] 応答が共通契約に違反')
    return errorResponse(500, {
      status: 'internal_error',
      message: '旅程の生成中に予期しないエラーが発生しました。',
    })
  }

  const body = parsedResponse.data
  const httpStatus = body.status === 'proposed' ? 200 : HTTP_STATUS_BY_FAILURE[body.status]
  return Response.json(body, { status: httpStatus, headers: HEADERS })
}
