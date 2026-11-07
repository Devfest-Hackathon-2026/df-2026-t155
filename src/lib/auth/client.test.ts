import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthState } from './client'

const mocks = vi.hoisted(() => {
  const token = vi.fn()
  const user = { uid: 'restored-user', isAnonymous: true, getIdToken: token }
  const auth: { currentUser: typeof user | null; authStateReady: ReturnType<typeof vi.fn> } = {
    currentUser: user,
    authStateReady: vi.fn(),
  }
  return {
    auth,
    user,
    token,
    signIn: vi.fn(),
    reload: vi.fn(),
    observe: vi.fn(),
    getAuth: vi.fn(),
  }
})

function userWithUid(uid: string) {
  return { uid, isAnonymous: true, getIdToken: vi.fn().mockResolvedValue('test-only-token') }
}

function watchSession(client: typeof import('./client')) {
  const waiting = new Map<string, () => void>()
  const listener = vi.fn((state: AuthState) => {
    if (state.status === 'authenticated') waiting.get(state.user.uid)?.()
  })
  const stop = client.observeAuthState(listener)
  const onUser = mocks.observe.mock.calls.at(-1)?.[1]
  if (typeof onUser !== 'function') throw new Error('SDK購読が登録されていません')
  return {
    listener,
    stop,
    waitFor(uid: string) {
      const ready = Promise.withResolvers<void>()
      waiting.set(uid, ready.resolve)
      return ready.promise
    },
    emit(user: typeof mocks.user | null) {
      mocks.auth.currentUser = user
      onUser(user)
    },
  }
}

async function beginOtherSession(
  client: typeof import('./client'),
  watch: ReturnType<typeof watchSession>,
  user = userWithUid('user-b'),
) {
  watch.emit(null)
  const authenticated = watch.waitFor(user.uid)
  mocks.signIn.mockImplementationOnce(async () => {
    watch.emit(user)
    return { user }
  })
  await client.startNewAnonymousSession()
  await authenticated
  return user
}

describe('セッション切替と遅延Promiseの競合（SDKモック・完了順序を明示制御）', () => {
  it.each(['resolve', 'reject'])(
    'Aのトークンが遅れて%sしてもBの通知と検証状態を保持する',
    async (result) => {
      const client = await import('./client')
      const watch = watchSession(client)
      try {
        const aReady = watch.waitFor(mocks.user.uid)
        watch.emit(mocks.user)
        await aReady
        const pending = Promise.withResolvers<string>()
        const begun = Promise.withResolvers<void>()
        mocks.token.mockImplementationOnce(() => {
          begun.resolve()
          return pending.promise
        })
        const old = client.getIdToken(true)
        await begun.promise
        const b = await beginOtherSession(client, watch)
        const count = watch.listener.mock.calls.length
        if (result === 'resolve') pending.resolve('test-only-old-token')
        else pending.reject({ code: 'auth/network-request-failed' })
        await expect(old).rejects.toMatchObject({
          code: result === 'resolve' ? 'session_ended' : 'unavailable',
        })
        expect(watch.listener).toHaveBeenCalledTimes(count)
        expect(watch.listener).toHaveBeenLastCalledWith({
          status: 'authenticated',
          user: { uid: b.uid, isAnonymous: true },
        })
        const reloads = mocks.reload.mock.calls.length
        watch.emit(b)
        expect(mocks.reload).toHaveBeenCalledTimes(reloads)
        // 古いエラーの抑止後も、現在のBの正当なエラーは通知する。
        b.getIdToken.mockRejectedValueOnce({ code: 'auth/network-request-failed' })
        await expect(client.getIdToken(true)).rejects.toMatchObject({ code: 'unavailable' })
        expect(watch.listener).toHaveBeenLastCalledWith({
          status: 'error',
          error: expect.objectContaining({ code: 'unavailable' }),
        })
      } finally {
        watch.stop()
      }
    },
  )

  it.each(['new-user-object', 'same-user-object'])(
    '同じUIDでもサインアウト後の別世代へ通知しない: %s',
    async (kind) => {
      const client = await import('./client')
      const watch = watchSession(client)
      try {
        const aReady = watch.waitFor(mocks.user.uid)
        watch.emit(mocks.user)
        await aReady
        const pending = Promise.withResolvers<string>()
        const begun = Promise.withResolvers<void>()
        mocks.token.mockImplementationOnce(() => {
          begun.resolve()
          return pending.promise
        })
        const old = client.getIdToken(true)
        await begun.promise
        const next = kind === 'same-user-object' ? mocks.user : userWithUid(mocks.user.uid)
        await beginOtherSession(client, watch, next)
        const count = watch.listener.mock.calls.length
        pending.resolve('test-only-old-token')
        await expect(old).rejects.toMatchObject({ code: 'session_ended' })
        expect(watch.listener).toHaveBeenCalledTimes(count)
        expect(watch.listener.mock.calls.at(-1)?.[0].status).toBe('authenticated')
      } finally {
        watch.stop()
      }
    },
  )

  describe.each(['initializeAnonymousSession', 'startNewAnonymousSession'] as const)(
    '%sの遅延検証',
    (method) => {
      it.each(['resolve', 'reject'])(
        'Aの検証が遅れて%sしても、明示開始したBを保持する',
        async (result) => {
          const client = await import('./client')
          const watch = watchSession(client)
          try {
            const aReady = watch.waitFor(mocks.user.uid)
            watch.emit(mocks.user)
            await aReady
            const pending = Promise.withResolvers<void>()
            const begun = Promise.withResolvers<void>()
            mocks.reload.mockImplementationOnce(() => {
              begun.resolve()
              return pending.promise
            })
            const old = client[method]()
            await begun.promise
            const b = await beginOtherSession(client, watch)
            const count = watch.listener.mock.calls.length
            if (result === 'resolve') pending.resolve()
            else pending.reject({ code: 'auth/network-request-failed' })
            await expect(old).rejects.toMatchObject({
              code: result === 'resolve' ? 'session_ended' : 'unavailable',
            })
            expect(watch.listener).toHaveBeenCalledTimes(count)
            expect(watch.listener).toHaveBeenLastCalledWith({
              status: 'authenticated',
              user: { uid: b.uid, isAnonymous: true },
            })
          } finally {
            watch.stop()
          }
        },
      )
    },
  )

  describe.each(['initializeAnonymousSession', 'startNewAnonymousSession', 'getIdToken'] as const)(
    '%sの復元待機',
    (method) => {
      it.each(['resolve', 'reject'])(
        'AのauthStateReadyが遅れて%sしてもBへ通知しない',
        async (result) => {
          const client = await import('./client')
          const watch = watchSession(client)
          try {
            const aReady = watch.waitFor(mocks.user.uid)
            watch.emit(mocks.user)
            await aReady
            const pending = Promise.withResolvers<void>()
            const begun = Promise.withResolvers<void>()
            mocks.auth.authStateReady.mockImplementationOnce(() => {
              begun.resolve()
              return pending.promise
            })
            const old = client[method]()
            await begun.promise
            await beginOtherSession(client, watch)
            const count = watch.listener.mock.calls.length
            if (result === 'resolve') pending.resolve()
            else pending.reject({ code: 'auth/network-request-failed' })
            await expect(old).rejects.toMatchObject({
              code: result === 'resolve' ? 'session_ended' : 'unavailable',
            })
            expect(watch.listener).toHaveBeenCalledTimes(count)
            expect(watch.listener.mock.calls.at(-1)?.[0].status).toBe('authenticated')
          } finally {
            watch.stop()
          }
        },
      )
    },
  )

  it.each(['resolve', 'reject'])(
    'Aのサインイン応答が遅れて%sしてもBへ通知しない',
    async (result) => {
      mocks.auth.currentUser = null
      const client = await import('./client')
      const watch = watchSession(client)
      try {
        watch.emit(null)
        const pending = Promise.withResolvers<{ user: typeof mocks.user }>()
        const begun = Promise.withResolvers<void>()
        mocks.signIn.mockImplementationOnce(() => {
          begun.resolve()
          return pending.promise
        })
        const old = client.startNewAnonymousSession()
        await begun.promise
        const b = userWithUid('user-b')
        const ready = watch.waitFor(b.uid)
        watch.emit(b)
        await ready
        const count = watch.listener.mock.calls.length
        if (result === 'resolve') pending.resolve({ user: mocks.user })
        else pending.reject({ code: 'auth/network-request-failed' })
        await expect(old).rejects.toMatchObject({
          code: result === 'resolve' ? 'session_ended' : 'unavailable',
        })
        expect(watch.listener).toHaveBeenCalledTimes(count)
        expect(mocks.auth.currentUser).toBe(b)
      } finally {
        watch.stop()
      }
    },
  )

  it.each(['resolve', 'reject'])(
    '購読からの古いAの検証が%sしてもBの状態を保持する',
    async (result) => {
      const client = await import('./client')
      const watch = watchSession(client)
      try {
        const pending = Promise.withResolvers<void>()
        const begun = Promise.withResolvers<void>()
        mocks.reload.mockImplementationOnce(() => {
          begun.resolve()
          return pending.promise
        })
        watch.emit(mocks.user)
        await begun.promise
        const b = await beginOtherSession(client, watch)
        // 古い購読検証と同じPromiseを待ち、完了の観測を決定的にする。
        // 旧セッションの初期化を開始してはいけないため、reloadの戻り値を待つ。
        const count = watch.listener.mock.calls.length
        if (result === 'resolve') pending.resolve()
        else pending.reject({ code: 'auth/network-request-failed' })
        await pending.promise.catch(() => undefined)
        await client.initializeAnonymousSession()
        expect(
          watch.listener.mock.calls
            .slice(count)
            .every(([state]) => state.status === 'authenticated' && state.user.uid === b.uid),
        ).toBe(true)
      } finally {
        watch.stop()
      }
    },
  )
})

vi.mock('../firebase/client', () => ({ getClientAuth: mocks.getAuth }))
vi.mock('firebase/auth', () => ({
  signInAnonymously: mocks.signIn,
  onIdTokenChanged: mocks.observe,
  reload: mocks.reload,
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.auth.currentUser = mocks.user
  mocks.user.isAnonymous = true
  mocks.auth.authStateReady.mockResolvedValue(undefined)
  mocks.getAuth.mockReturnValue(mocks.auth)
  mocks.token.mockResolvedValue('test-only-token')
  mocks.reload.mockResolvedValue(undefined)
  mocks.signIn.mockImplementation(async () => {
    mocks.auth.currentUser = mocks.user
    return { user: mocks.user }
  })
})

describe('クライアント認証（SDKモック）', () => {
  it('復元を待ち、既存の匿名ユーザーを再作成しない', async () => {
    const { initializeAnonymousSession } = await import('./client')
    await expect(initializeAnonymousSession()).resolves.toEqual({
      uid: 'restored-user',
      isAnonymous: true,
    })
    expect(mocks.auth.authStateReady).toHaveBeenCalledOnce()
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('初回でも復元失敗・状態消失でも、自動で匿名認証しない', async () => {
    mocks.auth.currentUser = null
    const { initializeAnonymousSession } = await import('./client')
    await expect(initializeAnonymousSession()).rejects.toMatchObject({ code: 'session_ended' })
    await expect(initializeAnonymousSession()).rejects.toMatchObject({ code: 'session_ended' })
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('明示的な開始でも復元完了を待ち、同時要求では一度だけ作成する', async () => {
    let finishRestoration: (() => void) | undefined
    mocks.auth.currentUser = null
    mocks.auth.authStateReady.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRestoration = resolve
      }),
    )
    const { initializeAnonymousSession, startNewAnonymousSession } = await import('./client')
    const first = startNewAnonymousSession()
    const second = startNewAnonymousSession()
    expect(first).toBe(second)
    expect(initializeAnonymousSession()).toBe(first)
    expect(mocks.signIn).not.toHaveBeenCalled()
    finishRestoration?.()
    await first
    expect(mocks.signIn).toHaveBeenCalledOnce()
  })

  it('将来リンクしたGoogle等のユーザーも保持する', async () => {
    mocks.user.isAnonymous = false
    const { initializeAnonymousSession } = await import('./client')
    await expect(initializeAnonymousSession()).resolves.toMatchObject({ isAnonymous: false })
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('明示的な開始も正常な既存ユーザーを置き換えない', async () => {
    const { startNewAnonymousSession } = await import('./client')
    await expect(startNewAnonymousSession()).resolves.toMatchObject({ uid: 'restored-user' })
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('認証失敗後は初期化で再作成せず、次の明示的な開始だけを許す', async () => {
    mocks.auth.currentUser = null
    mocks.signIn.mockRejectedValueOnce({ code: 'auth/network-request-failed', message: 'private' })
    const { initializeAnonymousSession, startNewAnonymousSession } = await import('./client')
    await expect(startNewAnonymousSession()).rejects.toMatchObject({ code: 'unavailable' })
    await expect(initializeAnonymousSession()).rejects.toMatchObject({ code: 'session_ended' })
    expect(mocks.signIn).toHaveBeenCalledOnce()
    await expect(startNewAnonymousSession()).resolves.toMatchObject({ uid: 'restored-user' })
    expect(mocks.signIn).toHaveBeenCalledTimes(2)
  })

  it('復元・検証Promiseの通信失敗を成功扱いせず、匿名認証へフォールバックしない', async () => {
    const { initializeAnonymousSession } = await import('./client')
    mocks.auth.authStateReady.mockRejectedValueOnce({ code: 'auth/network-request-failed' })
    await expect(initializeAnonymousSession()).rejects.toMatchObject({ code: 'unavailable' })
    mocks.reload.mockRejectedValueOnce({ code: 'auth/network-request-failed' })
    await expect(initializeAnonymousSession()).rejects.toMatchObject({ code: 'unavailable' })
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('ストレージの履歴を推測せず、利用不能でも初期化から新規作成しない', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() }
    storage.getItem.mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    storage.setItem.mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    vi.stubGlobal('localStorage', storage)
    try {
      mocks.auth.currentUser = null
      const { initializeAnonymousSession } = await import('./client')
      await expect(initializeAnonymousSession()).rejects.toMatchObject({ code: 'session_ended' })
      expect(storage.getItem).not.toHaveBeenCalled()
      expect(storage.setItem).not.toHaveBeenCalled()
      expect(mocks.signIn).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('IDトークン取得と明示更新をSDKへ委ねる', async () => {
    const { getIdToken, getAuthHeaders } = await import('./client')
    await getIdToken(true)
    expect(mocks.token).toHaveBeenCalledWith(true)
    const headers = await getAuthHeaders()
    expect(headers.has('authorization')).toBe(true)
    expect(Array.from(headers.keys())).toEqual(['authorization'])
  })

  it('未認証・失効時に匿名アカウントを作り直さない', async () => {
    const { getIdToken } = await import('./client')
    mocks.auth.currentUser = null
    await expect(getIdToken()).rejects.toMatchObject({ code: 'session_ended' })
    mocks.auth.currentUser = mocks.user
    mocks.token.mockRejectedValue({ code: 'auth/user-token-expired', message: 'private' })
    await expect(getIdToken()).rejects.toMatchObject({ code: 'session_ended' })
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('取得中に利用者が変わったトークンを返さない', async () => {
    mocks.token.mockImplementation(async () => {
      mocks.auth.currentUser = null
      return 'test-only-token'
    })
    const { getIdToken } = await import('./client')
    await expect(getIdToken()).rejects.toMatchObject({ code: 'session_ended' })
  })

  it('実在するユーザー更新イベントだけを購読し、検証後に成功を通知する', async () => {
    const unsubscribe = vi.fn()
    mocks.observe.mockReturnValue(unsubscribe)
    const listener = vi.fn()
    const { observeAuthState } = await import('./client')
    const stop = observeAuthState(listener)
    expect(listener).toHaveBeenCalledWith({ status: 'restoring' })
    expect(mocks.observe.mock.calls[0]).toHaveLength(2)
    const [, onUser] = mocks.observe.mock.calls[0]
    onUser(mocks.user)
    await vi.waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith({
        status: 'authenticated',
        user: { uid: 'restored-user', isAnonymous: true },
      })
    })
    mocks.auth.currentUser = null
    onUser(null)
    expect(listener).toHaveBeenLastCalledWith({
      status: 'session_ended',
      error: expect.objectContaining({ code: 'session_ended' }),
    })
    expect(mocks.signIn).not.toHaveBeenCalled()
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('購読中の検証Promise失敗を通知し、認証成功は通知しない', async () => {
    mocks.reload.mockRejectedValue({ code: 'auth/network-request-failed', message: 'private' })
    const listener = vi.fn()
    const { observeAuthState } = await import('./client')
    const stop = observeAuthState(listener)
    const [, onUser] = mocks.observe.mock.calls[0]
    onUser(mocks.user)
    await vi.waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith({
        status: 'error',
        error: expect.objectContaining({ code: 'unavailable' }),
      })
    })
    expect(listener.mock.calls.some(([state]) => state.status === 'authenticated')).toBe(false)
    stop()
  })

  it('別タブ等のサインアウトが先に届いたら、古い検証結果を通知しない', async () => {
    const pending = Promise.withResolvers<void>()
    mocks.reload.mockReturnValue(pending.promise)
    const listener = vi.fn()
    const { observeAuthState } = await import('./client')
    const stop = observeAuthState(listener)
    const [, onUser] = mocks.observe.mock.calls[0]
    onUser(mocks.user)
    mocks.auth.currentUser = null
    onUser(null)
    pending.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listener.mock.calls.some(([state]) => state.status === 'authenticated')).toBe(false)
    expect(mocks.signIn).not.toHaveBeenCalled()
    stop()
  })

  it('トークン取得Promiseの失敗を通知し、古い検証成功で上書きしない', async () => {
    const pending = Promise.withResolvers<void>()
    mocks.reload.mockReturnValue(pending.promise)
    mocks.token.mockRejectedValue({ code: 'auth/network-request-failed' })
    const listener = vi.fn()
    const { getIdToken, observeAuthState } = await import('./client')
    const stop = observeAuthState(listener)
    const [, onUser] = mocks.observe.mock.calls[0]
    onUser(mocks.user)
    await expect(getIdToken()).rejects.toMatchObject({ code: 'unavailable' })
    pending.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listener).toHaveBeenLastCalledWith({
      status: 'error',
      error: expect.objectContaining({ code: 'unavailable' }),
    })
    expect(listener.mock.calls.some(([state]) => state.status === 'authenticated')).toBe(false)
    stop()
  })

  it('reloadが発行する更新イベントから検証を繰り返さない', async () => {
    const listener = vi.fn()
    const { observeAuthState } = await import('./client')
    const stop = observeAuthState(listener)
    const [, onUser] = mocks.observe.mock.calls[0]
    onUser(mocks.user)
    await vi.waitFor(() => {
      expect(listener.mock.calls.at(-1)?.[0].status).toBe('authenticated')
    })
    onUser(mocks.user)
    expect(mocks.reload).toHaveBeenCalledOnce()
    expect(listener.mock.calls.at(-1)?.[0].status).toBe('authenticated')
    stop()
  })

  it('購読解除後の検証結果は通知しない', async () => {
    const pending = Promise.withResolvers<void>()
    mocks.reload.mockReturnValue(pending.promise)
    const listener = vi.fn()
    const { observeAuthState } = await import('./client')
    const stop = observeAuthState(listener)
    mocks.observe.mock.calls[0][1](mocks.user)
    stop()
    const count = listener.mock.calls.length
    mocks.observe.mock.calls[0][1](mocks.user)
    mocks.observe.mock.calls[0][1](null)
    pending.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listener).toHaveBeenCalledTimes(count)
  })

  it('SDK初期化の失敗も購読側へ安全に通知する', async () => {
    mocks.getAuth.mockImplementation(() => {
      throw new Error('private-config')
    })
    const listener = vi.fn()
    const { observeAuthState } = await import('./client')
    const unsubscribe = observeAuthState(listener)
    expect(() => unsubscribe()).not.toThrow()
    expect(listener).toHaveBeenLastCalledWith({
      status: 'error',
      error: expect.objectContaining({ code: 'sign_in_failed' }),
    })
  })
})
