// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  demo: vi.fn(),
  start: vi.fn(),
  generate: vi.fn(),
  headers: vi.fn(),
}))
vi.mock('@/lib/auth/use-session-scope', () => ({ useSessionScope: mocks.session }))
vi.mock('@/lib/firebase/client', () => ({ isDemoSessionActive: mocks.demo }))
vi.mock('@/lib/auth/client', () => ({ startNewAnonymousSession: mocks.start }))
vi.mock('@/features/trip-planner/api-client', () => ({ requestTripGeneration: mocks.generate }))
vi.mock('@/lib/auth/protected-api', () => ({ getProtectedApiHeadersForScope: mocks.headers }))
vi.mock('@/lib/auth/session-scope', () => ({
  beginSessionScopeOperation: () => ({
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    dispose: vi.fn(),
  }),
}))
vi.mock('./home-planner', () => ({
  HomePlanner: ({ generate }: { generate: (request: object, options: object) => void }) => (
    <button
      onClick={() => generate({}, { learningSelection: { value: [{ id: 'a', version: 1 }] } })}
    >
      generate
    </button>
  ),
}))
import { SessionHomePlanner } from './session-home-planner'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('デモ終了時は新規匿名セッションを作らず、提出URLの再訪を案内する', () => {
  mocks.demo.mockReturnValue(true)
  mocks.session.mockReturnValue({
    status: 'session_ended',
    error: { message: 'ended' },
    scopeEpoch: 1,
  })
  render(<SessionHomePlanner />)
  expect(screen.getByText(/提出資料のURLを開き直して/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '新しい利用を始める' })).toBeNull()
  expect(mocks.start).not.toHaveBeenCalled()
})

it('通常セッション終了時は利用者の操作でのみ新規開始する', async () => {
  mocks.demo.mockReturnValue(false)
  mocks.session.mockReturnValue({
    status: 'session_ended',
    error: { message: 'ended' },
    scopeEpoch: 1,
  })
  mocks.start.mockResolvedValue(undefined)
  render(<SessionHomePlanner />)
  expect(mocks.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '新しい利用を始める' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
})

it('認証済みの生成は選択を渡し、スコープ付きヘッダーを一度だけ取得する', async () => {
  const scope = { uid: 'demo-user' }
  mocks.demo.mockReturnValue(true)
  mocks.session.mockReturnValue({ status: 'authenticated', scope, scopeEpoch: 0 })
  mocks.headers.mockResolvedValue(
    new Headers({ Authorization: 'Bearer token', 'X-Firebase-AppCheck': 'check' }),
  )
  mocks.generate.mockImplementation(async (_request, options) => {
    await options.getHeaders()
    return { ok: false, failure: { kind: 'unexpected', message: 'test' } }
  })
  render(<SessionHomePlanner />)
  fireEvent.click(screen.getByRole('button', { name: 'generate' }))
  await waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce())
  expect(mocks.generate.mock.calls[0][1].learningSelection).toEqual({
    value: [{ id: 'a', version: 1 }],
  })
  expect(mocks.headers).toHaveBeenCalledExactlyOnceWith(scope)
})
