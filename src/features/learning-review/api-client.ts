import { z } from 'zod'

import {
  LearningSchema,
  ProposalFailureSchema,
  type Learning,
  type Revision,
  type Trip,
} from '@/domain'
import { getProtectedApiHeaders, getProtectedApiHeadersForScope } from '@/lib/auth/protected-api'
import {
  classifyProtectedHeaderError,
  classifyProtectedStatus,
  PROTECTED_FAILURE_MESSAGES,
} from '@/lib/auth/protected-api-errors'
import {
  beginSessionScopeOperation,
  SessionChangedError,
  type SessionScope,
  type SessionScopeOperation,
} from '@/lib/auth/session-scope'

// 学びの候補の作成API（POST /api/learnings/candidates）を呼ぶクライアント。
// 応答は契約で検証する。候補は1〜3件で、すべて未承認でなければ採用しない
// （承認済みとして返ってきた学びを、本人の承認なしに受け入れない）。

export const LEARNING_CANDIDATES_ENDPOINT = '/api/learnings/candidates'

export type CandidatesFailureKind =
  | 'no_candidates'
  | 'insufficient_information'
  | 'external_service_error'
  | 'invalid_request'
  | 'payload_too_large'
  | 'service_unavailable'
  | 'unauthorized'
  | 'rate_limited'
  | 'auth_required'
  | 'app_check_unavailable'
  // 要求を作った時点と認証セッション（UID・世代）が変わった。送信前なら送らず、送信後なら結果を使わない。
  | 'session_changed'
  | 'interrupted'
  | 'unexpected'

export interface CandidatesFailure {
  kind: CandidatesFailureKind
  message: string
}

export type CandidatesResult =
  { ok: true; learnings: Learning[] } | { ok: false; failure: CandidatesFailure }

export interface CandidatesRequest {
  trip: Trip
  revisions: Revision[]
  feedback: string
}

export interface CandidatesOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  // trip・revisionsを取得した認証セッション。指定すると、そのセッションのBearer＋App Checkだけで送り、
  // 送信直前と応答後にも世代の一致を確かめる（別のUIDのトークンで、前のセッションのデータを送らない）。
  // 振り返り画面は実APIへ送るため、保存済み・架空の旅程のどちらでも指定する。
  scope?: SessionScope
  // 既定は本人のBearer＋App Check（scope指定時はscopeに束縛したもの）。テストでは差し替える。
  // scope指定時に、現在のUIDで新しく作り直す関数へ差し替えてはいけない。
  getHeaders?: (scope?: SessionScope) => Promise<Headers>
}

const ProposedSchema = z.strictObject({
  status: z.literal('proposed'),
  learnings: z
    .array(LearningSchema.refine((learning) => learning.approval.status === 'pending'))
    .min(1)
    .max(3)
    // 同じIDの候補があると、承認の操作が、意図しない候補にも作用する。
    .refine(
      (learnings) => new Set(learnings.map((learning) => learning.id)).size === learnings.length,
    ),
})
const ApiErrorSchema = z.object({ status: z.string(), message: z.string() })

const EXPECTED_HTTP_STATUS = {
  no_candidates: 422,
  insufficient_information: 422,
  external_service_error: 502,
  invalid_request: 400,
  payload_too_large: 413,
  service_unavailable: 503,
} as const

const failure = (kind: CandidatesFailureKind, message: string): CandidatesResult => ({
  ok: false,
  failure: { kind, message },
})

const UNEXPECTED_MESSAGE = 'サーバーから想定外の応答が返されました。'
const INTERRUPTED_MESSAGE = '通信が中断されました。接続を確認して、もう一度お試しください。'

const SESSION_CHANGED_MESSAGE =
  '認証状態が変わったため、この結果は使いません。画面を開き直して、もう一度お試しください。'

export async function requestLearningCandidates(
  request: CandidatesRequest,
  { fetchFn = fetch, signal, scope, getHeaders }: CandidatesOptions = {},
): Promise<CandidatesResult> {
  const headerSource =
    getHeaders ??
    (scope ? () => getProtectedApiHeadersForScope(scope) : () => getProtectedApiHeaders())
  let operation: SessionScopeOperation | undefined
  try {
    let headers: Headers
    try {
      // App Checkの待機中も旧世代として中断し、ヘッダー取得後にもう一度確認してから送信する。
      if (scope) operation = beginSessionScopeOperation(scope, signal)
      if (operation?.signal.aborted) return failure('interrupted', INTERRUPTED_MESSAGE)
      headers = await headerSource(scope)
      operation?.assertCurrent('not_sent')
      if (operation?.signal.aborted) return failure('interrupted', INTERRUPTED_MESSAGE)
    } catch (error) {
      if (error instanceof SessionChangedError) {
        return failure('session_changed', SESSION_CHANGED_MESSAGE)
      }
      const kind = classifyProtectedHeaderError(error)
      return failure(kind, PROTECTED_FAILURE_MESSAGES[kind])
    }
    headers.set('Content-Type', 'application/json')
    return await interpret(request, headers, fetchFn, operation?.signal ?? signal, () => {
      try {
        operation?.assertCurrent('unknown')
        return true
      } catch {
        return false
      }
    })
  } finally {
    operation?.dispose()
  }
}

async function interpret(
  request: CandidatesRequest,
  headers: Headers,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  stillCurrent: () => boolean,
): Promise<CandidatesResult> {
  let response: Response
  let text: string
  try {
    response = await fetchFn(LEARNING_CANDIDATES_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal,
    })
    text = await response.text()
  } catch {
    // 認証切替による中断は、通信エラーではなく切替として知らせる。
    return stillCurrent()
      ? failure('interrupted', INTERRUPTED_MESSAGE)
      : failure('session_changed', SESSION_CHANGED_MESSAGE)
  }
  // 応答を読んでいる間に認証が切り替わった結果は、使わない（送信済みの可能性はある）。
  if (!stillCurrent()) return failure('session_changed', SESSION_CHANGED_MESSAGE)

  // 認証・利用制限は本文を見ずステータスで判定し、固定の文言を出す。
  const protectedFailure = classifyProtectedStatus(response.status)
  if (protectedFailure)
    return failure(protectedFailure, PROTECTED_FAILURE_MESSAGES[protectedFailure])

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const proposed = ProposedSchema.safeParse(body)
  if (proposed.success) {
    return response.status === 200
      ? { ok: true, learnings: proposed.data.learnings }
      : failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const known = ProposalFailureSchema.safeParse(body)
  if (known.success) {
    const { status, message } = known.data
    return response.status === EXPECTED_HTTP_STATUS[status]
      ? failure(status, message)
      : failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const apiError = ApiErrorSchema.safeParse(body)
  if (apiError.success) {
    const { status, message } = apiError.data
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
