import {
  assertCurrentSessionScope,
  beginSessionScopeOperation,
  SessionChangedError,
  type ScopedValue,
  type SessionScope,
  type SessionScopeOperation,
} from '@/lib/auth/session-scope'
import { getProtectedApiHeadersForScope } from '@/lib/auth/protected-api'
import { classifyProtectedHeaderError } from '@/lib/auth/protected-api-errors'
import type { VersionedLearning } from '@/server/persistence/contracts'

import { isSelectableLearningList, ReusableLearningListResponseSchema } from './learning-list'

// 本人の保存済みの学びを取得する。取得失敗や不完全な一覧を空配列として扱わない。
// 成功した一覧は、取得した認証セッション（SessionScope）と組にして返す。
// 同じIDとversionでも別のUIDの学びは別物なので、利用側はこの組ごと保持し、
// セッションが変わったら組ごと破棄する（docs/AUTHENTICATION.md「セッションスコープ」）。
export type LearningLoadResult =
  | { ok: true; learnings: ScopedValue<VersionedLearning[]> }
  | {
      ok: false
      // session: 認証状態を確認できない（失効・復元失敗）。session_changed: 取得時のUIDまたは認証世代が変わった。
      kind:
        | 'session'
        | 'session_changed'
        // App Checkを用意できず、送信しなかった（鍵の設定なし・reCAPTCHA失敗）。
        | 'app_check_unavailable'
        // 利用制限（HTTP 429）。
        | 'rate_limited'
        | 'unavailable'
        | 'interrupted'
        | 'incomplete'
        | 'unexpected'
      message: string
    }

export interface LearningLoadOptions {
  // 取得するセッション。このセッションのトークンで取得し、結果もこのセッションに結び付ける。
  scope: SessionScope
  signal?: AbortSignal
  fetchFn?: typeof fetch
  // 既定は getProtectedApiHeadersForScope（Bearer＋App Check）。UIDが scope と違えばトークンを出さずに失敗し、
  // App Checkを用意できなくても送信しない。現在のUIDで getAuthHeaders() を作り直す関数に差し替えてはいけない。
  getHeaders?: (scope: SessionScope) => Promise<Headers>
  // Integration tests may supply a scope from an isolated Firebase app.
  beginOperation?: typeof beginSessionScopeOperation
}

const fail = (
  kind: Extract<LearningLoadResult, { ok: false }>['kind'],
  message: string,
): LearningLoadResult => ({ ok: false, kind, message })

export async function loadApprovedLearningOptions({
  scope,
  signal,
  fetchFn = fetch,
  getHeaders = getProtectedApiHeadersForScope,
  beginOperation = beginSessionScopeOperation,
}: LearningLoadOptions): Promise<LearningLoadResult> {
  let headers: Headers
  try {
    headers = await getHeaders(scope)
  } catch (error) {
    // 取得前にUIDが変わっていた。別のUIDのトークンでは取得しない。
    if (error instanceof SessionChangedError) {
      return fail('session_changed', '認証状態が変わりました。学びを読み込み直してください。')
    }
    if (classifyProtectedHeaderError(error) === 'app_check_unavailable') {
      return fail(
        'app_check_unavailable',
        'アプリの検証（App Check）を用意できなかったため、学びを読み込めませんでした。時間をおいてお試しください。',
      )
    }
    return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
  }
  if (signal?.aborted) return fail('interrupted', '読み込みを中断しました。')

  let operation: SessionScopeOperation
  try {
    operation = beginOperation(scope, signal)
  } catch (error) {
    if (error instanceof SessionChangedError) {
      return fail('session_changed', '認証状態が変わりました。学びを読み込み直してください。')
    }
    return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
  }

  try {
    try {
      operation.assertCurrent('not_sent')
    } catch (error) {
      if (error instanceof SessionChangedError) {
        return fail('session_changed', '認証状態が変わりました。学びを読み込み直してください。')
      }
      return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
    }

    let response: Response
    try {
      // 同期ガードの直後に同じヘッダーでfetchを呼ぶ。
      response = await fetchFn('/api/learnings', {
        method: 'GET',
        headers,
        signal: operation.signal,
        cache: 'no-store',
      })
    } catch {
      try {
        operation.assertCurrent('not_sent')
      } catch (error) {
        if (error instanceof SessionChangedError) {
          return fail('session_changed', '認証状態が変わりました。学びを読み込み直してください。')
        }
        return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
      }
      return fail('interrupted', '通信できませんでした。接続を確認して再試行してください。')
    }

    try {
      operation.assertCurrent('not_sent')
    } catch (error) {
      if (error instanceof SessionChangedError) {
        return fail('session_changed', '認証状態が変わりました。学びを読み込み直してください。')
      }
      return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
    }
    if (signal?.aborted) return fail('interrupted', '読み込みを中断しました。')

    // 本文は見ず、ステータスで判定する（サーバーの本文は画面へ出さない）。
    if (response.status === 401 || response.status === 403) {
      return fail(
        'session',
        '認証、招待、またはアプリの検証が通りませんでした。ログイン状態を確認してください。',
      )
    }
    if (response.status === 429) {
      return fail(
        'rate_limited',
        '利用の回数が上限に達しています。しばらく時間をおいてお試しください。',
      )
    }
    if (response.status === 503) {
      return fail('unavailable', '保存済みの学びを現在取得できません。')
    }
    if (response.status !== 200) {
      return fail('unexpected', '学びの読み込みに失敗しました。')
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      try {
        operation.assertCurrent('not_sent')
      } catch (error) {
        if (error instanceof SessionChangedError) {
          return fail('session_changed', '認証状態が変わりました。学びを読み込み直してください。')
        }
        return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
      }
      return fail('unexpected', 'サーバーからの応答を読み取れませんでした。')
    }
    // 本文を読んでいる間に中断された応答は、結果として返さない。
    if (signal?.aborted) return fail('interrupted', '読み込みを中断しました。')

    const parsed = ReusableLearningListResponseSchema.safeParse(body)
    if (!parsed.success) {
      return fail('incomplete', '学びの一覧を安全に確認できません。')
    }
    const { learnings, listInfo } = parsed.data
    if (
      listInfo.truncated ||
      listInfo.skippedInvalid > 0 ||
      listInfo.returned !== learnings.length ||
      !isSelectableLearningList(learnings)
    ) {
      return fail('incomplete', '学びの一覧に未取得または不正な項目があります。')
    }

    // 完全な一覧を採用する直前に、非同期・同期の両方で要求開始時の認証世代を確認する。
    try {
      await assertCurrentSessionScope(scope)
      operation.assertCurrent('not_sent')
    } catch (error) {
      if (error instanceof SessionChangedError) {
        return fail('session_changed', '認証状態が変わりました。学びを読み込み直してください。')
      }
      return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
    }

    return { ok: true, learnings: { scope, value: learnings } }
  } finally {
    operation.dispose()
  }
}
