import { z } from 'zod'

import { GenerateTripResponseSchema, type Trip } from '@/domain'
import {
  InvalidLearningSelectionError,
  resolveSelectionForRequest,
  type ScopedLearningSelection,
} from '@/features/learning-reuse/selection-scope'
import { getProtectedApiHeaders, getProtectedApiHeadersForScope } from '@/lib/auth/protected-api'
import {
  classifyProtectedHeaderError,
  classifyProtectedStatus,
  PROTECTED_FAILURE_MESSAGES,
} from '@/lib/auth/protected-api-errors'
import {
  assertCurrentSessionScope,
  beginSessionScopeOperation,
  captureSessionScope,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'
import type { GenerateTripConditions } from '@/server/trip-generation/http-request'

// 旅程生成API（POST /api/trips/generate）を呼ぶクライアント。
// 応答は必ず共通契約で検証し、契約に反するものは「想定外」として扱う。
// 外部サービスへの接続はサーバー側で行う。この呼び出しは課金APIなので、本人のBearerとApp Checkを付けて送る。
// ヘッダーを用意できなければ送信しない（fail-closed）。401・403・429は本文を見ずステータスで判定し、再送しない。
//
// 学びの再利用：本文に載せるのは、利用者が選んだ学びの { id, version } だけ（learningSelections）。
// 学びの本文や承認状態は送らない（サーバーが本人の保存済みデータと照合して解決する）。
// 選択は、選んだ時点の認証セッションと組（ScopedLearningSelection）で受け取り、送信の直前に
// resolveSelectionForRequest で現在のセッションと照合する。UIDまたは認証世代が違えば、
// 選択を外して続けず、送らずに失敗する（黙って学びなしの旅程を作らない）。

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
  // 選んだ学びが変更・撤回された（HTTP 409）。旅程は作っていない。選び直しを案内する。
  | 'selection_changed'
  // 保存済みの学びを確認できない（HTTP 503）。機能停止（service_unavailable）とは別。学びを使わずに作る道を案内する。
  | 'learnings_unavailable'
  // 学びを選んだ時点と今で認証セッションが違う。送らない、または結果を採用しない。
  | 'session_changed'
  // 認証・招待・アプリ検証の失敗（HTTP 401・403）。
  | 'unauthorized'
  // 利用制限（HTTP 429）。
  | 'rate_limited'
  // 認証情報を用意できず、送信しなかった。
  | 'auth_required'
  // App Checkを用意できず、送信しなかった（鍵の設定なし・reCAPTCHA失敗）。
  | 'app_check_unavailable'
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
  // 既定は本人のBearer＋App Check。テストでは差し替える。
  getHeaders?: () => Promise<Headers>
  // 利用者が選んだ学び（選んだ時点の認証セッションと組）。null・空は「学びを使わない」。
  learningSelection?: ScopedLearningSelection | null
  // 学びを選んでいるときの認証まわり（既定は本物。テストで差し替える）。
  captureScope?: () => Promise<SessionScope>
  getHeadersForScope?: (scope: SessionScope) => Promise<Headers>
  beginOperation?: typeof beginSessionScopeOperation
}

// 共通契約の外にある、API層だけのエラー本文（入力不備・サイズ超過・内部エラー等）。
const ApiLayerErrorSchema = z.object({ status: z.string(), message: z.string() })

const SESSION_CHANGED_MESSAGE =
  '認証の状態が変わりました。前の状態で選んだ学びと、作りかけの結果は使えません。'

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
  selection_changed: 409,
  learnings_unavailable: 503,
} as const

export async function requestTripGeneration(
  request: GenerateTripConditions,
  {
    fetchFn = fetch,
    signal,
    getHeaders = getProtectedApiHeaders,
    learningSelection = null,
    captureScope = captureSessionScope,
    getHeadersForScope = getProtectedApiHeadersForScope,
    beginOperation = beginSessionScopeOperation,
  }: GenerationOptions = {},
): Promise<GenerationResult> {
  // 学びを選んでいるときだけ、選択時と今の認証セッションを照合する（違えば送らない）。
  // 旅行条件の側に learningSelections が混ざっていても、ここで作った値で置き換える。
  let scope: SessionScope | undefined
  let selections: { id: string; version: number }[] = []
  if (learningSelection && learningSelection.value.length > 0) {
    try {
      scope = await captureScope()
      selections = resolveSelectionForRequest(learningSelection, scope)
    } catch (error) {
      if (error instanceof SessionChangedError) {
        return failure('session_changed', SESSION_CHANGED_MESSAGE)
      }
      if (error instanceof InvalidLearningSelectionError) {
        return failure('invalid_request', error.message)
      }
      // 認証の状態を取れない（セッションなし・失効）。送信しない。
      return failure('auth_required', PROTECTED_FAILURE_MESSAGES.auth_required)
    }
  }

  // ヘッダーを用意できなければ送信しない。課金APIを呼ばず、再試行もしない。
  let headers: Headers
  try {
    headers = await (scope ? getHeadersForScope(scope) : getHeaders())
  } catch (error) {
    if (error instanceof SessionChangedError) {
      return failure('session_changed', SESSION_CHANGED_MESSAGE)
    }
    const kind = classifyProtectedHeaderError(error)
    return failure(kind, PROTECTED_FAILURE_MESSAGES[kind])
  }
  headers.set('Content-Type', 'application/json')

  // 学びを選んでいるときは、通信を認証世代に登録する。世代が変われば同期的に中断され、結果は採用しない。
  let operation: ReturnType<typeof beginSessionScopeOperation> | undefined
  try {
    if (scope) {
      operation = beginOperation(scope, signal)
      operation.assertCurrent('not_sent')
    }
  } catch {
    operation?.dispose()
    return failure('session_changed', SESSION_CHANGED_MESSAGE)
  }

  try {
    let response: Response
    let text: string
    try {
      response = await fetchFn(GENERATE_TRIP_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(request, selections)),
        signal: operation?.signal ?? signal,
      })
      // 本文の受信中に切れた場合も、応答は完結していない。不正なJSONとは区別する。
      text = await response.text()
    } catch {
      // 認証世代が変わって中断された場合は、通信断とは区別する。
      if (operation && !isStillCurrent(operation)) {
        return failure('session_changed', SESSION_CHANGED_MESSAGE)
      }
      // 接続できない・途中で切れた・利用者の操作で中止した場合。
      return failure('interrupted', INTERRUPTED_MESSAGE)
    }

    // 応答を採用する直前にも、送信時と同じ認証セッションか確認する。違えば結果を捨てる。
    if (scope) {
      try {
        await assertCurrentSessionScope(scope)
        operation?.assertCurrent()
      } catch {
        return failure('session_changed', SESSION_CHANGED_MESSAGE)
      }
    }

    return interpretResponse(response.status, text)
  } finally {
    operation?.dispose()
  }
}

// 送る本文は、旅行条件の既知の項目と、検証した選択だけで作る。
// 呼び出し側が余分な項目（旧形式の learnings など）を渡しても、本文には載せない。
function requestBody(
  { date, region, timeZone, preferences, fixedStops }: GenerateTripConditions,
  learningSelections: { id: string; version: number }[],
) {
  return { date, region, timeZone, preferences, fixedStops, learningSelections }
}

const isStillCurrent = (operation: { assertCurrent(): void }): boolean => {
  try {
    operation.assertCurrent()
    return true
  } catch {
    return false
  }
}

function interpretResponse(httpStatus: number, text: string): GenerationResult {
  // 認証・利用制限は、本文の形に関わらずステータスで判定し、固定の文言を出す（サーバーの本文は出さない）。
  const protectedFailure = classifyProtectedStatus(httpStatus)
  if (protectedFailure)
    return failure(protectedFailure, PROTECTED_FAILURE_MESSAGES[protectedFailure])

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const contract = GenerateTripResponseSchema.safeParse(body)
  if (contract.success) {
    const { data } = contract
    if (httpStatus !== EXPECTED_HTTP_STATUS[data.status]) {
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
        status === 'service_unavailable' ||
        status === 'selection_changed' ||
        status === 'learnings_unavailable') &&
      httpStatus === EXPECTED_HTTP_STATUS[status]
    ) {
      return failure(status, message)
    }
  }
  return failure('unexpected', UNEXPECTED_MESSAGE)
}
