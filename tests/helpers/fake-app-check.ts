import { vi } from 'vitest'

// 保護APIのヘッダー（Bearer＋App Check）を通す画面・クライアントのテスト用に、
// firebase/app-check と Firebase初期化だけを差し替える偽物。protected-api.ts は本物を通す。
//
// 使い方（テストファイルの先頭）：
//   vi.mock('firebase/app-check', async () => (await import('../../../tests/helpers/fake-app-check')).appCheckModule)
//   vi.mock('@/lib/firebase/client', () => ({ getClientAuth: () => ({ app: {} }) }))
// beforeEach で fakeAppCheck.reset() を呼ぶ（鍵の環境変数も設定される）。
export const APP_CHECK_TOKEN = 'test.app.check'

const getToken = vi.fn<() => Promise<{ token: string }>>()

export const appCheckModule = {
  initializeAppCheck: () => ({}),
  getToken,
  ReCaptchaEnterpriseProvider: class {},
}

export const fakeAppCheck = {
  getToken,
  reset() {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY', 'test-site-key')
    getToken.mockReset()
    getToken.mockResolvedValue({ token: APP_CHECK_TOKEN })
  },
}
