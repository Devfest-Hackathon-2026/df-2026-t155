import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { init, getToken, getAuthHeaders, getAuthHeadersForScope, getClientAuth, provider } =
  vi.hoisted(() => ({
    getAuthHeadersForScope: vi.fn(),
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
vi.mock('./session-scope', () => ({ getAuthHeadersForScope }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY', 'test-site-key')
  getClientAuth.mockReturnValue({ app: {} })
  init.mockReturnValue({})
  getToken.mockResolvedValue({ token: 'test.app.check' })
  getAuthHeadersForScope.mockImplementation(
    async () => new Headers({ Authorization: 'Bearer scoped.id.token' }),
  )
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

  it('サイトキーが無ければ、設定不足として失敗し、SDKもBearerも使わない', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY', '  ')
    const { getProtectedApiHeaders, getProtectedApiHeadersForScope } =
      await import('./protected-api')

    await expect(getProtectedApiHeaders()).rejects.toMatchObject({
      name: 'AppCheckUnavailableError',
      code: 'config_missing',
    })
    await expect(getProtectedApiHeadersForScope({ uid: 'u' })).rejects.toMatchObject({
      name: 'AppCheckUnavailableError',
      code: 'config_missing',
    })
    expect(init).not.toHaveBeenCalled()
    expect(getAuthHeaders).not.toHaveBeenCalled()
    expect(getAuthHeadersForScope).not.toHaveBeenCalled()
  })

  it('トークン取得の失敗は、SDKの原文を含めずに失敗する', async () => {
    const { getProtectedApiHeaders } = await import('./protected-api')
    getToken.mockRejectedValue(new Error('recaptcha secret-detail'))

    const error = await getProtectedApiHeaders().catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'AppCheckUnavailableError', code: 'token_failed' })
    expect((error as Error).message).not.toContain('secret-detail')
  })
})

describe('スコープ付きの保護APIヘッダー', () => {
  const scope = { uid: 'user-a' }

  it('スコープのBearerとApp Checkの両方を返す', async () => {
    const { getProtectedApiHeadersForScope } = await import('./protected-api')
    const headers = await getProtectedApiHeadersForScope(scope)

    expect(getAuthHeadersForScope).toHaveBeenCalledExactlyOnceWith(scope)
    expect(getAuthHeaders).not.toHaveBeenCalled()
    expect(headers.get('Authorization')).toBe('Bearer scoped.id.token')
    expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
  })

  it('UIDがスコープと違えば、SessionChangedErrorのまま失敗し、ヘッダーを返さない', async () => {
    const { SessionChangedError } =
      await vi.importActual<typeof import('./session-scope')>('./session-scope')
    getAuthHeadersForScope.mockRejectedValue(new SessionChangedError())
    const { getProtectedApiHeadersForScope } = await import('./protected-api')

    await expect(getProtectedApiHeadersForScope(scope)).rejects.toMatchObject({
      code: 'session_changed',
    })
  })

  it('App Checkを取れなければ、スコープのトークンも取らずに失敗する', async () => {
    getToken.mockRejectedValue(new Error('app check unavailable'))
    const { getProtectedApiHeadersForScope } = await import('./protected-api')

    await expect(getProtectedApiHeadersForScope(scope)).rejects.toMatchObject({
      name: 'AppCheckUnavailableError',
    })
    expect(getAuthHeadersForScope).not.toHaveBeenCalled()
  })
})
