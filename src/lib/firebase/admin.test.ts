import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  applicationDefault: vi.fn(),
  getAuth: vi.fn(),
}))
vi.mock('firebase-admin/app', () => sdk)
vi.mock('firebase-admin/auth', () => ({ getAuth: sdk.getAuth }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('FIREBASE_PROJECT_ID', 'real-project')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'real-project')
  vi.stubEnv('FIREBASE_USE_EMULATORS', undefined)
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', undefined)
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', undefined)
  sdk.getApps.mockReturnValue([])
  sdk.initializeApp.mockReturnValue({ name: 'groundtrip-admin' })
  sdk.applicationDefault.mockReturnValue({ type: 'adc-test-double' })
})

describe('Admin SDK初期化（SDKモック）', () => {
  it('プロジェクトを明示し、ADCを使う', async () => {
    const { getAdminAuth } = await import('./admin')
    getAdminAuth()
    expect(sdk.applicationDefault).toHaveBeenCalledOnce()
    expect(sdk.initializeApp).toHaveBeenCalledWith(
      { projectId: 'real-project', credential: { type: 'adc-test-double' } },
      'groundtrip-admin',
    )
  })

  it('同一プロジェクトの既存インスタンスを再利用する', async () => {
    sdk.getApps.mockReturnValue([
      { name: 'groundtrip-admin', options: { projectId: 'real-project' } },
    ])
    const { getAdminAuth } = await import('./admin')
    getAdminAuth()
    expect(sdk.initializeApp).not.toHaveBeenCalled()
    expect(sdk.applicationDefault).not.toHaveBeenCalled()
  })

  it('別プロジェクトの既存インスタンスを拒否する', async () => {
    sdk.getApps.mockReturnValue([
      { name: 'groundtrip-admin', options: { projectId: 'other-project' } },
    ])
    const { getAdminAuth } = await import('./admin')
    expect(() => getAdminAuth()).toThrow()
    expect(sdk.getAuth).not.toHaveBeenCalled()
  })

  it('本番へのEmulator変数混入を初期化前に拒否する', async () => {
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099')
    const { getAdminAuth } = await import('./admin')
    expect(() => getAdminAuth()).toThrow()
    expect(sdk.initializeApp).not.toHaveBeenCalled()
  })

  it('明示的なEmulator構成ではADCを要求しない', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('FIREBASE_PROJECT_ID', 'demo-groundtrip')
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-groundtrip')
    vi.stubEnv('FIREBASE_USE_EMULATORS', 'true')
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099')
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080')
    const { getAdminAuth } = await import('./admin')
    getAdminAuth()
    expect(sdk.applicationDefault).not.toHaveBeenCalled()
    expect(sdk.initializeApp).toHaveBeenCalledWith(
      { projectId: 'demo-groundtrip' },
      'groundtrip-admin',
    )
  })
})
