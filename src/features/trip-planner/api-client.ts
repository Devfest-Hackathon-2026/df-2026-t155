import { z } from 'zod'

import { GenerateTripResponseSchema, type GenerateTripRequest, type Trip } from '@/domain'

// 旅程生成API（POST /api/trips/generate）を呼ぶクライアント。
// 応答は必ず共通契約で検証し、契約に反するものは「想定外」として扱う。
// 認証情報はクライアントへ持ち込まない（外部サービスへの接続はサーバー側で行う）。

export const GENERATE_TRIP_ENDPOINT = '/api/trips/generate'

// 画面が区別して案内する失敗の種類。
// 共通契約の失敗（生成できない／情報不足／外部サービス失敗）に、通信側の失敗を加える。
export type GenerationFailureKind =
  | 'no_candidates'
  | 'insufficient_information'
  | 'external_service_error'
  | 'invalid_request'
  | 'payload_too_large'
  | 'service_unavailable'
  | 'interrupted'
  | 'unexpected'

export interface GenerationFailure {
  kind: GenerationFailureKind
  message: string
}

export type GenerationResult = { ok: true; trip: Trip } | { ok: false; failure: GenerationFailure }

export interface GenerationOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

// 共通契約の外にある、API層だけのエラー本文（入力不備・サイズ超過・内部エラー等）。
const ApiLayerErrorSchema = z.object({ status: z.string(), message: z.string() })

const failure = (kind: GenerationFailureKind, message: string): GenerationResult => ({
  ok: false,
  failure: { kind, message },
})

const UNEXPECTED_MESSAGE = 'サーバーから想定外の応答が返されました。'
const INTERRUPTED_MESSAGE = '通信が中断されました。接続を確認して、もう一度お試しください。'

// #17のAPI仕様（docs/TRIP_GENERATION_API.md）における、本文の状態とHTTPステータスの対応。
// 食い違う応答（例：201の提案、500の候補なし）は、通常の成功・失敗として扱わない。
const EXPECTED_HTTP_STATUS = {
  proposed: 200,
  no_candidates: 422,
  insufficient_information: 422,
  external_service_error: 502,
  invalid_request: 400,
  payload_too_large: 413,
  service_unavailable: 503,
} as const

export async function requestTripGeneration(
  request: GenerateTripRequest,
  { fetchFn = fetch, signal }: GenerationOptions = {},
): Promise<GenerationResult> {
  let response: Response
  let text: string
  try {
    response = await fetchFn(GENERATE_TRIP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
    // 本文の受信中に切れた場合も、応答は完結していない。不正なJSONとは区別する。
    text = await response.text()
  } catch {
    // 接続できない・途中で切れた・利用者の操作で中止した場合。
    return failure('interrupted', INTERRUPTED_MESSAGE)
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const contract = GenerateTripResponseSchema.safeParse(body)
  if (contract.success) {
    const { data } = contract
    if (response.status !== EXPECTED_HTTP_STATUS[data.status]) {
      return failure('unexpected', UNEXPECTED_MESSAGE)
    }
    return data.status === 'proposed'
      ? { ok: true, trip: data.trip }
      : failure(data.status, data.message)
  }

  const apiError = ApiLayerErrorSchema.safeParse(body)
  if (apiError.success) {
    const { status, message } = apiError.data
    // 利用者が行動で解消できる、API層のエラー。ステータスが仕様と一致するものだけ扱う。
    if (
      (status === 'invalid_request' ||
        status === 'payload_too_large' ||
        status === 'service_unavailable') &&
      response.status === EXPECTED_HTTP_STATUS[status]
    ) {
      return failure(status, message)
    }
  }
  return failure('unexpected', UNEXPECTED_MESSAGE)
}
