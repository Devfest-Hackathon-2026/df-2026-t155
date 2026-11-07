import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  getAuth: vi.fn(),
  connectAuthEmulator: vi.fn(),
}))
vi.mock('firebase/app', () => sdk)
vi.mock('firebase/auth', () => sdk)

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-groundtrip')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'demo-api-key')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'demo-groundtrip.firebaseapp.com')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'demo-app-id')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', 'true')
  sdk.getApps.mockReturnValue([])
  sdk.initializeApp.mockReturnValue({ name: 'groundtrip-client' })
  sdk.getAuth.mockReturnValue({ emulatorConfig: null })
})

describe('Client SDK初期化（SDKモック）', () => {
  it('明示したWeb設定を使い、Emulator接続と初期化を一度だけ行う', async () => {
    const { getClientAuth } = await import('./client')
    expect(getClientAuth()).toBe(getClientAuth())
    expect(sdk.initializeApp).toHaveBeenCalledOnce()
    expect(sdk.connectAuthEmulator).toHaveBeenCalledOnce()
    expect(sdk.initializeApp).toHaveBeenCalledWith(
      {
        projectId: 'demo-groundtrip',
        apiKey: 'demo-api-key',
        authDomain: 'demo-groundtrip.firebaseapp.com',
        appId: 'demo-app-id',
      },
      'groundtrip-client',
    )
  })

  it('本番設定ではEmulatorへ接続しない', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', 'false')
    const { getClientAuth } = await import('./client')
    getClientAuth()
    expect(sdk.connectAuthEmulator).not.toHaveBeenCalled()
  })

  it('SDKの暗黙のEmulator設定も本番では拒否する', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', 'false')
    sdk.getAuth.mockReturnValue({ emulatorConfig: { host: '127.0.0.1' } })
    const { getClientAuth } = await import('./client')
    expect(() => getClientAuth()).toThrow()
  })

  it('不足した設定をSDK呼び出し前に拒否する', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', undefined)
    const { getClientAuth } = await import('./client')
    expect(() => getClientAuth()).toThrow()
    expect(sdk.initializeApp).not.toHaveBeenCalled()
  })

  it('同一プロジェクトの既存アプリを再利用し、異なるものは拒否する', async () => {
    sdk.getApps.mockReturnValue([
      { name: 'groundtrip-client', options: { projectId: 'demo-groundtrip' } },
    ])
    const { getClientAuth } = await import('./client')
    getClientAuth()
    expect(sdk.initializeApp).not.toHaveBeenCalled()
    vi.resetModules()
    sdk.getApps.mockReturnValue([
      { name: 'groundtrip-client', options: { projectId: 'other-project' } },
    ])
    const reloaded = await import('./client')
    expect(() => reloaded.getClientAuth()).toThrow()
  })
})
