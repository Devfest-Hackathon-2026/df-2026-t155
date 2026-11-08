'use client'

import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check'

import { getClientAuth } from '../firebase/client'
import { getAuthHeaders } from './client'

let appCheck: AppCheck | undefined

// 課金・保存APIへの同一オリジン要求だけに使う。認証疎通用のBearerヘルパーは独立に保つ。
export async function getProtectedApiHeaders(): Promise<Headers> {
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY?.trim()
  if (!siteKey) throw new Error('アプリの検証設定がありません。')
  appCheck ??= initializeAppCheck(getClientAuth().app, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: false,
  })
  const { token } = await getToken(appCheck)
  const headers = await getAuthHeaders()
  headers.set('X-Firebase-AppCheck', token)
  return headers
}
