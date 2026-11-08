import { deleteApp, getApps, initializeApp } from 'firebase/app'
import {
  connectAuthEmulator,
  getAuth,
  initializeAuth,
  signOut,
  updateCurrentUser,
} from 'firebase/auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '../../src/app/api/auth/session/route'
import type { AuthState } from '../../src/lib/auth/client'
import { getAdminAuth } from '../../src/lib/firebase/admin'

const subscriptions: Array<() => void> = []

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.resetModules()
  // SDK自身が所有する保存状態をSDKのsignOutで消す。認証情報を複製しない。
  const { getClientAuth } = await import('../../src/lib/firebase/client')
  await getClientAuth().authStateReady()
  await signOut(getClientAuth())
  await Promise.all(getApps().map((app) => deleteApp(app)))
  vi.resetModules()
})

afterEach(async () => {
  subscriptions.splice(0).forEach((stop) => stop())
  vi.restoreAllMocks()
  await Promise.all(
    getApps().map(async (app) => {
      await signOut(getAuth(app))
      await deleteApp(app)
    }),
  )
})

async function recreateClient() {
  const { getClientAuth } = await import('../../src/lib/firebase/client')
  // 実SDKの保存状態を維持したままAppとアプリ側モジュールを作り直す。
  // Node版SDKのメモリ永続化を使い、復元処理・Emulator通信はモックしない。
  await deleteApp(getClientAuth().app)
  vi.resetModules()
  return import('../../src/lib/auth/client')
}

async function userCount() {
  return (await getAdminAuth().listUsers(1000)).users.length
}

it('初回は自動作成せず、明示的な開始で正常に匿名認証できる', async () => {
  const client = await import('../../src/lib/auth/client')
  const before = await userCount()
  await expect(client.initializeAnonymousSession()).rejects.toMatchObject({ code: 'session_ended' })
  expect(await userCount()).toBe(before)
  const first = await client.startNewAnonymousSession()
  expect(first.isAnonymous).toBe(true)
  expect(await userCount()).toBe(before + 1)
})

it('正常な既存ユーザーはSDKとモジュールの再初期化後も同じUIDになる', async () => {
  const client = await import('../../src/lib/auth/client')
  const first = await client.startNewAnonymousSession()
  const count = await userCount()
  const restored = await recreateClient()
  expect(await restored.initializeAnonymousSession()).toEqual(first)
  expect(await userCount()).toBe(count)
})

it.each(['disabled', 'deleted'])(
  '%s済みユーザーをSDKが復元時に消しても再作成しない',
  async (kind) => {
    const client = await import('../../src/lib/auth/client')
    const first = await client.startNewAnonymousSession()
    if (kind === 'disabled') {
      await getAdminAuth().updateUser(first.uid, { disabled: true })
    } else {
      await getAdminAuth().deleteUser(first.uid)
    }
    const count = await userCount()
    const restored = await recreateClient()
    await expect(restored.initializeAnonymousSession()).rejects.toMatchObject({
      code: 'session_ended',
    })
    const { getClientAuth } = await import('../../src/lib/firebase/client')
    expect(getClientAuth().currentUser).toBeNull()
    await expect(restored.initializeAnonymousSession()).rejects.toMatchObject({
      code: 'session_ended',
    })
    expect(await userCount()).toBe(count)
  },
)

it('サインアウト・保存状態消失後は再初期化を繰り返しても新規作成しない', async () => {
  const client = await import('../../src/lib/auth/client')
  await client.startNewAnonymousSession()
  const { getClientAuth } = await import('../../src/lib/firebase/client')
  await signOut(getClientAuth())
  const count = await userCount()
  await expect(client.initializeAnonymousSession()).rejects.toMatchObject({ code: 'session_ended' })
  const restored = await recreateClient()
  await expect(restored.initializeAnonymousSession()).rejects.toMatchObject({
    code: 'session_ended',
  })
  expect(await userCount()).toBe(count)
})

it('セッション終了後、明示的な新規開始でのみ別の匿名UIDを作成できる', async () => {
  const client = await import('../../src/lib/auth/client')
  const first = await client.startNewAnonymousSession()
  const { getClientAuth } = await import('../../src/lib/firebase/client')
  await signOut(getClientAuth())
  const restored = await recreateClient()
  await expect(restored.initializeAnonymousSession()).rejects.toMatchObject({
    code: 'session_ended',
  })
  const count = await userCount()
  const next = await restored.startNewAnonymousSession()
  expect(next.uid === first.uid).toBe(false)
  expect(await userCount()).toBe(count + 1)
})

it('状態変化によるセッション終了を通知し、新規アカウントへ移行しない', async () => {
  const client = await import('../../src/lib/auth/client')
  await client.startNewAnonymousSession()
  const states: AuthState[] = []
  subscriptions.push(client.observeAuthState((state) => states.push(state)))
  await vi.waitFor(() => expect(states.at(-1)?.status).toBe('authenticated'))
  const { getClientAuth } = await import('../../src/lib/firebase/client')
  const count = await userCount()
  await signOut(getClientAuth())
  await vi.waitFor(() => expect(states.at(-1)?.status).toBe('session_ended'))
  await expect(client.getIdToken()).rejects.toMatchObject({ code: 'session_ended' })
  expect(states.at(-1)?.status).toBe('session_ended')
  expect(await userCount()).toBe(count)
})

it('復元・検証・トークン取得の実通信失敗で誤った成功通知を出さない', async () => {
  const client = await import('../../src/lib/auth/client')
  await client.startNewAnonymousSession()
  const firebaseClient = await import('../../src/lib/firebase/client')
  const offlineApp = initializeApp(
    { projectId: 'demo-groundtrip', apiKey: 'demo-api-key' },
    'offline-session',
  )
  const offlineAuth = initializeAuth(offlineApp)
  connectAuthEmulator(offlineAuth, 'http://127.0.0.1:1', { disableWarnings: true })
  await updateCurrentUser(offlineAuth, firebaseClient.getClientAuth().currentUser)
  // 接続先を差し替えるだけで、Auth SDK・reload・fetchはモックしない。
  vi.spyOn(firebaseClient, 'getClientAuth').mockReturnValue(offlineAuth)
  const states: AuthState[] = []
  subscriptions.push(client.observeAuthState((state) => states.push(state)))
  const count = await userCount()
  await expect(client.initializeAnonymousSession()).rejects.toMatchObject({ code: 'unavailable' })
  await expect(client.getIdToken(true)).rejects.toMatchObject({ code: 'unavailable' })
  expect(states.some((state) => state.status === 'authenticated')).toBe(false)
  expect(states.at(-1)).toMatchObject({ status: 'error', error: { code: 'unavailable' } })
  expect(await userCount()).toBe(count)
})

it('明示的な開始の実通信失敗後も、初期化は匿名認証へフォールバックしない', async () => {
  const firebaseClient = await import('../../src/lib/firebase/client')
  const offlineApp = initializeApp(
    { projectId: 'demo-groundtrip', apiKey: 'demo-api-key' },
    'offline-new-session',
  )
  const offlineAuth = initializeAuth(offlineApp)
  connectAuthEmulator(offlineAuth, 'http://127.0.0.1:1', { disableWarnings: true })
  vi.spyOn(firebaseClient, 'getClientAuth').mockReturnValue(offlineAuth)
  const client = await import('../../src/lib/auth/client')
  const count = await userCount()
  await expect(client.startNewAnonymousSession()).rejects.toMatchObject({ code: 'unavailable' })
  await expect(client.initializeAnonymousSession()).rejects.toMatchObject({ code: 'session_ended' })
  expect(await userCount()).toBe(count)
})

it('実クライアント認証モジュールからトークン更新・API検証を行う', async () => {
  const { startNewAnonymousSession, initializeAnonymousSession, getIdToken, getAuthHeaders } =
    await import('../../src/lib/auth/client')
  const first = await startNewAnonymousSession()
  const restored = await initializeAnonymousSession()
  expect(first).toEqual(restored)
  expect(first.isAnonymous).toBe(true)
  // トークンそのものをテスト結果へ表示しない。
  expect(typeof (await getIdToken(true))).toBe('string')
  const response = await GET(
    new Request('http://localhost/api/auth/session', { headers: await getAuthHeaders() }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ uid: first.uid })
})

describe.each(['getIdToken', 'initializeAnonymousSession', 'startNewAnonymousSession'] as const)(
  '実SDK・Emulatorで%sの完了とセッション切替を競合させる',
  (method) => {
    it.each(['resolve', 'reject'])(
      'Aの古い処理が%sしても明示開始したBを保持する',
      async (result) => {
        const client = await import('../../src/lib/auth/client')
        const first = await client.startNewAnonymousSession()
        const { getClientAuth } = await import('../../src/lib/firebase/client')
        const auth = getClientAuth()
        const a = auth.currentUser
        if (!a) throw new Error('テストの初期セッションがありません')
        const aReady = Promise.withResolvers<void>()
        const bReady = Promise.withResolvers<void>()
        const states: AuthState[] = []
        subscriptions.push(
          client.observeAuthState((state) => {
            states.push(state)
            if (state.status === 'authenticated') {
              if (state.user.uid === first.uid) aReady.resolve()
              else bReady.resolve()
            }
          }),
        )
        await aReady.promise

        const gate = Promise.withResolvers<void>()
        const begun = Promise.withResolvers<void>()
        const sdkGetIdToken = a.getIdToken.bind(a)
        // SDKの実トークン取得後、アプリに返るPromiseだけをゲートで遅延させる。
        // 初期化・新規開始の既存ユーザー検証でもreloadからこのSDKメソッドを通る。
        vi.spyOn(a, 'getIdToken').mockImplementationOnce(async (forceRefresh) => {
          const token = await sdkGetIdToken(forceRefresh)
          begun.resolve()
          await gate.promise
          return token
        })
        const old = method === 'getIdToken' ? client.getIdToken(true) : client[method]()
        try {
          await begun.promise
          await signOut(auth)
          const b = await client.startNewAnonymousSession()
          await bReady.promise
          expect(b.uid === first.uid).toBe(false)
          const count = states.length
          if (result === 'resolve') gate.resolve()
          else gate.reject({ code: 'auth/network-request-failed' })
          await expect(old).rejects.toMatchObject({
            code: result === 'resolve' ? 'session_ended' : 'unavailable',
          })
          expect(states).toHaveLength(count)
          expect(states.at(-1)).toMatchObject({
            status: 'authenticated',
            user: b,
            sessionGeneration: expect.any(Number),
          })
          expect(auth.currentUser?.uid).toBe(b.uid)
          const response = await GET(
            new Request('http://localhost/api/auth/session', {
              headers: await client.getAuthHeaders(),
            }),
          )
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ uid: b.uid })
        } finally {
          gate.resolve()
          await old.catch(() => undefined)
        }
      },
    )
  },
)
