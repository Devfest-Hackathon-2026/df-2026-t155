'use client'

import { onIdTokenChanged, reload, signInAnonymously, type Auth, type User } from 'firebase/auth'

import { getClientAuth } from '../firebase/client'
import { FirebaseConfigurationError } from '../firebase/config'

export type AuthUser = Readonly<{ uid: string; isAnonymous: boolean }>
// 同じUserから同時に取ったUIDとIDトークンの組。
export type AuthSnapshot = Readonly<{ uid: string; token: string; generation: number }>
export type AuthState =
  | { status: 'restoring'; sessionGeneration: number }
  | { status: 'session_ended'; error: ClientAuthError; sessionGeneration: number }
  | { status: 'authenticated'; user: AuthUser; sessionGeneration: number }
  | { status: 'error'; error: ClientAuthError; sessionGeneration: number }

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
  activeOperations: Set<AbortController>
}

const sessions = new WeakMap<Auth, Session>()
const restoredAuths = new WeakSet<Auth>()

function invalidateSessionOperations(session: Session): void {
  for (const controller of session.activeOperations) controller.abort()
  session.activeOperations.clear()
}
const errorListeners = new Set<(error: ClientAuthError, session: Session) => void>()

function currentSession(auth: Auth): Session {
  const previous = sessions.get(auth)
  if (previous && previous.user === auth.currentUser) return previous
  if (previous) invalidateSessionOperations(previous)
  // UIDが同じでも、サインアウトやUserオブジェクトの置換後は別世代とする。
  const session: Session = {
    auth,
    user: auth.currentUser,
    generation: previous ? previous.generation + 1 : 0,
    verified: false,
    errorGeneration: 0,
    activeOperations: new Set(),
  }
  sessions.set(auth, session)
  return session
}

function isCurrent(session: Session): boolean {
  return currentSession(session.auth) === session
}

function assertCurrent(session: Session, expectedGeneration = session.generation): void {
  if (!isCurrent(session) || session.generation !== expectedGeneration) {
    throw new ClientAuthError('session_ended')
  }
}

async function restoreSession(session: Session): Promise<Session> {
  const generation = session.generation
  const mayRestore = !restoredAuths.has(session.auth) && session.user === null
  await session.auth.authStateReady()
  if (session.generation !== generation) throw new ClientAuthError('session_ended')
  restoredAuths.add(session.auth)
  const current = currentSession(session.auth)
  if (current === session) return session
  // 起動直後のnull→復元ユーザーだけは採用する。それ以外の途中切替は引き継がない。
  if (mayRestore && session.generation === 0 && current.generation === 1) return current
  throw new ClientAuthError('session_ended')
}

function reportError(
  error: unknown,
  session: Session,
  expectedGeneration = session.generation,
): ClientAuthError {
  const safeError = toClientError(error)
  // 古い操作は呼び出し元へ失敗を返すだけ。新世代の検証・キャッシュ・通知に触れない。
  if (isCurrent(session) && session.generation === expectedGeneration) {
    session.verified = false
    session.errorGeneration += 1
    session.lastError = safeError
    // 失効・終了は同じUIDへ戻っても以前の操作を復活させない。
    if (safeError.code === 'session_ended') {
      invalidateSessionOperations(session)
      session.generation += 1
      session.verified = false
      session.verification = undefined
      session.initialization = undefined
      session.starting = undefined
    }
    errorListeners.forEach((listener) => {
      if (isCurrent(session)) listener(safeError, session)
    })
  }
  return safeError
}

function verifyCurrentUser(session: Session): Promise<void> {
  assertCurrent(session)
  const sessionGeneration = session.generation
  const user = session.user
  if (!user) throw new ClientAuthError('session_ended')
  if (session.verification) return session.verification
  const errorGeneration = session.errorGeneration
  const promise = (async () => {
    // 復元時の通信失敗をSDKが吸収してcurrentUserを残す場合も、成功扱いにしない。
    // reload自身も更新通知するため、購読側では検証済みUserと進行中Promiseを再利用する。
    await reload(user)
    assertCurrent(session, sessionGeneration)
    if (errorGeneration !== session.errorGeneration) {
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
  let operationGeneration = session.generation
  const promise = (async () => {
    try {
      session = await restoreSession(session)
      operationGeneration = session.generation
      await verifyCurrentUser(session)
      assertCurrent(session, operationGeneration)
      const user = session.user
      if (!user) throw new ClientAuthError('session_ended')
      // 将来リンクしたGoogleユーザーもそのまま利用し、匿名で置き換えない。
      return summarize(user)
    } catch (error) {
      throw reportError(error, session, operationGeneration)
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
  let operationGeneration = session.generation
  const promise = (async () => {
    try {
      session = await restoreSession(session)
      operationGeneration = session.generation
      if (!session.user) {
        const { user } = await signInAnonymously(session.auth)
        const created = currentSession(session.auth)
        // この開始操作によるnull→作成ユーザーの一回の遷移だけを引き継ぐ。
        if (created.user !== user || created.generation !== session.generation + 1) {
          throw new ClientAuthError('session_ended')
        }
        session = created
        operationGeneration = session.generation
        session.starting = origin.starting
      }
      await verifyCurrentUser(session)
      assertCurrent(session, operationGeneration)
      const user = session.user
      if (!user) throw new ClientAuthError('session_ended')
      return summarize(user)
    } catch (error) {
      throw reportError(error, session, operationGeneration)
    }
  })().finally(() => {
    if (origin.starting === promise) origin.starting = undefined
    if (session.starting === promise) session.starting = undefined
  })
  origin.starting = promise
  return promise
}

export function observeAuthState(listener: (state: AuthState) => void): () => void {
  listener({ status: 'restoring', sessionGeneration: 0 })
  let active = true
  let notificationGeneration = 0
  const notifyError = (error: ClientAuthError, sessionGeneration: number) => {
    notificationGeneration += 1
    if (active) {
      listener({
        status: error.code === 'session_ended' ? 'session_ended' : 'error',
        error,
        sessionGeneration,
      })
    }
  }
  let auth: Auth
  const onError = (error: ClientAuthError, session: Session) => {
    if (session.auth === auth && isCurrent(session)) {
      notifyError(error, session.generation)
    }
  }
  let unsubscribe: (() => void) | undefined
  try {
    auth = getClientAuth()
    const initialSession = currentSession(auth)
    listener({ status: 'restoring', sessionGeneration: initialSession.generation })
    errorListeners.add(onError)
    // SDK仕様上、onIdTokenChangedのエラーコールバックは呼ばれない。
    // エラーは検証・初期化・サインイン・トークン取得のPromiseで扱う。
    let lastNotifiedUser: User | null | undefined = initialSession.user
    unsubscribe = onIdTokenChanged(auth, (user) => {
      if (!active) return
      const previousSession = sessions.get(auth)
      const session = currentSession(auth)
      const sessionReplaced = previousSession !== session
      const notificationChanged = lastNotifiedUser !== user
      if (sessionReplaced) {
        // currentUser自体の置換ですでに世代を進めた。次の同じUser通知で二重に進めない。
        lastNotifiedUser = session.user
      } else {
        lastNotifiedUser = user
      }
      if (notificationChanged && !sessionReplaced) {
        // 連続した認証通知でもcurrentUserが既に元のUserへ戻っている場合、通知列から世代境界を数える。
        // currentSessionが既にUser置換を検出した通常経路では二重に世代を進めない。
        invalidateSessionOperations(session)
        session.generation += 1
        session.verified = false
        session.errorGeneration += 1
        session.lastError = undefined
        session.verification = undefined
        session.initialization = undefined
        session.starting = undefined
      }
      const currentUser = session.user
      const observedGeneration = ++notificationGeneration
      if (!currentUser) {
        notifyError(new ClientAuthError('session_ended'), session.generation)
        return
      }
      if (session.verified) {
        listener({
          status: 'authenticated',
          user: summarize(currentUser),
          sessionGeneration: session.generation,
        })
        return
      }
      listener({ status: 'restoring', sessionGeneration: session.generation })
      void verifyCurrentUser(session).then(
        () => {
          if (active && notificationGeneration === observedGeneration && isCurrent(session)) {
            listener({
              status: 'authenticated',
              user: summarize(currentUser),
              sessionGeneration: session.generation,
            })
          }
        },
        (error: unknown) => {
          if (active && notificationGeneration === observedGeneration && isCurrent(session)) {
            reportError(error, session, session.generation)
          }
        },
      )
    })
  } catch (error) {
    notifyError(toClientError(error), 0)
  }
  return () => {
    active = false
    notificationGeneration += 1
    errorListeners.delete(onError)
    unsubscribe?.()
  }
}

// UIDとIDトークンを、同じUserオブジェクトから同じ取得処理で組にして返す。
// getIdTokenとgetAuthSnapshotの共通実装。セッション検証・エラー変換は従来のgetIdTokenのまま。
async function fetchAuthSnapshot(forceRefresh: boolean): Promise<AuthSnapshot> {
  let session: Session | undefined
  let operationGeneration: number | undefined
  try {
    session = currentSession(getClientAuth())
    session = await restoreSession(session)
    operationGeneration = session.generation
    const user = session.user
    if (!user) throw new ClientAuthError('session_ended')
    // UIDはトークン取得の待機中に別Userのものへ差し替わらないよう、同じuserから先に読む。
    const uid = user.uid
    const token = await user.getIdToken(forceRefresh)
    // 待機中にサインアウト・ユーザー変更があれば、組を返さず失敗にする。
    assertCurrent(session, operationGeneration)
    return { uid, token, generation: operationGeneration }
  } catch (error) {
    // 失効・失敗時に新しい匿名ユーザーを自動作成してはいけない。
    throw session
      ? reportError(error, session, operationGeneration ?? session.generation)
      : toClientError(error)
  }
}

export async function getIdToken(forceRefresh = false): Promise<string> {
  return (await fetchAuthSnapshot(forceRefresh)).token
}

// 現在のセッションのUIDとIDトークンを、同じ瞬間・同じUserから取った組で返す。
// 呼び出し側がgetIdTokenと別にUIDを読むと、その間のユーザー切替で食い違うため、組が必要なときはこちらを使う。
export function getAuthSnapshot(): Promise<AuthSnapshot> {
  return fetchAuthSnapshot(false)
}

// 同期区間での送信直前・応答採用直前に、通知時点で更新された認証世代を確認する。
// currentSessionはcurrentUserの差し替えも検出して進行中操作を同期的に中断する。
export function isAuthSessionCurrent(uid: string, generation: number): boolean {
  try {
    const session = currentSession(getClientAuth())
    return session.user?.uid === uid && session.generation === generation
  } catch {
    return false
  }
}

// セッション境界でAbortControllerを同期的に中断する。返された関数で通常終了時に登録を解除する。
export function registerAuthSessionOperation(
  uid: string,
  generation: number,
  controller: AbortController,
): (() => void) | undefined {
  const session = currentSession(getClientAuth())
  if (session.user?.uid !== uid || session.generation !== generation) return undefined
  session.activeOperations.add(controller)
  return () => session.activeOperations.delete(controller)
}

export async function getAuthHeaders(): Promise<Headers> {
  return new Headers({ Authorization: `Bearer ${await getIdToken()}` })
}
