import { z } from 'zod'

import { PLACE_SAVE_PROOF_HEADER } from '@/domain/learning-trip-protocol'

import { TripSchema, type Trip } from '../../domain'
import { COSTS } from '../cost-control/costs'
import {
  isCostlyApiEnabled,
  requireCostlyApiActor,
  runCostlyOperation,
  type CostlyOperation,
} from '../costly-api'
import { errorResponse, noStoreHeaders, readBodyWithLimit } from '../http'
import { issuePlaceSaveProof } from '../persistence/place-save-provenance'
import { hasTimeConflict } from './travel'
import type { VerifyTripResult } from './verify-trip'

// POST /api/trips/verify のHTTP処理。生成された旅程に、Places/Routesの照合結果（根拠）を付ける。
// 旅程の内容（予定・時刻・固定）と版は変えない。承認・保存はこのAPIでは行わない。
// 停止中は認証・本文の読み取り・外部API呼び出しを行わない。
//
// 移動の確認は、徒歩だけ（車を使えるとは限らないため）。このAPIは、移動手段の指定を受け付けない
// （`travelModes`などの未知の項目は、400で拒否する）。
// 内部の`verifyTrip`は、`travelModes`で車を明示的に許可できるが、公開APIには出していない
// （必要になったときに、リクエストの検証から接続する）。

// 旅程1件を含む入力の上限。巨大な入力でMapsの呼び出し回数が膨らむのを、予定数の上限と合わせて防ぐ。
export const MAX_VERIFY_REQUEST_BYTES = 64 * 1024

export const isTripVerificationEnabled = (env: Record<string, string | undefined>): boolean =>
  isCostlyApiEnabled(env.TRIP_VERIFICATION_ENABLED)

// 未知の項目（移動手段の指定など）は、無視せず、拒否する（指定が反映されたと誤解させない）。
export const VerifyTripRequestSchema = z.strictObject({ trip: TripSchema })
export type VerifyTripRequest = z.infer<typeof VerifyTripRequestSchema>

export type VerifyTripResponse =
  { status: 'verified'; trip: Trip } | { status: 'external_service_error'; message: string }

const VerifyTripResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('verified'), trip: TripSchema }),
  z.object({ status: z.literal('external_service_error'), message: z.string().min(1) }),
])

export interface VerifyTripHandlerDeps {
  isEnabled: () => boolean
  verify: (trip: Trip, operation: CostlyOperation) => Promise<VerifyTripResult>
}

export async function handleVerifyTripRequest(
  request: Request,
  deps: VerifyTripHandlerDeps,
): Promise<Response> {
  if (!deps.isEnabled()) {
    return errorResponse(503, {
      status: 'service_unavailable',
      message: '旅程の照合は現在利用できません。',
    })
  }
  const actor = await requireCostlyApiActor(request)
  if (actor instanceof Response) return actor

  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, {
      status: 'unsupported_media_type',
      message: 'Content-Typeにapplication/jsonを指定してください。',
    })
  }
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VERIFY_REQUEST_BYTES) {
    return errorResponse(413, {
      status: 'payload_too_large',
      message: '旅程のデータが大きすぎます。',
    })
  }

  const bodyRead = await readBodyWithLimit(request, MAX_VERIFY_REQUEST_BYTES)
  if (!bodyRead.ok) {
    return bodyRead.reason === 'too_large'
      ? errorResponse(413, { status: 'payload_too_large', message: '旅程のデータが大きすぎます。' })
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
  const parsed = VerifyTripRequestSchema.safeParse(json)
  if (!parsed.success) {
    return errorResponse(400, {
      status: 'invalid_request',
      message: '旅程の形式が正しくありません。',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }

  // 予定の時刻が重なっている・時刻順でない旅程は、照合の対象にしない（決定論的な検証。Mapsを呼ばない）。
  if (hasTimeConflict(parsed.data.trip.stops)) {
    return errorResponse(400, {
      status: 'invalid_request',
      message: '予定の時刻が重なっているか、時刻順に並んでいません。',
    })
  }

  let result: VerifyTripResult
  try {
    const outcome = await runCostlyOperation(actor, COSTS.verify, (operation) =>
      deps.verify(parsed.data.trip, operation),
    )
    if (outcome instanceof Response) return outcome
    result = outcome
  } catch {
    console.error('[trip-verification] 想定外のエラー')
    return errorResponse(500, {
      status: 'internal_error',
      message: '旅程の照合中に予期しないエラーが発生しました。',
    })
  }

  // verifyTripも、時刻の重なりを拒否する（上の事前チェックとの二重化）。入力の不備なので400。
  if (result.status === 'invalid_trip') {
    return errorResponse(400, { status: 'invalid_request', message: result.message })
  }

  // 内部の呼び出し回数などは返さない。返却前に契約で検証する。
  const body: VerifyTripResponse =
    result.status === 'verified'
      ? { status: 'verified', trip: result.trip }
      : { status: 'external_service_error', message: result.message }
  const checked = VerifyTripResponseSchema.safeParse(body)
  if (!checked.success) {
    console.error('[trip-verification] 応答が契約に違反')
    return errorResponse(500, {
      status: 'internal_error',
      message: '旅程の照合中に予期しないエラーが発生しました。',
    })
  }
  const proof =
    checked.data.status === 'verified' ? issuePlaceSaveProof(actor, checked.data.trip) : undefined
  return Response.json(checked.data, {
    status: checked.data.status === 'verified' ? 200 : 502,
    headers: proof ? { ...noStoreHeaders, [PLACE_SAVE_PROOF_HEADER]: proof } : noStoreHeaders,
  })
}
