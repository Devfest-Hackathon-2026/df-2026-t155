import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleLearning, sampleTrip } from '@/domain/samples'

const { standardAuth, demoAuth, initializeAuth, setPersistence, signOut } = vi.hoisted(() => {
  const user = (uid: string, isAnonymous: boolean) => ({
    uid,
    isAnonymous,
    getIdToken: vi.fn().mockResolvedValue(`token-of-${uid}`),
  })
  return {
    standardAuth: {
      currentUser: user('anonymous', true),
      authStateReady: vi.fn().mockResolvedValue(undefined),
    },
    demoAuth: {
      currentUser: user('shared-demo', false),
      authStateReady: vi.fn().mockResolvedValue(undefined),
    },
    initializeAuth: vi.fn(),
    setPersistence: vi.fn(),
    signOut: vi.fn(),
  }
})
vi.mock('firebase/app', () => ({ getApps: () => [], initializeApp: vi.fn() }))
vi.mock('firebase/auth', () => ({
  getAuth: () => standardAuth,
  initializeAuth,
  setPersistence,
  signOut,
  browserSessionPersistence: {},
}))

const reload = vi.fn()
const documentElement = { hidden: false }
let tab: EventTarget

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  reload.mockClear()
  documentElement.hidden = false
  initializeAuth.mockReturnValue(demoAuth)
  const session = new Map()
  tab = Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: session.set.bind(session),
      removeItem: session.delete.bind(session),
    },
    location: { pathname: '/', reload },
  })
  vi.stubGlobal('window', tab)
  vi.stubGlobal('document', { documentElement })
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'demo-groundtrip')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_API_KEY', 'test-key')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'example.com')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_ID', 'test-app')
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_USE_EMULATORS', 'false')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function event(type: 'pagehide' | 'pageshow', persisted: boolean) {
  tab.dispatchEvent(Object.assign(new Event(type), { persisted }))
}

describe('認証画面のBFCache復元', () => {
  it('匿名認証が同じまま戻ったら、再読込せず既存画面を再表示する', async () => {
    const client = await import('./client')
    const { captureSessionScope, beginSessionScopeOperation } =
      await import('@/lib/auth/session-scope')
    expect(client.getClientAuth()).toBe(standardAuth)
    const operation = beginSessionScopeOperation(await captureSessionScope())
    event('pagehide', true)
    expect(documentElement.hidden).toBe(true)
    event('pageshow', true)

    expect(reload).not.toHaveBeenCalled()
    expect(documentElement.hidden).toBe(false)
    expect(operation.signal.aborted).toBe(false)
    expect(() => operation.assertCurrent()).not.toThrow()
    operation.dispose()
  })

  it('デモの目印とSDKのUserが同じでも、履歴から戻った文書は再読込する', async () => {
    const client = await import('./client')
    client.activateDemoSession()
    expect(client.getClientAuth()).toBe(demoAuth)
    event('pagehide', true)
    expect(() => client.getClientAuth()).toThrow()
    event('pageshow', true)

    expect(reload).toHaveBeenCalledOnce()
    expect(documentElement.hidden).toBe(true)
    expect(() => client.getClientAuth()).toThrow()
  })

  it.each(['SDK待機中', 'signOut成功後'] as const)(
    '終了の目印を更新できない場合も旧文書でBearer送信や応答採用を行わない（%s）',
    async (phase) => {
      const key = 'groundtrip-demo-session'
      const firebase = await import('./client')
      const auth = await import('@/lib/auth/client')
      const { captureSessionScope, getAuthHeadersForScope } =
        await import('@/lib/auth/session-scope')
      const { requestLearningCandidates } = await import('@/features/learning-review/api-client')
      firebase.activateDemoSession()
      const marker = window.sessionStorage.getItem(key)
      const scope = await captureSessionScope()
      const request = { trip: sampleTrip, revisions: [], feedback: '昼食後に休憩したい' }
      const headers = await getAuthHeadersForScope(scope)
      const waitingHeaders = Promise.withResolvers<Headers>()
      const waitingResponse = Promise.withResolvers<Response>()
      const fetchFn = vi.fn<typeof fetch>().mockReturnValue(waitingResponse.promise)
      const alreadySent = requestLearningCandidates(request, {
        scope,
        fetchFn,
        getHeaders: async () => headers,
      })
      const notSent = requestLearningCandidates(request, {
        scope,
        fetchFn,
        getHeaders: () => waitingHeaders.promise,
      })
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
      expect(new Headers(fetchFn.mock.calls[0][1]?.headers).get('Authorization')).toBe(
        'Bearer token-of-shared-demo',
      )
      const signal = fetchFn.mock.calls[0][1]?.signal

      const waitingToken = Promise.withResolvers<string>()
      demoAuth.currentUser.getIdToken.mockReturnValueOnce(waitingToken.promise)
      const oldToken = auth.getAuthSnapshot()
      const returnedToken = vi.fn()
      void oldToken.then(returnedToken, () => {})
      await vi.waitFor(() =>
        expect(demoAuth.currentUser.getIdToken).toHaveReturnedWith(waitingToken.promise),
      )
      event('pagehide', true)
      const abortedOnHide = signal?.aborted

      // 同じタブの別文書で終了。旧文書のFirebase Userはメモリに残ったままにする。
      const exitAuth = { ...demoAuth, currentUser: demoAuth.currentUser }
      initializeAuth.mockReturnValueOnce(exitAuth)
      vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('marker write denied', 'QuotaExceededError')
      })
      if (phase === 'signOut成功後') {
        vi.spyOn(window.sessionStorage, 'removeItem').mockImplementationOnce(() => {
          throw new DOMException('marker removal denied', 'SecurityError')
        })
      }
      const sdkDone = Promise.withResolvers<void>()
      signOut.mockReturnValueOnce(sdkDone.promise)
      vi.resetModules()
      const { endDemoSession } = await import('@/lib/auth/client')
      const exit = endDemoSession()
      void exit.catch(() => {})
      await vi.waitFor(() => expect(signOut).toHaveBeenCalledExactlyOnceWith(exitAuth))
      if (phase === 'signOut成功後') {
        sdkDone.resolve()
        await expect(exit).rejects.toMatchObject({ name: 'SecurityError' })
      }

      try {
        expect(window.sessionStorage.getItem(key)).toBe(marker)
        waitingToken.resolve('old-bearer')
        waitingHeaders.resolve(headers)
        waitingResponse.resolve(Response.json({ status: 'proposed', learnings: [sampleLearning] }))
        // pageshowより先にタスクが再開しても送信や採用が起きない。
        await expect(alreadySent).resolves.toMatchObject({
          ok: false,
          failure: { kind: 'session_changed' },
        })
        await expect(notSent).resolves.toMatchObject({
          ok: false,
          failure: { kind: 'session_changed' },
        })
        await expect(oldToken).rejects.toThrow()
        await expect(auth.getAuthSnapshot()).rejects.toThrow()
        expect(returnedToken).not.toHaveBeenCalled()
        expect(abortedOnHide).toBe(true)
        expect(fetchFn).toHaveBeenCalledOnce()
        event('pageshow', true)
        expect(reload).toHaveBeenCalledOnce()
        expect(documentElement.hidden).toBe(true)
        await expect(auth.getAuthSnapshot()).rejects.toThrow()
      } finally {
        if (phase === 'SDK待機中') {
          sdkDone.resolve()
          await exit
        }
      }
    },
  )

  it('同じタブ・同じデモUIDで再認証しても旧DOMを再表示しない', async () => {
    const client = await import('./client')
    client.activateDemoSession()
    expect(client.getClientAuth()).toBe(demoAuth)
    event('pagehide', true)
    expect(documentElement.hidden).toBe(true)

    // 別文書で再認証した場合、凍結中のSDKは以前のUserを保持したままになる。
    client.activateDemoSession()
    expect(() => client.getClientAuth()).toThrow()
    event('pageshow', true)

    expect(reload).toHaveBeenCalledOnce()
    expect(documentElement.hidden).toBe(true)
  })

  it('別文書でタブをデモへ切り替えた後は旧匿名画面を再表示しない', async () => {
    const client = await import('./client')
    expect(client.getClientAuth()).toBe(standardAuth)
    event('pagehide', true)
    client.activateDemoSession()
    event('pageshow', true)

    expect(reload).toHaveBeenCalledOnce()
    expect(documentElement.hidden).toBe(true)
  })

  it.each([false, true])(
    '別文書でデモの終了を開始した後は旧デモ画面を再表示しない（完了: %s）',
    async (ended) => {
      const client = await import('./client')
      client.activateDemoSession()
      expect(client.getClientAuth()).toBe(demoAuth)
      event('pagehide', true)
      const key = 'groundtrip-demo-session'
      const marker = window.sessionStorage.getItem(key)
      // SDKのUserがBFCache内に残っていても、別文書で更新された目印を優先する。
      if (ended) window.sessionStorage.removeItem(key)
      else window.sessionStorage.setItem(key, `exit:${marker}`)
      event('pageshow', true)

      expect(() => client.getClientAuth()).toThrow()
      expect(reload).toHaveBeenCalledOnce()
      expect(documentElement.hidden).toBe(true)
    },
  )

  it('SDK上でUserが置き換わった場合は同じUIDでも復元しない', async () => {
    const client = await import('./client')
    client.getClientAuth()
    event('pagehide', true)
    standardAuth.currentUser = { ...standardAuth.currentUser }
    event('pageshow', true)

    expect(reload).toHaveBeenCalledOnce()
    expect(documentElement.hidden).toBe(true)
  })

  it('通常のpageshowでは画面を隠さず再読込しない', async () => {
    const client = await import('./client')
    client.getClientAuth()
    event('pagehide', false)
    event('pageshow', false)
    expect(reload).not.toHaveBeenCalled()
    expect(documentElement.hidden).toBe(false)
  })
})
