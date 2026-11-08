// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { AccessScreen } from './access-screen'

const { signIn, getAppCheckToken, getDemoClientAuth, isDemoSessionActive, activateDemoSession } =
  vi.hoisted(() => ({
    signIn: vi.fn(),
    getAppCheckToken: vi.fn(),
    getDemoClientAuth: vi.fn(),
    isDemoSessionActive: vi.fn(),
    activateDemoSession: vi.fn(),
  }))
vi.mock('firebase/auth', () => ({ signInWithCustomToken: signIn }))
vi.mock('@/lib/auth/protected-api', () => ({ getAppCheckToken }))
vi.mock('@/lib/firebase/client', () => ({
  activateDemoSession,
  getDemoClientAuth,
  isDemoSessionActive,
}))

const ticket = 'a'.repeat(43)
const fetchExchange = vi.fn()
const auth = { app: {} }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchExchange)
  window.history.replaceState(null, '', `/access#ticket=${ticket}`)
  getDemoClientAuth.mockReturnValue(auth)
  getAppCheckToken.mockImplementation(async () => {
    expect(window.location.hash).toBe('')
    return 'test.app.check'
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
  expect(activateDemoSession).not.toHaveBeenCalled()
})

it('離脱後に同じデモUIDへのサインインが完了しても旧画面を無効化する', async () => {
  fetchExchange.mockResolvedValue(Response.json({ customToken: 'test.custom.token' }))
  isDemoSessionActive.mockReturnValue(true)
  const pending = Promise.withResolvers<unknown>()
  signIn.mockReturnValue(pending.promise)
  const { unmount } = render(<AccessScreen />)
  await waitFor(() => expect(signIn).toHaveBeenCalledOnce())
  unmount()
  pending.resolve(undefined)
  await waitFor(() => expect(activateDemoSession).toHaveBeenCalledOnce())
})
