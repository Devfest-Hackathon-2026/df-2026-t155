// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  signInWithCustomToken: vi.fn(),
  signOut: vi.fn(),
  setPersistence: vi.fn(),
  getAuth: vi.fn(),
  initializeAuth: vi.fn(),
  browserSessionPersistence: {},
}))
vi.mock('firebase/app', () => ({ getApps: () => [], initializeApp: vi.fn() }))
vi.mock('firebase/auth', () => sdk)
vi.mock('@/lib/auth/protected-api', () => ({ getAppCheckToken: async () => 'test.app.check' }))

const marker = 'groundtrip-demo-session'
const credential = 'test-sdk-credential'

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  window.sessionStorage.clear()
  window.sessionStorage.setItem(marker, 'demo-marker')
  window.sessionStorage.setItem(credential, 'old')
  window.history.replaceState(null, '', '/access#ticket=' + 'a'.repeat(43))
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-groundtrip')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'demo-api-key')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'example.com')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'demo-app-id')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', 'false')
  sdk.initializeAuth.mockReturnValue({ app: {} })
  sdk.signOut.mockImplementation(async () => window.sessionStorage.removeItem(credential))
  vi.stubGlobal('fetch', async () => Response.json({ customToken: 'test.custom.token' }))

  // 同じタブの別モジュールからも見える排他ロック。SDKに渡した処理の完了まで保持する。
  const queue = new Map<string, Promise<unknown>>()
  vi.stubGlobal('navigator', {
    locks: {
      request(
        name: string,
        options: LockOptions,
        callback: (lock: { name: string } | null) => unknown,
      ) {
        const previous = queue.get(name)
        if (previous && options.ifAvailable) return Promise.resolve(callback(null))
        const result = (previous ?? Promise.resolve()).then(() => {
          options.signal?.throwIfAborted()
          return callback({ name })
        })
        const tail = result.catch(() => {})
        queue.set(name, tail)
        void tail.then(() => {
          if (queue.get(name) === tail) queue.delete(name)
        })
        if (!options.signal) return result
        const signal = options.signal
        const aborted = new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return Promise.race([result, aborted])
      },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each(['SPA', '別文書', 'SDK失敗'])(
  '再認証から離脱した場合も最終signOutがSDK完了を待つ（%s）',
  async (mode) => {
    const pending = Promise.withResolvers<void>()
    sdk.signInWithCustomToken.mockImplementation(async () => {
      await pending.promise
      window.sessionStorage.setItem(credential, 'late')
    })
    const { AccessScreen } = await import('./access-screen')
    const access = render(<AccessScreen />)
    await waitFor(() => expect(sdk.signInWithCustomToken).toHaveBeenCalledOnce())
    if (mode === '別文書') {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
      vi.resetModules()
    }
    access.unmount()
    window.history.replaceState(null, '', '/terms')

    const { endDemoSession } = await import('@/lib/auth/client')
    const exit = endDemoSession()
    const settled = vi.fn()
    void exit.then(settled, settled)
    await act(async () => {})

    try {
      expect(sdk.signOut).not.toHaveBeenCalled()
      expect(settled).not.toHaveBeenCalled()
      expect(window.sessionStorage.getItem(marker)).toBe('exit:demo-marker')
    } finally {
      if (mode === 'SDK失敗') pending.reject(new Error('SDK sign-in failed'))
      else pending.resolve()
      await exit
    }
    expect(sdk.signOut).toHaveBeenCalledOnce()
    expect(window.sessionStorage.getItem(marker)).toBeNull()
    expect(window.sessionStorage.getItem(credential)).toBeNull()
    expect(sdk.getAuth).not.toHaveBeenCalled()
  },
)

it('ロック待ちが長引いたら終了未完了のまま、新規サインインを拒否し、再試行できる', async () => {
  const pending = Promise.withResolvers<void>()
  sdk.signInWithCustomToken.mockReturnValueOnce(pending.promise)
  const { AccessScreen } = await import('./access-screen')
  const first = render(<AccessScreen />)
  await waitFor(() => expect(sdk.signInWithCustomToken).toHaveBeenCalledOnce())
  first.unmount()
  window.history.replaceState(null, '', '/terms')

  const { endDemoSession } = await import('@/lib/auth/client')
  const wait = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(wait.signal)
  const exit = endDemoSession()
  wait.abort(new DOMException('lock wait timed out', 'TimeoutError'))
  await expect(exit).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(sdk.signOut).not.toHaveBeenCalled()
  expect(window.sessionStorage.getItem(marker)).toBe('exit:demo-marker')

  // 別文書で再度券を開いても、保存された終了待ちを優先する。
  vi.resetModules()
  const { AccessScreen: NextAccessScreen } = await import('./access-screen')
  window.history.replaceState(null, '', '/access#ticket=' + 'a'.repeat(43))
  const next = render(<NextAccessScreen />)
  expect((await next.findByRole('alert')).textContent).toContain('前のデモの終了操作が残っています')
  expect(sdk.signInWithCustomToken).toHaveBeenCalledOnce()
  next.unmount()
  window.history.replaceState(null, '', '/terms')

  const retry = endDemoSession()
  pending.resolve()
  await retry
  expect(sdk.signOut).toHaveBeenCalledOnce()
  expect(window.sessionStorage.getItem(marker)).toBeNull()
})

it('離脱前にSDKが始まっていなければ、券の応答が後から来てもサインインしない', async () => {
  const exchange = Promise.withResolvers<Response>()
  const fetchExchange = vi.fn(() => exchange.promise)
  vi.stubGlobal('fetch', fetchExchange)
  const { AccessScreen } = await import('./access-screen')
  const access = render(<AccessScreen />)
  await waitFor(() => expect(fetchExchange).toHaveBeenCalledOnce())
  access.unmount()
  window.history.replaceState(null, '', '/terms')

  const { endDemoSession } = await import('@/lib/auth/client')
  await endDemoSession()
  await act(async () => exchange.resolve(Response.json({ customToken: 'test.custom.token' })))
  expect(sdk.signInWithCustomToken).not.toHaveBeenCalled()
  expect(window.sessionStorage.getItem(marker)).toBeNull()
  expect(window.sessionStorage.getItem(credential)).toBeNull()
})
