import { errorResponse, noStoreHeaders, readBodyWithLimit } from '../http'
import { LearningReviewInputSchema, type LearningReviewInput } from './candidates-input'
import {
  LearningCandidatesResponseSchema,
  type LearningCandidatesResponse,
} from './generate-candidates'

// POST /api/learnings/candidates のHTTP処理。振り返りの材料から、学びの「候補」（未承認）を作る。
// 承認・保存は本人の操作で、このAPIでは行わない（認証が入ってから別のAPIで扱う）。
// 課金を伴うGemini呼び出しの入口なので、認証・利用制限が入るまでは機能フラグ（既定は無効）で停止する。
// 無効の間はGeminiを呼ばず、リクエスト本文も読まない。

// 旅程・変更履歴・感想を含む入力の上限。巨大な入力でプロンプトの費用が膨らむのを防ぐ。
export const MAX_LEARNING_REQUEST_BYTES = 64 * 1024

export const isLearningCandidatesEnabled = (env: Record<string, string | undefined>): boolean =>
  env.LEARNING_CANDIDATES_ENABLED?.trim() === 'true'

export interface LearningCandidatesHandlerDeps {
  isEnabled: () => boolean
  generate: (input: LearningReviewInput) => Promise<LearningCandidatesResponse>
}

const HTTP_STATUS_BY_FAILURE = {
  no_candidates: 422,
  insufficient_information: 422,
  external_service_error: 502,
} as const

export async function handleLearningCandidatesRequest(
  request: Request,
  deps: LearningCandidatesHandlerDeps,
): Promise<Response> {
  if (!deps.isEnabled()) {
    return errorResponse(503, {
      status: 'service_unavailable',
      message: '学びの候補の作成は現在利用できません。',
    })
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, {
      status: 'unsupported_media_type',
      message: 'Content-Typeにapplication/jsonを指定してください。',
    })
  }
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LEARNING_REQUEST_BYTES) {
    return errorResponse(413, {
      status: 'payload_too_large',
      message: '入力データが大きすぎます。',
    })
  }

  const bodyRead = await readBodyWithLimit(request, MAX_LEARNING_REQUEST_BYTES)
  if (!bodyRead.ok) {
    return bodyRead.reason === 'too_large'
      ? errorResponse(413, { status: 'payload_too_large', message: '入力データが大きすぎます。' })
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
  const parsed = LearningReviewInputSchema.safeParse(json)
  if (!parsed.success) {
    return errorResponse(400, {
      status: 'invalid_request',
      message: '振り返りの入力の形式が正しくありません。',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }

  let result: LearningCandidatesResponse
  try {
    result = await deps.generate(parsed.data)
  } catch (error) {
    console.error(
      '[learning-candidates] 想定外のエラー',
      error instanceof Error ? error.name : error,
    )
    return errorResponse(500, {
      status: 'internal_error',
      message: '学びの候補の作成中に予期しないエラーが発生しました。',
    })
  }

  // 返却前にも検証し、契約に反する応答（承認済みの学びを含む等）をクライアントへ流さない。
  const checked = LearningCandidatesResponseSchema.safeParse(result)
  if (!checked.success) {
    console.error('[learning-candidates] 応答が契約に違反')
    return errorResponse(500, {
      status: 'internal_error',
      message: '学びの候補の作成中に予期しないエラーが発生しました。',
    })
  }
  const body = checked.data
  const httpStatus = body.status === 'proposed' ? 200 : HTTP_STATUS_BY_FAILURE[body.status]
  return Response.json(body, { status: httpStatus, headers: noStoreHeaders })
}
