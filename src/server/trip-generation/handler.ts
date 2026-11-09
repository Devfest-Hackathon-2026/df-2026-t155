import {
  GenerateTripRequestSchema,
  GenerateTripResponseSchema,
  type ApprovedLearning,
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
import { LearningSelectionError } from '../learning-reuse/selection'
import type { LearningSelection } from '../persistence/contracts'
import { acceptsLearningTripProtocol } from '../persistence/learning-trip-rollout'
import { attachLearningSaveProof } from '../persistence/learning-trip-provenance'
import { GenerateTripHttpRequestSchema } from './http-request'

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
  // 利用者が選んだ学び（{ id, version }）を、本人の保存済みデータと照合して確定する。
  // 本文のlearningsは受け付けないため、Geminiへ渡る学びはここで検証されたものだけになる。
  // 選択が空のときは呼ばれない。失敗は LearningSelectionError で表す。
  resolveLearnings: (
    ownerUid: string,
    region: string,
    selections: readonly LearningSelection[],
  ) => Promise<ApprovedLearning[]>
  // 検証済みの学びを含む内部の要求を受け取る（HTTPで再構築しないため、本文の32KB上限の影響を受けない）。
  generate: (
    request: GenerateTripRequest,
    operation: CostlyOperation,
  ) => Promise<GenerateTripResponse>
}

// 学びの選択の失敗を、HTTP応答に変換する。内部の詳細は含めない。
// 503は機能停止（service_unavailable）と区別するため、別のstatusにする。
const selectionErrorResponse = (error: LearningSelectionError): Response =>
  errorResponse(error.status, {
    status:
      error.code === 'invalid_selection'
        ? 'invalid_request'
        : error.code === 'selection_changed'
          ? 'selection_changed'
          : 'learnings_unavailable',
    message: error.message,
  })

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

  const parsedRequest = GenerateTripHttpRequestSchema.safeParse(json)
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
    const { learningSelections, ...conditions } = parsedRequest.data
    // 選択があるときだけ、保存済みの学びを読む分の枠を予約する。
    const cost = learningSelections.length > 0 ? COSTS.generateWithLearnings : COSTS.generate
    const outcome = await runCostlyOperation(
      actor,
      cost,
      async (operation): Promise<GenerateTripResponse | Response> => {
        let learnings: ApprovedLearning[] = []
        if (learningSelections.length > 0) {
          operation.assertActive()
          try {
            learnings = await deps.resolveLearnings(
              actor.uid,
              conditions.region,
              learningSelections,
            )
          } catch (error) {
            // 選び直し（409）や、学びを使わずに作る案内（503）は、Geminiを呼ばずに返す。
            if (error instanceof LearningSelectionError) return selectionErrorResponse(error)
            throw error
          }
        }
        // サーバーが確定した学びだけを内部の要求に入れる。契約に反すれば想定外の失敗として扱う。
        const internal = GenerateTripRequestSchema.parse({ ...conditions, learnings })
        const generated = GenerateTripResponseSchema.parse(await deps.generate(internal, operation))
        return attachLearningSaveProof(
          actor,
          generated,
          learningSelections,
          internal.learnings,
          acceptsLearningTripProtocol(request),
        )
      },
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
