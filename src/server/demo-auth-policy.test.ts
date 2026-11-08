import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { isDemoAuthPolicyConfigured } from './demo-auth-policy'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    request = request
  },
}))

const permissions = { disabledUserDeletion: true, disabledUserSignup: false }
const config = { subtype: 'IDENTITY_PLATFORM', client: { permissions } }

beforeEach(() => {
  request.mockReset()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('FIREBASE_USE_EMULATORS', undefined)
  vi.stubEnv('FIREBASE_PROJECT_ID', 'demo-groundtrip')
})

afterEach(() => vi.unstubAllEnvs())

it('プロジェクトの現行設定が自己削除を禁止し、通常の新規登録を許可するときだけ進む', async () => {
  request.mockResolvedValue({ data: config })
  const { signal } = new AbortController()
  await expect(isDemoAuthPolicyConfigured(signal)).resolves.toBe(true)
  expect(request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: 'https://identitytoolkit.googleapis.com/admin/v2/projects/demo-groundtrip/config',
      signal,
      retry: false,
    }),
  )
})

it.each([
  {},
  { ...config, subtype: 'FIREBASE_AUTH' },
  { ...config, client: { permissions: { ...permissions, disabledUserDeletion: false } } },
  { ...config, client: { permissions: { ...permissions, disabledUserSignup: true } } },
  { ...config, signIn: { email: { enabled: true } } },
  { ...config, signIn: { phoneNumber: { enabled: true } } },
])('発行条件を満たさない設定を拒否する (%j)', async (data) => {
  request.mockResolvedValue({ data })
  await expect(isDemoAuthPolicyConfigured(new AbortController().signal)).resolves.toBe(false)
})

it('本番はEmulatorフラグで検証を省略できない', async () => {
  vi.stubEnv('FIREBASE_USE_EMULATORS', 'true')
  request.mockRejectedValue(new Error('IAM unavailable'))
  await expect(isDemoAuthPolicyConfigured(new AbortController().signal)).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
})
