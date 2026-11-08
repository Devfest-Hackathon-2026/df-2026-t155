import type { Actor } from '@/lib/auth/server'
import { ReviseTripRequestSchema, ReviseTripResponseSchema } from '../../domain'
import type { ReviseTripRequest, ReviseTripResponse } from '../../domain'
import { COSTS } from '../cost-control/costs'
import type { OperationCost } from '../cost-control/policy'
import { WriteFenceError } from '../cost-control/write-transaction'
import {
  isCostlyApiEnabled,
  requireCostlyApiActor,
  runCostlyOperation,
  type CostlyOperation,
} from '../costly-api'
import { errorResponse, noStoreHeaders, readBodyWithLimit } from '../http'
import { hasTimeConflict } from '../verification/travel'
import { PersistenceError } from '../persistence/errors'

// POST /api/trips/revise のHTTP処理。1地点の部分修正の候補（未承認のRevision）を返す。
// 元の旅程は更新しない。承認・適用はこのAPIでは行わない。
// 停止中は認証・本文の読み取り・Gemini・Maps呼び出しを行わない。

// 旅程1件・修正の理由・現地の報告を含む入力の上限。
export const MAX_REVISE_REQUEST_BYTES = 64 * 1024

export const isTripRevisionEnabled = (env: Record<string, string | undefined>): boolean =>
  isCostlyApiEnabled(env.TRIP_REVISION_ENABLED)

export interface ReviseTripHandlerDeps {
  isEnabled: () => boolean
  // 予約する操作量。省略時は候補の生成（Gemini・Places・Routes）だけ。
  // 保存を伴う生成では、本人報告の記録に使う保存の読み書きを含めた量を渡す。
  cost?: OperationCost
  revise: (
    request: ReviseTripRequest,
    operation: CostlyOperation,
    actor: Actor,
  ) => Promise<ReviseTripResponse>
}

// 保存の失敗（PersistenceError）と、書き込み権の失効・結果不明（WriteFenceError）を応答に変える。
function storageFailureResponse(error: unknown): Response | undefined {
  if (error instanceof PersistenceError) {
    return Response.json(
      { status: error.code, message: error.message },
      { status: error.status, headers: noStoreHeaders },
    )
  }
  if (error instanceof WriteFenceError) {
    const unknown = error.code === 'write_result_unknown'
    return Response.json(
      {
        status: unknown ? 'write_result_unknown' : 'protection_unavailable',
        message: unknown
          ? '保存結果を確認できませんでした。再送する前に保存内容を取得してください。'
          : '保存の利用枠を安全に確認できませんでした。',
      },
      { status: 503, headers: noStoreHeaders },
    )
  }
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
  const actor = await requireCostlyApiActor(request)
  if (actor instanceof Response) return actor

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
    const outcome = await runCostlyOperation(
      actor,
      deps.cost ?? COSTS.revise,
      async (operation) => {
        try {
          return await deps.revise(parsed.data, operation, actor)
        } catch (error) {
          // 保存の失敗と書き込み権の失効は、状態を含む応答に変える。結果不明の応答ではリースを残す。
          const response = storageFailureResponse(error)
          if (!response) throw error
          if (response.status >= 500) operation.keepLease()
          return response
        }
      },
    )
    if (outcome instanceof Response) return outcome
    result = outcome
  } catch {
    console.error('[trip-revision] 想定外のエラー')
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
