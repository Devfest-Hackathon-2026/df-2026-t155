import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScopedValue, SessionScope } from './session-scope'

type FakeUser = {
  uid: string
  isAnonymous: boolean
  getIdToken: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as FakeUser | null, authStateReady: vi.fn() },
  signIn: vi.fn(),
  reload: vi.fn(),
  observe: vi.fn(),
  getAuth: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('../firebase/client', () => ({ getClientAuth: mocks.getAuth }))
vi.mock('firebase/auth', () => ({
  signInAnonymously: mocks.signIn,
  onIdTokenChanged: mocks.observe,
  reload: mocks.reload,
}))

// ユーザーごとに別のトークンを返す。トークンの取り違えを検出できるようにする。
function userWith(uid: string): FakeUser {
  return {
    uid,
    isAnonymous: true,
    getIdToken: vi.fn().mockResolvedValue(`test-only-token-of-${uid}`),
  }
}

// 画面の保存操作を模した送信。ヘッダーを作れたときだけ通信する。
async function send(
  scope: SessionScope,
  getAuthHeadersForScope: (scope: SessionScope) => Promise<Headers>,
) {
  const headers = await getAuthHeadersForScope(scope)
  await mocks.fetch('/api/save', { method: 'POST', headers })
}

function fetchedTokens(): string {
  return JSON.stringify(
    mocks.fetch.mock.calls.map(([, init]) => {
      const headers = init?.headers
      return headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers
    }),
  )
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.auth.currentUser = userWith('user-a')
  mocks.auth.authStateReady.mockResolvedValue(undefined)
  mocks.getAuth.mockReturnValue(mocks.auth)
  mocks.reload.mockResolvedValue(undefined)
  mocks.fetch.mockResolvedValue({ ok: true })
})

describe('getAuthSnapshot（UIDとトークンを同じUserから取る）', () => {
  it('UIDとトークンを同じUserの組で返し、強制更新はしない', async () => {
    const user = userWith('user-a')
    mocks.auth.currentUser = user
    const { getAuthSnapshot } = await import('./client')
    await expect(getAuthSnapshot()).resolves.toEqual({
      uid: 'user-a',
      token: 'test-only-token-of-user-a',
      generation: 0,
    })
    expect(user.getIdToken).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('別のユーザーに替わった後は、そのユーザーのUIDとトークンの組を返す', async () => {
    const { getAuthSnapshot } = await import('./client')
    await getAuthSnapshot()
    mocks.auth.currentUser = userWith('user-b')
    await expect(getAuthSnapshot()).resolves.toEqual({
      uid: 'user-b',
      token: 'test-only-token-of-user-b',
      generation: 1,
    })
  })

  it('取得中に別ユーザーへ替わったら、Aのトークンも組も返さず失敗する', async () => {
    const a = userWith('user-a')
    const pending = Promise.withResolvers<string>()
    const begun = Promise.withResolvers<void>()
    a.getIdToken.mockImplementationOnce(() => {
      begun.resolve()
      return pending.promise
    })
    mocks.auth.currentUser = a
    const { getAuthSnapshot } = await import('./client')
    const snapshot = getAuthSnapshot()
    await begun.promise
    mocks.auth.currentUser = userWith('user-b')
    pending.resolve('test-only-token-of-user-a')
    await expect(snapshot).rejects.toMatchObject({ code: 'session_ended' })
  })

  it.each(['別のUserオブジェクト', 'サインアウト'])(
    '取得中に%sへ替わったら失敗する（同じUIDでも世代が違えば返さない）',
    async (kind) => {
      const a = userWith('user-a')
      const pending = Promise.withResolvers<string>()
      const begun = Promise.withResolvers<void>()
      a.getIdToken.mockImplementationOnce(() => {
        begun.resolve()
        return pending.promise
      })
      mocks.auth.currentUser = a
      const { getAuthSnapshot } = await import('./client')
      const snapshot = getAuthSnapshot()
      await begun.promise
      mocks.auth.currentUser = kind === 'サインアウト' ? null : userWith('user-a')
      pending.resolve('test-only-token-of-user-a')
      await expect(snapshot).rejects.toMatchObject({ code: 'session_ended' })
    },
  )

  it('getIdTokenは従来どおりトークンだけを返し、強制更新をSDKへ渡す', async () => {
    const user = userWith('user-a')
    mocks.auth.currentUser = user
    const { getIdToken, getAuthHeaders } = await import('./client')
    await expect(getIdToken(true)).resolves.toBe('test-only-token-of-user-a')
    expect(user.getIdToken).toHaveBeenLastCalledWith(true)
    const headers = await getAuthHeaders()
    expect(headers.get('authorization')).toBe('Bearer test-only-token-of-user-a')
  })

  it.each([
    ['セッション終了（サインアウト済み）', undefined, 'session_ended'],
    ['トークン失効', { code: 'auth/user-token-expired' }, 'session_ended'],
    ['通信失敗', { code: 'auth/network-request-failed' }, 'unavailable'],
  ])('%sでは失敗し、匿名アカウントを自動作成しない', async (_name, failure, code) => {
    mocks.auth.currentUser = failure ? userWith('user-a') : null
    if (failure) mocks.auth.currentUser?.getIdToken.mockRejectedValue(failure)
    const { getAuthSnapshot } = await import('./client')
    await expect(getAuthSnapshot()).rejects.toMatchObject({ code })
    expect(mocks.signIn).not.toHaveBeenCalled()
  })
})

describe('captureSessionScope', () => {
  it('現在のUIDだけを持つ不変のスコープを返す', async () => {
    const { captureSessionScope } = await import('./session-scope')
    const scope = await captureSessionScope()
    expect(scope).toEqual({ uid: 'user-a' })
    expect(Object.isFrozen(scope)).toBe(true)
    // トークンをスコープに含めない（スコープは画面の状態に残るため）。
    expect(JSON.stringify(scope)).not.toContain('test-only-token')
  })

  it('セッションがなければ失敗し、匿名アカウントを自動作成しない', async () => {
    mocks.auth.currentUser = null
    const { captureSessionScope } = await import('./session-scope')
    await expect(captureSessionScope()).rejects.toMatchObject({ code: 'session_ended' })
    expect(mocks.signIn).not.toHaveBeenCalled()
  })
})

describe('getAuthHeadersForScope（スコープが違えば閉じて失敗する）', () => {
  it('同じセッションならAuthorizationヘッダーだけを返す', async () => {
    const { captureSessionScope, getAuthHeadersForScope } = await import('./session-scope')
    const scope = await captureSessionScope()
    const headers = await getAuthHeadersForScope(scope)
    expect(headers.get('authorization')).toBe('Bearer test-only-token-of-user-a')
    expect(Array.from(headers.keys())).toEqual(['authorization'])
  })

  it('同じUserのトークン更新では同じスコープを維持する', async () => {
    const { captureSessionScope, getAuthHeadersForScope } = await import('./session-scope')
    const scope = await captureSessionScope()
    const user = mocks.auth.currentUser as FakeUser
    user.getIdToken.mockResolvedValueOnce('refreshed-token-of-user-a')
    const headers = await getAuthHeadersForScope(scope)
    expect(headers.get('authorization')).toBe('Bearer refreshed-token-of-user-a')
  })

  it.each([
    [
      'A→B→A',
      () => {
        mocks.auth.currentUser = userWith('user-b')
        mocks.auth.currentUser = userWith('user-a')
      },
    ],
    [
      'A→終了→A',
      () => {
        mocks.auth.currentUser = null
        mocks.auth.currentUser = userWith('user-a')
      },
    ],
  ])('%sでも、先のAスコープからヘッダーを作らない', async (_name, switchBack) => {
    const { captureSessionScope, getAuthHeadersForScope } = await import('./session-scope')
    const scope = await captureSessionScope()
    switchBack()
    await expect(getAuthHeadersForScope(scope)).rejects.toMatchObject({ code: 'session_changed' })
  })

  it('取得中にA→B→Aへ戻った遅延応答を採用しない', async () => {
    const { captureSessionScope, getAuthHeadersForScope, assertCurrentSessionScope } =
      await import('./session-scope')
    const scope = await captureSessionScope()
    const response = Promise.withResolvers<{ ok: true }>()
    const begun = Promise.withResolvers<void>()
    mocks.fetch.mockImplementationOnce(async () => {
      begun.resolve()
      return response.promise
    })
    const loading = (async () => {
      const headers = await getAuthHeadersForScope(scope)
      await mocks.fetch('/api/trips', { method: 'GET', headers })
      await assertCurrentSessionScope(scope)
    })()
    await begun.promise
    mocks.auth.currentUser = userWith('user-b')
    mocks.auth.currentUser = userWith('user-a')
    response.resolve({ ok: true })
    await expect(loading).rejects.toMatchObject({ code: 'session_changed' })
  })

  it('POST応答後にセッションが変わった場合、結果不明として拒否する', async () => {
    const { captureSessionScope, getAuthHeadersForScope, assertCurrentSessionScope } =
      await import('./session-scope')
    const scope = await captureSessionScope()
    const response = Promise.withResolvers<{ ok: true }>()
    const begun = Promise.withResolvers<void>()
    mocks.fetch.mockImplementationOnce(async () => {
      begun.resolve()
      return response.promise
    })
    const saving = (async () => {
      const headers = await getAuthHeadersForScope(scope)
      await mocks.fetch('/api/save', { method: 'POST', headers })
      await assertCurrentSessionScope(scope, 'unknown')
    })()
    await begun.promise
    mocks.auth.currentUser = userWith('user-b')
    response.resolve({ ok: true })
    await expect(saving).rejects.toMatchObject({
      code: 'session_changed',
      outcome: 'unknown',
    })
  })

  it('UIDが変わったらSessionChangedErrorで失敗し、新しいUIDのトークンを送らない', async () => {
    const { captureSessionScope, getAuthHeadersForScope, SessionChangedError } =
      await import('./session-scope')
    const scopeOfA = await captureSessionScope()
    const b = userWith('user-b')
    mocks.auth.currentUser = b

    const failure = await send(scopeOfA, getAuthHeadersForScope).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SessionChangedError)
    expect(failure).toMatchObject({ code: 'session_changed' })
    // 通信は一度も行われず、Bのトークンはどこにも渡らない。
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(fetchedTokens()).not.toContain('test-only-token-of-user-b')
    expect(String((failure as Error).message)).not.toContain('test-only-token-of-user-b')
  })

  it('ヘッダー取得中にBへ替わったら、Aのトークンでも送らず失敗する', async () => {
    const { captureSessionScope, getAuthHeadersForScope } = await import('./session-scope')
    const scopeOfA = await captureSessionScope()
    const a = mocks.auth.currentUser as FakeUser
    const pending = Promise.withResolvers<string>()
    const begun = Promise.withResolvers<void>()
    a.getIdToken.mockImplementationOnce(() => {
      begun.resolve()
      return pending.promise
    })
    const sending = send(scopeOfA, getAuthHeadersForScope)
    await begun.promise
    mocks.auth.currentUser = userWith('user-b')
    pending.resolve('test-only-token-of-user-a')

    await expect(sending).rejects.toMatchObject({ code: 'session_ended' })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['セッション終了', 'session_ended', undefined],
    ['トークン失効', 'session_ended', { code: 'auth/user-token-expired' }],
    ['通信失敗', 'unavailable', { code: 'auth/network-request-failed' }],
  ])('%sではヘッダーを作らず、匿名アカウントを自動作成しない', async (_n, code, failure) => {
    const { captureSessionScope, getAuthHeadersForScope } = await import('./session-scope')
    const scope = await captureSessionScope()
    mocks.auth.currentUser = failure ? userWith('user-a') : null
    if (failure) mocks.auth.currentUser?.getIdToken.mockRejectedValue(failure)
    await expect(send(scope, getAuthHeadersForScope)).rejects.toMatchObject({ code })
    expect(mocks.signIn).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

describe('isSameScope / assertSameScope（取得したデータを別UIDで使わない）', () => {
  // 同じID・同じversionで本文だけが違う、AとBそれぞれのデータ。
  const trip = { id: 'trip-1', version: 3 }
  const scopeOfA: SessionScope = { uid: 'user-a' }
  const scopeOfB: SessionScope = { uid: 'user-b' }
  const dataOfA: ScopedValue<typeof trip & { body: string }> = {
    scope: scopeOfA,
    value: { ...trip, body: 'Aだけの本文' },
  }
  const dataOfB: ScopedValue<typeof trip & { body: string }> = {
    scope: scopeOfB,
    value: { ...trip, body: 'Bだけの本文' },
  }

  it('UIDが同じなら別の値でも同じスコープ、違えば別のスコープ', async () => {
    const { isSameScope } = await import('./session-scope')
    expect(isSameScope(scopeOfA, { uid: 'user-a' })).toBe(true)
    expect(isSameScope(scopeOfA, scopeOfB)).toBe(false)
  })

  it('取得時と同じスコープなら通し、違えばSessionChangedErrorで失敗する', async () => {
    const { assertSameScope, SessionChangedError } = await import('./session-scope')
    expect(() => assertSameScope(dataOfA, scopeOfA)).not.toThrow()
    expect(() => assertSameScope(dataOfB, scopeOfB)).not.toThrow()
    expect(() => assertSameScope(dataOfA, scopeOfB)).toThrow(SessionChangedError)
    expect(() => assertSameScope(dataOfB, scopeOfA)).toThrow(
      expect.objectContaining({ code: 'session_changed' }),
    )
  })

  it('IDとversionが同じでも本文が違うAとBを取り違えない', async () => {
    const { assertSameScope } = await import('./session-scope')
    expect(dataOfA.value.id).toBe(dataOfB.value.id)
    expect(dataOfA.value.version).toBe(dataOfB.value.version)
    // 現在のスコープがBのとき、Aのデータは使えず、Bのデータだけが通る。
    const usable = [dataOfA, dataOfB].filter((scoped) => {
      try {
        assertSameScope(scoped, scopeOfB)
        return true
      } catch {
        return false
      }
    })
    expect(usable.map((scoped) => scoped.value.body)).toEqual(['Bだけの本文'])
  })

  it('SessionChangedErrorはcodeとErrorの性質を持つ', async () => {
    const { SessionChangedError } = await import('./session-scope')
    const error = new SessionChangedError()
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('session_changed')
    expect(error.name).toBe('SessionChangedError')
  })
})
