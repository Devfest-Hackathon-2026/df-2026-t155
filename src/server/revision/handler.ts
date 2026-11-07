import { ReviseTripRequestSchema, ReviseTripResponseSchema } from '../../domain'
import type { ReviseTripRequest, ReviseTripResponse } from '../../domain'
import { errorResponse, noStoreHeaders, readBodyWithLimit } from '../http'
import { hasTimeConflict } from '../verification/travel'

// POST /api/trips/revise のHTTP処理。1地点の部分修正の候補（未承認のRevision）を返す。
// 元の旅程は更新しない。承認・適用はこのAPIでは行わない。
// GeminiとMapsを呼ぶ（課金を伴う）ため、認証・利用制限が入るまでは機能フラグ（既定は無効）で停止する。
// 無効の間は、Gemini・Mapsを呼ばず、リクエスト本文も読まない。

// 旅程1件・修正の理由・現地の報告を含む入力の上限。
export const MAX_REVISE_REQUEST_BYTES = 64 * 1024

export const isTripRevisionEnabled = (env: Record<string, string | undefined>): boolean =>
  env.TRIP_REVISION_ENABLED?.trim() === 'true'

export interface ReviseTripHandlerDeps {
  isEnabled: () => boolean
  revise: (request: ReviseTripRequest) => Promise<ReviseTripResponse>
}

const HTTP_STATUS_BY_FAILURE = {
  no_candidates: 422,
  insufficient_information: 422,
  external_service_error: 502,
} as const

export async function handleReviseTripRequest(
  request: Request,
  deps: ReviseTripHandlerDeps,
): Promise<Response> {
  if (!deps.isEnabled()) {
    return errorResponse(503, {
      status: 'service_unavailable',
      message: '部分修正は現在利用できません。',
    })
  }
  // メディアタイプを正確に比べる（パラメータは許す。application/jsonp などは受理しない）。
  const mediaType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return errorResponse(415, {
      status: 'unsupported_media_type',
      message: 'Content-Typeにapplication/jsonを指定してください。',
    })
  }
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REVISE_REQUEST_BYTES) {
    return errorResponse(413, {
      status: 'payload_too_large',
      message: '入力データが大きすぎます。',
    })
  }

  const bodyRead = await readBodyWithLimit(request, MAX_REVISE_REQUEST_BYTES)
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
  const parsed = ReviseTripRequestSchema.safeParse(json)
  if (!parsed.success) {
    return errorResponse(400, {
      status: 'invalid_request',
      message: '部分修正の入力の形式が正しくありません（固定されていない予定を指定してください）。',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }

  // 予定の時刻が重なっている・時刻順でない旅程は、部分修正の対象にしない（決定論的な検証。AI・Mapsを呼ばない）。
  if (hasTimeConflict(parsed.data.trip.stops)) {
    return errorResponse(400, {
      status: 'invalid_request',
      message: '予定の時刻が重なっているか、時刻順に並んでいません。',
    })
  }

  let result: ReviseTripResponse
  try {
    result = await deps.revise(parsed.data)
  } catch (error) {
    console.error('[trip-revision] 想定外のエラー', error instanceof Error ? error.name : error)
    return errorResponse(500, {
      status: 'internal_error',
      message: '部分修正の候補の作成中に予期しないエラーが発生しました。元の旅程は、そのままです。',
    })
  }

  // 返却前にも共通契約で検証し、契約に反する応答（承認済みの候補など）を流さない。
  const checked = ReviseTripResponseSchema.safeParse(result)
  if (!checked.success) {
    console.error('[trip-revision] 応答が共通契約に違反')
    return errorResponse(500, {
      status: 'internal_error',
      message: '部分修正の候補の作成中に予期しないエラーが発生しました。元の旅程は、そのままです。',
    })
  }
  const body = checked.data
  const httpStatus = body.status === 'proposed' ? 200 : HTTP_STATUS_BY_FAILURE[body.status]
  return Response.json(body, { status: httpStatus, headers: noStoreHeaders })
}
