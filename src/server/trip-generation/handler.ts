import {
  GenerateTripRequestSchema,
  GenerateTripResponseSchema,
  type GenerateTripRequest,
  type GenerateTripResponse,
} from '../../domain'
import { COSTS } from '../cost-control/costs'
import {
  isCostlyApiEnabled,
  requireCostlyApiActor,
  runCostlyOperation,
  type CostlyOperation,
} from '../costly-api'
import { errorResponse, noStoreHeaders, readBodyWithLimit } from '../http'

export type { ApiErrorBody, ApiErrorStatus } from '../http'

// POST /api/trips/generate のHTTP処理。Route Handlerは薄く保ち、検証とステータスの対応は
// ここでテストできるようにする。停止中は認証・本文の読み取り・Gemini呼び出しを行わない。

// 旅行条件として十分大きい上限。巨大な入力でプロンプトの費用が膨らむのを防ぐ。
export const MAX_REQUEST_BYTES = 32 * 1024

// 既定で無効。TRIP_GENERATION_ENABLED=true のときだけ受け付ける。
// 'true'以外の値・未設定はすべて無効として扱う。
export const isTripGenerationEnabled = (env: Record<string, string | undefined>): boolean =>
  isCostlyApiEnabled(env.TRIP_GENERATION_ENABLED)

export interface GenerateTripHandlerDeps {
  // 旅程生成を受け付けるか（機能フラグ）。リクエストごとに評価する。
  isEnabled: () => boolean
  generate: (
    request: GenerateTripRequest,
    operation: CostlyOperation,
  ) => Promise<GenerateTripResponse>
}

const HTTP_STATUS_BY_FAILURE = {
  no_candidates: 422,
  insufficient_information: 422,
  external_service_error: 502,
} as const

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
  const actor = await requireCostlyApiActor(request)
  if (actor instanceof Response) return actor

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
    const outcome = await runCostlyOperation(actor, COSTS.generate, (operation) =>
      deps.generate(parsedRequest.data, operation),
    )
    if (outcome instanceof Response) return outcome
    result = outcome
  } catch {
    console.error('[trip-generation] 想定外のエラー')
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
  return Response.json(body, { status: httpStatus, headers: noStoreHeaders })
}
