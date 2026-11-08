'use client'

import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check'

import { getClientAuth } from '../firebase/client'
import { getAuthHeaders } from './client'
import { AppCheckUnavailableError } from './protected-api-errors'
import { getAuthHeadersForScope, type SessionScope } from './session-scope'

let appCheck: AppCheck | undefined

// App Checkのトークンを取る。鍵がない・初期化やトークン取得に失敗したときは例外（呼び出し側は送信しない）。
// SDKの生エラーは外へ出さず、AppCheckUnavailableErrorに置き換える。
async function getAppCheckToken(): Promise<string> {
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY?.trim()
  if (!siteKey) throw new AppCheckUnavailableError('config_missing')
  try {
    appCheck ??= initializeAppCheck(getClientAuth().app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: false,
    })
    const { token } = await getToken(appCheck)
    return token
  } catch {
    throw new AppCheckUnavailableError('token_failed')
  }
}

// 課金・保存APIへの同一オリジン要求だけに使う。認証疎通用のBearerヘルパーは独立に保つ。
export async function getProtectedApiHeaders(): Promise<Headers> {
  const token = await getAppCheckToken()
  const headers = await getAuthHeaders()
  headers.set('X-Firebase-AppCheck', token)
  return headers
}

// 取得時のセッション（スコープ）と同じUIDのときだけ、Bearer＋App Checkを返す。
// UIDが違えばSessionChangedErrorで失敗し、別のUIDのトークンを送らない。
// App Checkを取れないときも例外（fail-closed）。
export async function getProtectedApiHeadersForScope(scope: SessionScope): Promise<Headers> {
  const token = await getAppCheckToken()
  const headers = await getAuthHeadersForScope(scope)
  headers.set('X-Firebase-AppCheck', token)
  return headers
}
