import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
  const standardUser = { uid: 'anonymous', isAnonymous: true, getIdToken: vi.fn() }
  const demoUser = { uid: 'shared-demo', isAnonymous: false, getIdToken: vi.fn() }
  const standard = { currentUser: standardUser, authStateReady: vi.fn() }
  const demo: { currentUser: typeof demoUser | null; authStateReady: () => Promise<void> } = {
    currentUser: demoUser,
    authStateReady: vi.fn(),
  }
  return {
    standard,
    demo,
    demoUser,
    getAuth: vi.fn(),
    initializeAuth: vi.fn(),
    setPersistence: vi.fn(),
    signOut: vi.fn(),
    onIdTokenChanged: vi.fn(),
    reload: vi.fn(),
    signInAnonymously: vi.fn(),
    browserSessionPersistence: {},
  }
})
vi.mock('firebase/app', () => ({ getApps: () => [], initializeApp: vi.fn() }))
vi.mock('firebase/auth', () => sdk)

const key = 'groundtrip-demo-session'
const data = new Map<string, string>()
const storage = {
  getItem: vi.fn((key: string) => data.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => data.set(key, value)),
  removeItem: vi.fn((key: string) => data.delete(key)),
}
const location = { pathname: '/', reload: vi.fn() }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  data.clear()
  location.pathname = '/'
  vi.stubGlobal('window', Object.assign(new EventTarget(), { sessionStorage: storage, location }))
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-groundtrip')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'demo-api-key')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'example.com')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'demo-app-id')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', 'false')
  sdk.demo.currentUser = sdk.demoUser
  sdk.getAuth.mockReturnValue(sdk.standard)
  sdk.initializeAuth.mockReturnValue(sdk.demo)
  sdk.signOut.mockImplementation(async () => {
    sdk.demo.currentUser = null
  })
  sdk.reload.mockResolvedValue(undefined)
  sdk.demoUser.getIdToken.mockResolvedValue('demo-token')
  sdk.standard.currentUser.getIdToken.mockResolvedValue('anonymous-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('通常認証では明示的な終了要求も拒否し、既存匿名UIDを保持する', async () => {
  const client = await import('./client')
  await expect(client.getAuthSnapshot()).resolves.toMatchObject({ uid: 'anonymous' })

  await expect(client.endDemoSession()).rejects.toThrow()

  expect(sdk.signOut).not.toHaveBeenCalled()
  expect(sdk.initializeAuth).not.toHaveBeenCalled()
  expect(sdk.signInAnonymously).not.toHaveBeenCalled()
  expect(storage.removeItem).not.toHaveBeenCalled()
  await expect(client.getAuthSnapshot()).resolves.toMatchObject({ uid: 'anonymous' })
})

it('デモ用Authでは匿名アカウントを作らない', async () => {
  data.set(key, 'demo-marker')
  sdk.demo.currentUser = null
  const client = await import('./client')
  await expect(client.startNewAnonymousSession()).rejects.toMatchObject({
    code: 'configuration_error',
  })
  expect(sdk.signInAnonymously).not.toHaveBeenCalled()
  expect(sdk.getAuth).not.toHaveBeenCalled()
})

it('デモの明示終了で通信と認証世代を先に無効化し、signOut完了後にだけ目印を消す', async () => {
  data.set(key, 'demo-marker')
  const client = await import('./client')
  const scopeClient = await import('./session-scope')
  const scope = await scopeClient.captureSessionScope()
  const inFlight = scopeClient.beginSessionScopeOperation(scope)
  const listener = vi.fn()
  const stop = client.observeAuthState(listener)
  const [, onUser] = sdk.onIdTokenChanged.mock.calls[0]
  onUser(sdk.demoUser)
  await vi.waitFor(() =>
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'authenticated' })),
  )
  const signOut = Promise.withResolvers<void>()
  sdk.signOut.mockReturnValueOnce(signOut.promise)
  const pendingToken = Promise.withResolvers<string>()
  const tokenStarted = Promise.withResolvers<void>()
  sdk.demoUser.getIdToken.mockImplementationOnce(() => {
    tokenStarted.resolve()
    return pendingToken.promise
  })
  const lateToken = client.getAuthSnapshot()
  await tokenStarted.promise
  expect(sdk.signOut).not.toHaveBeenCalled()

  const exit = client.endDemoSession()

  expect(inFlight.signal.aborted).toBe(true)
  expect(() => inFlight.assertCurrent()).toThrow(scopeClient.SessionChangedError)
  expect(() => inFlight.assertCurrent('unknown')).toThrow(
    expect.objectContaining({ code: 'session_changed', outcome: 'unknown' }),
  )
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: 'error',
      error: expect.objectContaining({ code: 'demo_exit_pending' }),
      sessionGeneration: 1,
    }),
  )
  await vi.waitFor(() => expect(sdk.signOut).toHaveBeenCalledOnce())
  expect(sdk.signOut).toHaveBeenCalledExactlyOnceWith(sdk.demo)
  expect(data.get(key)).toBe('exit:demo-marker')
  expect(storage.removeItem).not.toHaveBeenCalled()
  const notifications = listener.mock.calls.length
  await expect(client.endDemoSession()).rejects.toThrow()
  await expect(client.getAuthSnapshot()).rejects.toMatchObject({ code: 'demo_exit_pending' })
  onUser(sdk.demoUser)
  pendingToken.resolve('late-token')
  await expect(lateToken).rejects.toMatchObject({ code: 'demo_exit_pending' })
  expect(listener).toHaveBeenCalledTimes(notifications)

  signOut.resolve()
  await exit
  expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(key)
  expect(data.has(key)).toBe(false)
  // 遷移までの旧文書でも、匿名Authを選び直せない。
  await expect(client.getAuthSnapshot()).rejects.toMatchObject({ code: 'demo_exit_pending' })
  expect(sdk.getAuth).not.toHaveBeenCalled()
  expect(sdk.signInAnonymously).not.toHaveBeenCalled()
  inFlight.dispose()
  stop()
})

it('signOut失敗後はタブを再読込しても匿名へ切り替えず、明示的な再試行で終了できる', async () => {
  data.set(key, 'demo-marker')
  const client = await import('./client')
  await client.getAuthSnapshot()
  sdk.signOut.mockRejectedValueOnce(new Error('signOut failed'))

  await expect(client.endDemoSession()).rejects.toThrow('signOut failed')
  expect(data.get(key)).toBe('exit:demo-marker')
  expect(storage.removeItem).not.toHaveBeenCalled()
  await expect(client.getAuthSnapshot()).rejects.toMatchObject({ code: 'demo_exit_pending' })

  vi.resetModules()
  const restored = await import('./client')
  await expect(restored.initializeAnonymousSession()).rejects.toMatchObject({
    code: 'demo_exit_pending',
  })
  await expect(restored.startNewAnonymousSession()).rejects.toMatchObject({
    code: 'demo_exit_pending',
  })
  expect(sdk.signOut).toHaveBeenCalledOnce()
  expect(sdk.getAuth).not.toHaveBeenCalled()
  expect(sdk.signInAnonymously).not.toHaveBeenCalled()

  await restored.endDemoSession()
  expect(sdk.signOut).toHaveBeenCalledTimes(2)
  expect(data.has(key)).toBe(false)
})

it('別文書でデモの目印が消えたら、遅れて返った旧文書のトークンを使わない', async () => {
  data.set(key, 'demo-marker')
  const client = await import('./client')
  const pendingToken = Promise.withResolvers<string>()
  const tokenStarted = Promise.withResolvers<void>()
  sdk.demoUser.getIdToken.mockImplementationOnce(() => {
    tokenStarted.resolve()
    return pendingToken.promise
  })
  const snapshot = client.getAuthSnapshot()
  await tokenStarted.promise

  data.delete(key)
  pendingToken.resolve('late-token')
  await expect(snapshot).rejects.toMatchObject({ code: 'configuration_error' })
  expect(sdk.getAuth).not.toHaveBeenCalled()
})

it.each(['getItem', 'setItem'] as const)(
  '終了開始時に%sが失敗したら通信を遮断したまま再試行を待つ',
  async (method) => {
    data.set(key, 'demo-marker')
    const client = await import('./client')
    const scopeClient = await import('./session-scope')
    const operation = scopeClient.beginSessionScopeOperation(
      await scopeClient.captureSessionScope(),
    )
    storage[method].mockImplementationOnce(() => {
      throw new Error('storage denied')
    })

    await expect(client.endDemoSession()).rejects.toThrow()
    expect(operation.signal.aborted).toBe(true)
    expect(sdk.signOut).not.toHaveBeenCalled()
    expect(sdk.getAuth).not.toHaveBeenCalled()
    expect(data.get(key)).toBe('demo-marker')
    await expect(client.getAuthSnapshot()).rejects.toMatchObject({ code: 'demo_exit_pending' })

    await client.endDemoSession()
    expect(sdk.signOut).toHaveBeenCalledExactlyOnceWith(sdk.demo)
    expect(data.has(key)).toBe(false)
    operation.dispose()
  },
)

it('signOut成功後に目印を削除できない場合は、目印と再試行経路を保持する', async () => {
  data.set(key, 'demo-marker')
  const client = await import('./client')
  storage.removeItem.mockImplementationOnce(() => {
    throw new Error('storage denied')
  })

  await expect(client.endDemoSession()).rejects.toThrow('storage denied')
  expect(sdk.demo.currentUser).toBeNull()
  expect(data.get(key)).toBe('exit:demo-marker')
  await expect(client.initializeAnonymousSession()).rejects.toMatchObject({
    code: 'demo_exit_pending',
  })
  expect(sdk.getAuth).not.toHaveBeenCalled()

  await client.endDemoSession()
  expect(data.has(key)).toBe(false)
})

it.each(['QuotaExceededError', 'SecurityError'])(
  '目印の書き込みだけが%sでもデモ認証を消してから終了する',
  async (name) => {
    data.set(key, 'demo-marker')
    const client = await import('./client')
    await client.getAuthSnapshot()
    storage.setItem.mockImplementationOnce(() => {
      throw new DOMException('pending marker write rejected', name)
    })
    await client.endDemoSession()
    expect(sdk.signOut).toHaveBeenCalledExactlyOnceWith(sdk.demo)
    expect(sdk.demo.currentUser).toBeNull()
    expect(data.has(key)).toBe(false)
    expect(sdk.getAuth).not.toHaveBeenCalled()
    vi.resetModules()
    const next = await import('./client')
    await expect(next.getAuthSnapshot()).resolves.toMatchObject({ uid: 'anonymous' })
    expect(sdk.demo.currentUser).toBeNull()
  },
)

it('目印の書き込みとsignOutが両方失敗したら元の目印を残し、再試行できる', async () => {
  data.set(key, 'demo-marker')
  const client = await import('./client')
  await client.getAuthSnapshot()
  storage.setItem.mockImplementationOnce(() => {
    throw new DOMException('pending marker write rejected', 'QuotaExceededError')
  })
  sdk.signOut.mockRejectedValueOnce(new Error('signOut failed'))
  await expect(client.endDemoSession()).rejects.toThrow('signOut failed')
  expect(data.get(key)).toBe('demo-marker')
  expect(storage.removeItem).not.toHaveBeenCalled()
  await expect(client.getAuthSnapshot()).rejects.toMatchObject({ code: 'demo_exit_pending' })
  expect(sdk.getAuth).not.toHaveBeenCalled()

  vi.resetModules()
  const restored = await import('./client')
  // 終了待ちを永続化できなかった場合も、通常Authへは切り替わらない。
  await expect(restored.getAuthSnapshot()).resolves.toMatchObject({ uid: 'shared-demo' })
  expect(sdk.getAuth).not.toHaveBeenCalled()
  await restored.endDemoSession()
  expect(sdk.signOut).toHaveBeenCalledTimes(2)
  expect(sdk.demo.currentUser).toBeNull()
  expect(data.has(key)).toBe(false)
})

it('目印を読めない文書を通常匿名認証として開かない', async () => {
  storage.getItem.mockImplementationOnce(() => {
    throw new Error('storage denied')
  })
  const client = await import('./client')
  await expect(client.initializeAnonymousSession()).rejects.toMatchObject({
    code: 'configuration_error',
  })
  expect(sdk.getAuth).not.toHaveBeenCalled()
  expect(sdk.initializeAuth).not.toHaveBeenCalled()
})

it('アクセス券の交換画面ではデモの目印があっても終了を開始しない', async () => {
  data.set(key, 'demo-marker')
  location.pathname = '/access'
  const client = await import('./client')

  await expect(client.endDemoSession()).rejects.toThrow()
  expect(data.get(key)).toBe('demo-marker')
  expect(sdk.signOut).not.toHaveBeenCalled()
  expect(sdk.initializeAuth).not.toHaveBeenCalled()
})
