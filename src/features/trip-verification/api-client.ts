import { z } from 'zod'

import { TripSchema, type Trip } from '@/domain'

// 旅程の照合API（POST /api/trips/verify）を呼ぶクライアント。
// 応答は必ず共通契約で検証し、契約に反するものは「想定外」として扱う。
// 照合は旅程に根拠を付けるだけで、予定・時刻・固定の内容は変えない。変えて返された応答は採用しない。

export const VERIFY_TRIP_ENDPOINT = '/api/trips/verify'

export type VerificationFailureKind =
  | 'external_service_error'
  | 'invalid_request'
  | 'payload_too_large'
  | 'service_unavailable'
  // 認証・招待・アプリ検証のいずれかが通らなかった（HTTP 401・403）。結果は採用しない。
  | 'unauthorized'
  // 利用制限に達した（HTTP 429）。結果は採用しない。
  | 'rate_limited'
  // 認証が必要な設定で、認証情報を用意できず、送信しなかった（通信はしていない）。
  | 'auth_required'
  // App Checkを用意できず、送信しなかった（鍵の設定なし・reCAPTCHA失敗。通信はしていない）。
  | 'app_check_unavailable'
  | 'interrupted'
  | 'unexpected'

export interface VerificationFailure {
  kind: VerificationFailureKind
  message: string
}

export type VerificationResult =
  { ok: true; trip: Trip } | { ok: false; failure: VerificationFailure }

export interface VerificationOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

const VerifiedSchema = z.object({ status: z.literal('verified'), trip: TripSchema })
const ErrorBodySchema = z.object({ status: z.string(), message: z.string() })

const EXPECTED_HTTP_STATUS = {
  external_service_error: 502,
  invalid_request: 400,
  payload_too_large: 413,
  service_unavailable: 503,
} as const

const failure = (kind: VerificationFailureKind, message: string): VerificationResult => ({
  ok: false,
  failure: { kind, message },
})

const UNEXPECTED_MESSAGE = 'サーバーから想定外の応答が返されました。'
const INTERRUPTED_MESSAGE = '通信が中断されました。接続を確認して、もう一度お試しください。'
const UNAUTHORIZED_MESSAGE =
  '認証、招待、またはアプリの検証が通りませんでした。認証の有効期限が切れているか、このアカウントは利用できない可能性があります。'
const RATE_LIMITED_MESSAGE = '利用の回数が上限に達しています。'
const AUTH_UNAVAILABLE_MESSAGE = '認証情報を取得できなかったため、照合の依頼を送信しませんでした。'
const APP_CHECK_UNAVAILABLE_MESSAGE =
  'アプリの検証（App Check）を用意できなかったため、照合の依頼を送信しませんでした。'

// 認証が必要な送信で、認証情報を用意できなかった（送信していない）。fetchの代わりに投げる。
export class AuthRequiredError extends Error {
  constructor(message: string = AUTH_UNAVAILABLE_MESSAGE) {
    super(message)
    this.name = 'AuthRequiredError'
  }
}

// 認証の失敗か。認証基盤のエラー（ClientAuthError）は、型を直接参照せず、名前で見分ける
// （照合の入口に、認証SDKの読み込みを持ち込まないため）。文言は、そのエラー自身のものを使う。
export const isAuthError = (error: unknown): error is Error =>
  error instanceof Error &&
  (error.name === 'AuthRequiredError' ||
    error.name === 'ClientAuthError' ||
    error.name === 'AppCheckUnavailableError')

// キーの並び順に依存しない、安定した文字列にする（キーをソートして再帰的にJSON化）。
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    )
  }
  return value
}

// 照合の応答が、送った旅程の「根拠（placeIdと証拠）だけ」を変えたものか。
// 根拠以外の項目が変わっていれば採用しない。項目を手で並べず、旅程全体を比べる（項目が増えても漏れない）。
const contentOf = (trip: Trip): string =>
  JSON.stringify(
    sortKeys({
      ...trip,
      stops: trip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
    }),
  )

const sameAsSent = (sent: Trip, received: Trip): boolean => contentOf(sent) === contentOf(received)

export async function requestTripVerification(
  trip: Trip,
  { fetchFn = fetch, signal }: VerificationOptions = {},
): Promise<VerificationResult> {
  let response: Response
  let text: string
  try {
    response = await fetchFn(VERIFY_TRIP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip }),
      signal,
    })
    text = await response.text()
  } catch (error) {
    // 認証情報を用意できず送信しなかった場合は、通信の中断と区別する。
    // App Checkの失敗はSDKの文言を出さず、固定の文言にする。
    if (error instanceof Error && error.name === 'AppCheckUnavailableError') {
      return failure('app_check_unavailable', APP_CHECK_UNAVAILABLE_MESSAGE)
    }
    if (isAuthError(error)) return failure('auth_required', error.message)
    return failure('interrupted', INTERRUPTED_MESSAGE)
  }

  // 認証・利用制限は、本文の形に関わらず、ステータスで判定する（本文は信用せず、固定の文言を出す）。
  // どちらも、結果は採用しない。
  if (response.status === 401 || response.status === 403) {
    return failure('unauthorized', UNAUTHORIZED_MESSAGE)
  }
  if (response.status === 429) return failure('rate_limited', RATE_LIMITED_MESSAGE)

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const verified = VerifiedSchema.safeParse(body)
  if (verified.success) {
    return response.status === 200 && sameAsSent(trip, verified.data.trip)
      ? { ok: true, trip: verified.data.trip }
      : failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const error = ErrorBodySchema.safeParse(body)
  if (error.success) {
    const { status, message } = error.data
    if (
      (status === 'external_service_error' ||
        status === 'invalid_request' ||
        status === 'payload_too_large' ||
        status === 'service_unavailable') &&
      response.status === EXPECTED_HTTP_STATUS[status]
    ) {
      return failure(status, message)
    }
  }
  return failure('unexpected', UNEXPECTED_MESSAGE)
}
