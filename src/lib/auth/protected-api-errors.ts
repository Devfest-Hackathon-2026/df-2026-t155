// 保護API（課金・保存）を画面から呼ぶときの、ヘッダー取得失敗と応答ステータスの分類。
// Firebase SDKを読み込まない（各クライアントが、認証SDKを持ち込まずに失敗を見分けられるようにする）。

// App Checkのトークンを用意できなかった。鍵の設定がない（config_missing）か、
// reCAPTCHA・トークン取得に失敗した（token_failed）。この場合は要求を送信しない（fail-closed）。
// SDKの生エラーはここへ持ち込まない。
export class AppCheckUnavailableError extends Error {
  readonly code: 'config_missing' | 'token_failed'

  constructor(code: 'config_missing' | 'token_failed') {
    super(
      code === 'config_missing'
        ? 'アプリの検証設定がありません。'
        : 'アプリの検証トークンを取得できませんでした。',
    )
    this.name = 'AppCheckUnavailableError'
    this.code = code
  }
}

export type ProtectedHeaderFailure = 'app_check_unavailable' | 'auth_required'

// ヘッダー取得で投げられたエラーを、画面で区別する2種類に分ける。
// 認証基盤のエラー・セッション変更・その他は、いずれも「認証情報を用意できなかった」として扱う。
export function classifyProtectedHeaderError(error: unknown): ProtectedHeaderFailure {
  return error instanceof Error && error.name === 'AppCheckUnavailableError'
    ? 'app_check_unavailable'
    : 'auth_required'
}

// 保護APIの共通ステータス。本文の形に関わらずステータスで判定し、サーバーの本文は画面へ出さない。
export type ProtectedStatusFailure = 'unauthorized' | 'rate_limited'

export function classifyProtectedStatus(status: number): ProtectedStatusFailure | null {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  return null
}

// 画面に出す固定の文言（サーバーの本文は使わない）。
export const PROTECTED_FAILURE_MESSAGES = {
  unauthorized:
    '認証、招待、またはアプリの検証が通りませんでした。認証の有効期限が切れているか、このアカウントは利用できない可能性があります。',
  rate_limited: '利用の回数が上限に達しています。',
  auth_required: '認証情報を取得できなかったため、依頼を送信しませんでした。',
  app_check_unavailable:
    'アプリの検証（App Check）を用意できなかったため、依頼を送信しませんでした。',
} as const
