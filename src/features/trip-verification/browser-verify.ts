import type { Trip } from '@/domain'

import {
  AuthRequiredError,
  isAuthError,
  requestTripVerification,
  type VerificationResult,
} from './api-client'

// 画面から照合APIを呼ぶ入口。認証ヘッダーを付ける場所は、ここの1か所だけにする。
//
// 実際の画面では protected-verify.ts の `verifyTripWithProtectedApi`
// （`createBrowserVerifier({ getHeaders: getProtectedApiHeaders, requireAuth: true })`）を使う。
// ここ（verifyTripFromBrowser）はヘッダーを付けない素の入口で、テスト・認証なしの用途に残している。
//
// requireAuth（既定は false）：
// - false（現状）：トークンを取得できなくても、ヘッダーなしで送り、判断はサーバーに任せる。
//   サーバー側にまだ認証が無いため、この間は、認証の有無で挙動を変えない。
// - true：トークンを取得できなければ、送信せずに失敗させる（fail-closed）。認証が必須になった後に、
//   未認証の依頼を、課金のあるAPIへ送らないための設定。
// クライアントでの二重送信の防止や、この入口の認証は、課金の利用制限の代わりにならない。
// サーバー側の認証・利用制限（#29）が必要である（docs/TRIP_VERIFICATION.md）。
export type AuthHeadersProvider = () => Promise<Headers | undefined>

export interface BrowserVerifyAuth {
  getHeaders?: AuthHeadersProvider
  requireAuth?: boolean
}

export function withAuthHeaders(
  base: typeof fetch,
  getHeaders?: AuthHeadersProvider,
  { requireAuth = false }: { requireAuth?: boolean } = {},
): typeof fetch {
  if (!getHeaders) {
    if (!requireAuth) return base
    // 認証が必須なのに、認証情報の提供元が無い：送信しない。
    return async () => {
      throw new AuthRequiredError()
    }
  }
  return async (input, init) => {
    let extra: Headers | undefined
    try {
      extra = await getHeaders()
    } catch (error) {
      // 認証が必須なら、取得の失敗を伝える（認証基盤のエラー〈ClientAuthError〉は、その文言を使う）。送信しない。
      if (requireAuth) throw isAuthError(error) ? error : new AuthRequiredError()
      // 必須でなければ、取得できなくても、呼び出しの挙動は変えない（ヘッダーなしで送り、判断はサーバーに任せる）。
      extra = undefined
    }
    if (requireAuth && !extra?.has('Authorization')) throw new AuthRequiredError()
    if (!extra) return base(input, init)
    const headers = new Headers(init?.headers)
    extra.forEach((value, key) => headers.set(key, value))
    return base(input, { ...init, headers })
  }
}

// fetchはグローバルを呼び出し時に参照する（テストでの差し替えを妨げない）。
const browserFetch: typeof fetch = (input, init) => fetch(input, init)

export type BrowserVerify = (
  trip: Trip,
  options?: { signal?: AbortSignal },
) => Promise<VerificationResult>

export function createBrowserVerifier(auth: BrowserVerifyAuth = {}): BrowserVerify {
  return (trip, options = {}) =>
    requestTripVerification(trip, {
      ...options,
      fetchFn: withAuthHeaders(browserFetch, auth.getHeaders, { requireAuth: auth.requireAuth }),
    })
}

// 現状の入口：認証ヘッダーを付けない。
export const verifyTripFromBrowser: BrowserVerify = createBrowserVerifier()
