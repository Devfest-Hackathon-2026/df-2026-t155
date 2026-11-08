import { getProtectedApiHeaders } from '@/lib/auth/protected-api'

import { createBrowserVerifier, type BrowserVerify } from './browser-verify'

// 実際の画面で使う照合の入口。本人のBearer＋App Checkを付け、取得できなければ送信しない（fail-closed）。
// browser-verify.ts は認証SDKを読み込まない作りのままにし、SDKとの接続はこのファイルに集める。
export const verifyTripWithProtectedApi: BrowserVerify = createBrowserVerifier({
  getHeaders: getProtectedApiHeaders,
  requireAuth: true,
})
