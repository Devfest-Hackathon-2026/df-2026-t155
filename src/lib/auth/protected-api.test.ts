import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { init, getToken, getAuthHeaders, getClientAuth, provider } = vi.hoisted(() => ({
  init: vi.fn(),
  getToken: vi.fn(),
  getAuthHeaders: vi.fn(),
  getClientAuth: vi.fn(),
  provider: vi.fn(),
}))

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: init,
  getToken,
  ReCaptchaEnterpriseProvider: class {
    constructor(siteKey: string) {
      provider(siteKey)
    }
  },
}))
vi.mock('../firebase/client', () => ({ getClientAuth }))
vi.mock('./client', () => ({ getAuthHeaders }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY', 'test-site-key')
  getClientAuth.mockReturnValue({ app: {} })
  init.mockReturnValue({})
  getToken.mockResolvedValue({ token: 'test.app.check' })
  getAuthHeaders.mockImplementation(
    async () => new Headers({ Authorization: 'Bearer user.id.token' }),
  )
})

afterEach(() => vi.unstubAllEnvs())

describe('保護API用のWebクライアント', () => {
  it('FirebaseアプリのApp Checkを1回初期化し、2種類のヘッダーを返す', async () => {
    const { getProtectedApiHeaders } = await import('./protected-api')
    const headers = await getProtectedApiHeaders()
    await getProtectedApiHeaders()

    expect(provider).toHaveBeenCalledExactlyOnceWith('test-site-key')
    expect(init).toHaveBeenCalledTimes(1)
    expect(getToken).toHaveBeenCalledTimes(2)
    expect(headers.get('Authorization')).toBe('Bearer user.id.token')
    expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
  })

  it('検証エラーをトークンなしの認証成功に変換しない', async () => {
    const { getProtectedApiHeaders } = await import('./protected-api')
    getToken.mockRejectedValue(new Error('app check unavailable'))

    await expect(getProtectedApiHeaders()).rejects.toThrow()
    expect(getAuthHeaders).not.toHaveBeenCalled()
  })
})
