// Google Maps Platform（Places・Routes）の呼び出し失敗。HTTP 200の「結果なし」は失敗ではなく、
// 各アダプターが `no_candidates` / `no_route` として返す。ここは「呼び出しそのものの失敗」だけを表す。
// 原因の区分とHTTPステータス、Googleのエラー状態名だけを運び、リクエスト本文・クエリ・トークンは含めない。
// 外部由来の例外（認証ライブラリの例外・JSON解析エラーなど）は、`cause`にも保持しない。
// 例外のメッセージや応答の断片に、トークンや応答本文が含まれ得るため、安全な分類情報だけを公開する。
export type MapsFailureReason =
  | 'not_configured'
  | 'invalid_request'
  | 'unsupported_mode'
  | 'auth_failed'
  | 'timeout'
  | 'network'
  | 'api_error'
  | 'invalid_response'

export class MapsCallError extends Error {
  readonly reason: MapsFailureReason
  readonly status?: number
  // 例：PERMISSION_DENIED、RESOURCE_EXHAUSTED。診断用で、利用者へは出さない。
  readonly apiStatus?: string

  constructor(
    reason: MapsFailureReason,
    message: string,
    options?: { status?: number; apiStatus?: string },
  ) {
    super(message)
    this.name = 'MapsCallError'
    this.reason = reason
    this.status = options?.status
    this.apiStatus = options?.apiStatus
  }
}
