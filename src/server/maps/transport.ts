import { MapsCallError } from './errors'
import type { MapsAuth } from './auth'

export const MAPS_TIMEOUT_MS = 15_000

export interface MapsTransportDeps {
  auth: MapsAuth
  fetchFn?: typeof fetch
  timeoutMs?: number
}

// Places・Routesへ、JSONのPOSTを1回だけ送る。課金対象のため、自動で再試行しない。
// 応答の中身は検証せず、JSONとして解釈した値（unknown）を返す。検証は各アダプターが行う。
export async function postJson(
  deps: MapsTransportDeps,
  request: { url: string; body: unknown; fieldMask: string; signal?: AbortSignal },
): Promise<unknown> {
  const { auth, fetchFn = fetch, timeoutMs = MAPS_TIMEOUT_MS } = deps
  // 認証（ADCのトークン取得）と、Mapsへの送受信の合計に、1つの期限（timeoutMs）を設ける。
  // 経過時間は、単調時計（performance.now）で測る。イベントループが遅れて、期限のタイマーが実行されなくても、
  // 期限を過ぎたあとの認証の成功を、有効として扱わない（Mapsへの送信の直前にも、期限を確認する）。
  const startedAt = performance.now()
  const remaining = () => timeoutMs - (performance.now() - startedAt)

  const timedOut = () =>
    new MapsCallError('timeout', 'Google Maps Platformの応答がタイムアウトしました')

  if (request.signal?.aborted) throw timedOut()

  let authHeaders: Record<string, string>
  try {
    authHeaders = await withDeadline(auth.getHeaders(), timeoutMs)
  } catch (error) {
    // アダプター自身の期限切れだけを、timeoutとして扱う。
    if (error === DEADLINE_EXCEEDED) throw timedOut()
    // 認証の実装が投げた例外は、型にかかわらず（MapsCallErrorでも、通常のErrorでも）、元の例外を伝播させず、
    // 安全なauth_failedへ変換する。メッセージや原因に、機密情報が含まれ得るため。
    throw new MapsCallError('auth_failed', 'Google Maps Platformの認証に失敗しました')
  }
  if (remaining() <= 0 || request.signal?.aborted) throw timedOut()

  // 送信の内容は、期限の確認の前に、すべて組み立てる（組み立てに時間がかかった場合も、確認に含める）。
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.floor(remaining())))
  const init: RequestInit = {
    method: 'POST',
    redirect: 'error',
    headers: {
      ...authHeaders,
      // 日本語のクエリをUTF-8で送ることを明示する。
      'Content-Type': 'application/json; charset=utf-8',
      // 請求は要求したフィールドで決まる。必要最小限だけを指定する。
      'X-Goog-FieldMask': request.fieldMask,
    },
    body: JSON.stringify(request.body),
    // 認証と準備に使った時間を除いた、残りの時間。
    signal: request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal,
  }
  // 実際にMapsを呼び出す直前にも、期限を確認する。期限を過ぎていれば、送らない（課金を発生させない）。
  if (remaining() <= 0 || request.signal?.aborted) throw timedOut()

  let response: Response
  let text: string
  try {
    response = await fetchFn(request.url, init)
    text = await response.text()
  } catch (error) {
    // 外部由来の例外は、名前の判定だけに使い、保持も再送出もしない。
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new MapsCallError('timeout', 'Google Maps Platformの応答がタイムアウトしました')
    }
    throw new MapsCallError('network', 'Google Maps Platformへ接続できませんでした')
  }

  // 本文の受信が完了した時点でも、期限を確認する（イベントループの遅れで、期限のタイマーが実行されず、
  // 期限を過ぎてから正常に終了した場合を、成功として扱わない）。
  if (remaining() <= 0 || request.signal?.aborted) throw timedOut()

  if (!response.ok) {
    throw new MapsCallError('api_error', 'Google Maps Platformがエラーを返しました', {
      status: response.status,
      apiStatus: extractApiStatus(text),
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    // JSON解析エラーのメッセージには、応答本文の断片が含まれ得るため、保持しない。
    throw new MapsCallError(
      'invalid_response',
      'Google Maps Platformの応答を解釈できませんでした',
      {
        status: response.status,
      },
    )
  }
}

// 認証など、時間のかかる準備に期限を設ける。期限が切れたら、DEADLINE_EXCEEDEDで失敗させる。
// 元の処理は止められないが、結果は捨てる（期限後に完了しても、呼び出し側は先へ進まない）。
const DEADLINE_EXCEEDED = Symbol('deadline-exceeded')

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(DEADLINE_EXCEEDED), timeoutMs)
  })
  // 期限後に元の処理が失敗しても、未処理の拒否にしない。
  promise.catch(() => undefined)
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// Googleのエラー状態名は、既知の正規コード（Google APIの共通のエラーコード）だけを保持する。
// 文字種・長さだけで通すと、エラー本文に含まれる任意の文字列を保持してしまうため、許可リストにする。
const KNOWN_API_STATUSES: ReadonlySet<string> = new Set([
  'INVALID_ARGUMENT',
  'FAILED_PRECONDITION',
  'OUT_OF_RANGE',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'ABORTED',
  'ALREADY_EXISTS',
  'RESOURCE_EXHAUSTED',
  'CANCELLED',
  'DATA_LOSS',
  'UNKNOWN',
  'INTERNAL',
  'UNIMPLEMENTED',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
])

function extractApiStatus(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error = parsed.error
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = error.status
        if (typeof status === 'string' && KNOWN_API_STATUSES.has(status)) return status
      }
    }
  } catch {
    // 本文がJSONでなければ、状態名なし。
  }
  return undefined
}
