'use client'

import { onIdTokenChanged, reload, signInAnonymously, type Auth, type User } from 'firebase/auth'

import { getClientAuth } from '../firebase/client'
import { FirebaseConfigurationError } from '../firebase/config'

export type AuthUser = Readonly<{ uid: string; isAnonymous: boolean }>
export type AuthState =
  | { status: 'restoring' }
  | { status: 'session_ended'; error: ClientAuthError }
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'error'; error: ClientAuthError }

export class ClientAuthError extends Error {
  constructor(
    readonly code: 'configuration_error' | 'session_ended' | 'unavailable' | 'sign_in_failed',
  ) {
    const messages = {
      configuration_error: '認証の設定を確認してください',
      session_ended:
        '利用可能な認証状態がありません。以前の匿名データを復旧できない場合があります。新しい利用を始めるには明示的な開始操作が必要です',
      unavailable: '認証サービスに接続できません。時間をおいて再試行してください',
      sign_in_failed: '認証を開始できませんでした。再試行してください',
    }
    super(messages[code])
    this.name = 'ClientAuthError'
  }
}

function toClientError(error: unknown): ClientAuthError {
  if (error instanceof ClientAuthError) return error
  if (error instanceof FirebaseConfigurationError) return new ClientAuthError('configuration_error')
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (
    code === 'auth/user-disabled' ||
    code === 'auth/user-not-found' ||
    code === 'auth/user-token-expired' ||
    code === 'auth/invalid-user-token'
  ) {
    return new ClientAuthError('session_ended')
  }
  if (code === 'auth/network-request-failed' || code === 'auth/too-many-requests') {
    return new ClientAuthError('unavailable')
  }
  return new ClientAuthError('sign_in_failed')
}

function summarize(user: User): AuthUser {
  return { uid: user.uid, isAnonymous: user.isAnonymous }
}

type Session = {
  auth: Auth
  user: User | null
  generation: number
  verified: boolean
  errorGeneration: number
  lastError?: ClientAuthError
  initialization?: Promise<AuthUser>
  starting?: Promise<AuthUser>
  verification?: Promise<void>
}

const sessions = new WeakMap<Auth, Session>()
const restoredAuths = new WeakSet<Auth>()
const errorListeners = new Set<(error: ClientAuthError, session: Session) => void>()

function currentSession(auth: Auth): Session {
  const previous = sessions.get(auth)
  if (previous && previous.user === auth.currentUser) return previous
  // UIDが同じでも、サインアウトやUserオブジェクトの置換後は別世代とする。
  const session: Session = {
    auth,
    user: auth.currentUser,
    generation: previous ? previous.generation + 1 : 0,
    verified: false,
    errorGeneration: 0,
  }
  sessions.set(auth, session)
  return session
}

function isCurrent(session: Session): boolean {
  return currentSession(session.auth) === session
}

function assertCurrent(session: Session): void {
  if (!isCurrent(session)) throw new ClientAuthError('session_ended')
}

async function restoreSession(session: Session): Promise<Session> {
  const mayRestore = !restoredAuths.has(session.auth) && session.user === null
  await session.auth.authStateReady()
  restoredAuths.add(session.auth)
  const current = currentSession(session.auth)
  if (current === session) return session
  // 起動直後のnull→復元ユーザーだけは採用する。それ以外の途中切替は引き継がない。
  if (mayRestore && session.generation === 0 && current.generation === 1) return current
  throw new ClientAuthError('session_ended')
}

function reportError(error: unknown, session: Session): ClientAuthError {
  const safeError = toClientError(error)
  // 古い操作は呼び出し元へ失敗を返すだけ。新世代の検証・キャッシュ・通知に触れない。
  if (isCurrent(session)) {
    session.verified = false
    session.errorGeneration += 1
    session.lastError = safeError
    errorListeners.forEach((listener) => {
      if (isCurrent(session)) listener(safeError, session)
    })
  }
  return safeError
}

function verifyCurrentUser(session: Session): Promise<void> {
  assertCurrent(session)
  const user = session.user
  if (!user) throw new ClientAuthError('session_ended')
  if (session.verification) return session.verification
  const generation = session.errorGeneration
  const promise = (async () => {
    // 復元時の通信失敗をSDKが吸収してcurrentUserを残す場合も、成功扱いにしない。
    // reload自身も更新通知するため、購読側では検証済みUserと進行中Promiseを再利用する。
    await reload(user)
    assertCurrent(session)
    if (generation !== session.errorGeneration) {
      throw session.lastError ?? new ClientAuthError('unavailable')
    }
    session.verified = true
  })().finally(() => {
    if (session.verification === promise) session.verification = undefined
  })
  session.verification = promise
  return promise
}

// 既存状態の復元専用。currentUser=nullは初回利用の証拠にならない。
// SDKが無効化・削除済みユーザーを消去しても、新しい匿名UIDへ切り替えない。
export function initializeAnonymousSession(): Promise<AuthUser> {
  let session: Session
  try {
    session = currentSession(getClientAuth())
  } catch (error) {
    return Promise.reject(toClientError(error))
  }
  if (session.starting) return session.starting
  if (session.initialization) return session.initialization
  const origin = session
  const promise = (async () => {
    try {
      session = await restoreSession(session)
      await verifyCurrentUser(session)
      assertCurrent(session)
      const user = session.user
      if (!user) throw new ClientAuthError('session_ended')
      // 将来リンクしたGoogleユーザーもそのまま利用し、匿名で置き換えない。
      return summarize(user)
    } catch (error) {
      throw reportError(error, session)
    }
  })().finally(() => {
    if (origin.initialization === promise) origin.initialization = undefined
    if (session.initialization === promise) session.initialization = undefined
  })
  origin.initialization = promise
  return promise
}

// 初回も含め「新しい利用を始める」という利用者の明示操作からだけ呼ぶ。
// 正常な既存ユーザーは保持し、復元・検証に失敗した後の自動作成は行わない。
export function startNewAnonymousSession(): Promise<AuthUser> {
  let session: Session
  try {
    session = currentSession(getClientAuth())
  } catch (error) {
    return Promise.reject(toClientError(error))
  }
  if (session.starting) return session.starting
  const origin = session
  const promise = (async () => {
    try {
      session = await restoreSession(session)
      if (!session.user) {
        const { user } = await signInAnonymously(session.auth)
        const created = currentSession(session.auth)
        // この開始操作によるnull→作成ユーザーの一回の遷移だけを引き継ぐ。
        if (created.user !== user || created.generation !== session.generation + 1) {
          throw new ClientAuthError('session_ended')
        }
        session = created
        session.starting = origin.starting
      }
      await verifyCurrentUser(session)
      assertCurrent(session)
      const user = session.user
      if (!user) throw new ClientAuthError('session_ended')
      return summarize(user)
    } catch (error) {
      throw reportError(error, session)
    }
  })().finally(() => {
    if (origin.starting === promise) origin.starting = undefined
    if (session.starting === promise) session.starting = undefined
  })
  origin.starting = promise
  return promise
}

export function observeAuthState(listener: (state: AuthState) => void): () => void {
  listener({ status: 'restoring' })
  let active = true
  let generation = 0
  const notifyError = (error: ClientAuthError) => {
    generation += 1
    if (active) {
      listener({ status: error.code === 'session_ended' ? 'session_ended' : 'error', error })
    }
  }
  let auth: Auth
  const onError = (error: ClientAuthError, session: Session) => {
    if (session.auth === auth && isCurrent(session)) notifyError(error)
  }
  let unsubscribe: (() => void) | undefined
  try {
    auth = getClientAuth()
    errorListeners.add(onError)
    // SDK仕様上、onIdTokenChangedのエラーコールバックは呼ばれない。
    // エラーは検証・初期化・サインイン・トークン取得のPromiseで扱う。
    unsubscribe = onIdTokenChanged(auth, (user) => {
      if (!active) return
      const session = currentSession(auth)
      if (session.user !== user) return
      const observedGeneration = ++generation
      if (!user) {
        notifyError(new ClientAuthError('session_ended'))
        return
      }
      if (session.verified) {
        listener({ status: 'authenticated', user: summarize(user) })
        return
      }
      listener({ status: 'restoring' })
      void verifyCurrentUser(session).then(
        () => {
          if (active && generation === observedGeneration && isCurrent(session)) {
            listener({ status: 'authenticated', user: summarize(user) })
          }
        },
        (error: unknown) => {
          if (active && generation === observedGeneration && isCurrent(session)) {
            notifyError(toClientError(error))
          }
        },
      )
    })
  } catch (error) {
    notifyError(toClientError(error))
  }
  return () => {
    active = false
    generation += 1
    errorListeners.delete(onError)
    unsubscribe?.()
  }
}

export async function getIdToken(forceRefresh = false): Promise<string> {
  let session: Session | undefined
  try {
    session = currentSession(getClientAuth())
    session = await restoreSession(session)
    const user = session.user
    if (!user) throw new ClientAuthError('session_ended')
    const token = await user.getIdToken(forceRefresh)
    assertCurrent(session)
    return token
  } catch (error) {
    // 失効・失敗時に新しい匿名ユーザーを自動作成してはいけない。
    throw session ? reportError(error, session) : toClientError(error)
  }
}

export async function getAuthHeaders(): Promise<Headers> {
  return new Headers({ Authorization: `Bearer ${await getIdToken()}` })
}
