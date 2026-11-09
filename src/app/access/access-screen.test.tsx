// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { AccessScreen } from './access-screen'

const { signIn, getAppCheckToken, initializeAuth, initializeApp } = vi.hoisted(() => ({
  signIn: vi.fn(),
  getAppCheckToken: vi.fn(),
  initializeAuth: vi.fn(),
  initializeApp: vi.fn(),
}))
vi.mock('firebase/app', () => ({ getApps: () => [], initializeApp }))
vi.mock('firebase/auth', () => ({
  signInWithCustomToken: signIn,
  initializeAuth,
  browserSessionPersistence: {},
}))
vi.mock('@/lib/auth/protected-api', () => ({ getAppCheckToken }))

const ticket = 'a'.repeat(43)
const fetchExchange = vi.fn()
const auth = { app: {} }
const marker = 'groundtrip-demo-session'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchExchange)
  vi.stubGlobal('navigator', {
    locks: {
      request: (name: string, _: LockOptions, callback: (lock: { name: string }) => unknown) =>
        callback({ name }),
    },
  })
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-groundtrip')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'demo-api-key')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'example.com')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'demo-app-id')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', 'false')
  window.sessionStorage.clear()
  window.history.replaceState(null, '', `/access#ticket=${ticket}`)
  initializeAuth.mockReturnValue(auth)
  initializeApp.mockReturnValue(auth.app)
  getAppCheckToken.mockImplementation(async () => {
    expect(window.location.hash).toBe('')
    return 'test.app.check'
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('フラグメントを消してからApp Checkを取得し、Strict ModeでもPOSTを一度だけ送る', async () => {
  fetchExchange.mockResolvedValue(new Response(null, { status: 403 }))
  render(
    <StrictMode>
      <AccessScreen />
    </StrictMode>,
  )
  expect((await screen.findByRole('alert')).textContent).toContain('アクセスを確認できません')
  expect(window.location.pathname).toBe('/access')
  expect(window.location.hash).toBe('')
  expect(getAppCheckToken).toHaveBeenCalledExactlyOnceWith(auth.app)
  expect(fetchExchange).toHaveBeenCalledExactlyOnceWith(
    '/api/access/exchange',
    expect.objectContaining({
      method: 'POST',
      body: ticket,
      headers: { 'Content-Type': 'text/plain', 'X-Firebase-AppCheck': 'test.app.check' },
      credentials: 'omit',
      mode: 'same-origin',
      referrerPolicy: 'same-origin',
      redirect: 'error',
    }),
  )
  expect(signIn).not.toHaveBeenCalled()
  expect(initializeAuth).not.toHaveBeenCalled()
})

it('不正なフラグメントでは通信を始めない', async () => {
  window.history.replaceState(null, '', '/access#ticket=invalid')
  render(<AccessScreen />)
  expect((await screen.findByRole('alert')).textContent).toContain('アクセスを確認できません')
  expect(window.location.hash).toBe('')
  expect(fetchExchange).not.toHaveBeenCalled()
  expect(getAppCheckToken).not.toHaveBeenCalled()
})

it('交換後のFirebase障害でも匿名認証・デモセッションの有効化へ進まない', async () => {
  fetchExchange.mockResolvedValue(Response.json({ customToken: 'test.custom.token' }))
  signIn.mockRejectedValue(new Error('認証サービスエラー'))
  render(<AccessScreen />)
  expect((await screen.findByRole('alert')).textContent).toContain('デモへ接続できません')
  expect(signIn).toHaveBeenCalledExactlyOnceWith(auth, 'test.custom.token')
  expect(window.sessionStorage.getItem(marker)).toBeNull()
})

it('離脱後に同じデモUIDへのサインインが完了しても旧画面を無効化する', async () => {
  fetchExchange.mockResolvedValue(Response.json({ customToken: 'test.custom.token' }))
  window.sessionStorage.setItem(marker, 'old')
  const writes = vi.spyOn(Storage.prototype, 'setItem')
  const pending = Promise.withResolvers<unknown>()
  signIn.mockReturnValue(pending.promise)
  const { unmount } = render(<AccessScreen />)
  await waitFor(() => expect(signIn).toHaveBeenCalledOnce())
  unmount()
  pending.resolve(undefined)
  await waitFor(() => expect(window.sessionStorage.getItem(marker)).toMatch(/^[0-9a-f-]{36}$/))
  expect(writes.mock.calls.filter(([key]) => key === marker)).toHaveLength(1)
})

it('終了の再試行が必要なタブでは、券を交換しない', async () => {
  window.sessionStorage.setItem(marker, 'exit:old')
  render(<AccessScreen />)
  expect((await screen.findByRole('alert')).textContent).toContain(
    '前のデモの終了操作が残っています',
  )
  expect(window.location.hash).toBe('')
  expect(getAppCheckToken).not.toHaveBeenCalled()
  expect(fetchExchange).not.toHaveBeenCalled()
  expect(signIn).not.toHaveBeenCalled()
})

it('ページ離脱後に券の交換が完了しても、終了したデモの目印を再作成しない', async () => {
  fetchExchange.mockResolvedValue(Response.json({ customToken: 'test.custom.token' }))
  window.sessionStorage.setItem(marker, 'old')
  const pending = Promise.withResolvers<void>()
  signIn.mockReturnValue(pending.promise)
  render(<AccessScreen />)
  await waitFor(() => expect(signIn).toHaveBeenCalledOnce())

  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
  window.sessionStorage.removeItem(marker)
  pending.resolve()

  expect((await screen.findByRole('alert')).textContent).toContain('デモへ接続できません')
  expect(window.sessionStorage.getItem(marker)).toBeNull()
})
