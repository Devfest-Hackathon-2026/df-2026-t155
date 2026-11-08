import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { standardAuth, demoAuth } = vi.hoisted(() => ({
  standardAuth: { currentUser: { uid: 'anonymous' } },
  demoAuth: { currentUser: { uid: 'shared-demo' } },
}))
vi.mock('firebase/app', () => ({ getApps: () => [], initializeApp: vi.fn() }))
vi.mock('firebase/auth', () => ({
  getAuth: () => standardAuth,
  initializeAuth: () => demoAuth,
  browserSessionPersistence: {},
}))

const reload = vi.fn()
const documentElement = { hidden: false }
let tab: EventTarget

beforeEach(() => {
  vi.resetModules()
  reload.mockClear()
  documentElement.hidden = false
  standardAuth.currentUser = { uid: 'anonymous' }
  demoAuth.currentUser = { uid: 'shared-demo' }
  const session = new Map()
  tab = Object.assign(new EventTarget(), {
    sessionStorage: { getItem: session.get.bind(session), setItem: session.set.bind(session) },
    location: { reload },
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
})

function event(type: 'pagehide' | 'pageshow', persisted: boolean) {
  tab.dispatchEvent(Object.assign(new Event(type), { persisted }))
}

describe('認証画面のBFCache復元', () => {
  it('匿名認証が同じまま戻ったら、再読込せず既存画面を再表示する', async () => {
    const client = await import('./client')
    expect(client.getClientAuth()).toBe(standardAuth)
    event('pagehide', true)
    expect(documentElement.hidden).toBe(true)
    event('pageshow', true)

    expect(reload).not.toHaveBeenCalled()
    expect(documentElement.hidden).toBe(false)
  })

  it('デモ認証が同じまま戻った場合も再読込しない', async () => {
    const client = await import('./client')
    client.activateDemoSession()
    expect(client.getClientAuth()).toBe(demoAuth)
    event('pagehide', true)
    event('pageshow', true)

    expect(reload).not.toHaveBeenCalled()
    expect(documentElement.hidden).toBe(false)
  })

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

  it('SDK上でUserが置き換わった場合は同じUIDでも復元しない', async () => {
    const client = await import('./client')
    client.getClientAuth()
    event('pagehide', true)
    standardAuth.currentUser = { uid: standardAuth.currentUser.uid }
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
