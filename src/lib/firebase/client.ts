'use client'

import { getApps, initializeApp } from 'firebase/app'
import {
  browserSessionPersistence,
  connectAuthEmulator,
  getAuth,
  initializeAuth,
  setPersistence,
  signInWithCustomToken,
  signOut,
  type Auth,
} from 'firebase/auth'

import {
  DemoSessionExitPendingError,
  FirebaseConfigurationError,
  parseClientConfig,
} from './config'

let clientAuth: Auth | undefined
let clientDemoMarker: string | null | undefined
let demoDocumentDiscarded = false
let onDemoDocumentDiscard: ((auth: Auth) => void) | undefined

let demoAuth: Auth | undefined
const demoSessionKey = 'groundtrip-demo-session'
const demoAuthLockKey = 'groundtrip-demo-auth-lock'
const exitMarkerPrefix = 'exit:'
const demoAuthLockWaitMs = 15_000
let demoExit: 'idle' | 'pending' | 'retry' | 'complete' = 'idle'

function readDemoSessionMarker(): string | null | undefined {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(demoSessionKey)
  } catch {
    return undefined
  }
}

export function isDemoSessionActive(): boolean {
  const status = getDemoSessionStatus()
  return status === 'active' || status === 'exit_requested'
}

export function getDemoSessionStatus(): 'inactive' | 'active' | 'exit_requested' | 'unavailable' {
  const marker = readDemoSessionMarker()
  if (demoExit !== 'idle' || marker?.startsWith(exitMarkerPrefix)) return 'exit_requested'
  if (marker === undefined || marker === '') return 'unavailable'
  return marker === null ? 'inactive' : 'active'
}

export function activateDemoSession(): void {
  const status = getDemoSessionStatus()
  if (status === 'exit_requested' || status === 'unavailable')
    throw new FirebaseConfigurationError()
  // 認証情報はFirebaseに任せ、別文書でも再認証を区別できる目印だけを保存する。
  window.sessionStorage.setItem(demoSessionKey, crypto.randomUUID())
}

function demoAuthLockId(marker: string | null): string | null {
  const stored = window.sessionStorage.getItem(demoAuthLockKey)
  // 既存のデモタブは、初回の再認証まで従来の目印をロックIDとして使う。
  return stored ?? marker?.replace(/^exit:/, '') ?? null
}

export function prepareDemoSignIn() {
  const marker = readDemoSessionMarker()
  if (marker === undefined || marker === '') throw new FirebaseConfigurationError()

  return async (customToken: string, signal: AbortSignal): Promise<boolean> => {
    const locks = navigator.locks
    if (!locks) throw new FirebaseConfigurationError()
    signal.throwIfAborted()
    if (getDemoSessionStatus() === 'exit_requested' || readDemoSessionMarker() !== marker) {
      return false
    }
    const id = demoAuthLockId(marker) ?? crypto.randomUUID()
    // SDKを呼ぶ前に記録する。画面離脱後も別文書の終了操作から同じロックを待てる。
    if (window.sessionStorage.getItem(demoAuthLockKey) === null) {
      window.sessionStorage.setItem(demoAuthLockKey, id)
    }
    return locks.request(`${demoAuthLockKey}:${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return false
      signal.throwIfAborted()
      if (
        window.location.pathname !== '/access' ||
        getDemoSessionStatus() === 'exit_requested' ||
        readDemoSessionMarker() !== marker ||
        demoAuthLockId(marker) !== id
      ) {
        return false
      }
      // SDKの処理は中断できないため、画面側のタイムアウト・離脱でもここではロックを解放しない。
      await signInWithCustomToken(getDemoClientAuth(), customToken)
      if (getDemoSessionStatus() === 'exit_requested' || readDemoSessionMarker() !== marker) {
        return false
      }
      // 再認証は離脱後に成立しても既存の世代を無効化する。初回は離脱済みの画面から有効化しない。
      if (marker !== null || !signal.aborted) activateDemoSession()
      signal.throwIfAborted()
      return true
    })
  }
}

function markDemoExit(marker: string): string {
  if (marker.startsWith(exitMarkerPrefix)) return marker
  const pending = exitMarkerPrefix + marker
  try {
    window.sessionStorage.setItem(demoSessionKey, pending)
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.name === 'SecurityError') &&
      readDemoSessionMarker() === marker
    ) {
      // 元の目印で通常認証への切り替えを防ぎ、ロック内でSDKの保存状態を先に消す。
      return marker
    }
    throw error
  }
  if (readDemoSessionMarker() !== pending) throw new FirebaseConfigurationError()
  return pending
}

export async function signOutDemoSession(onExitStart: (auth: Auth) => void): Promise<void> {
  if (demoDocumentDiscarded) throw new FirebaseConfigurationError()
  if (window.location.pathname === '/access' || demoExit === 'pending') {
    throw new DemoSessionExitPendingError()
  }
  if (demoExit === 'complete') return

  const marker = readDemoSessionMarker()
  if (marker === null || marker === '') throw new FirebaseConfigurationError()
  if (marker === undefined && !clientDemoMarker && demoExit === 'idle') {
    throw new FirebaseConfigurationError()
  }
  if (
    clientAuth &&
    (!clientDemoMarker ||
      (marker !== undefined &&
        marker !== clientDemoMarker &&
        marker !== exitMarkerPrefix + clientDemoMarker))
  ) {
    throw new FirebaseConfigurationError()
  }

  demoExit = 'pending'
  try {
    const auth = getDemoClientAuth()
    onExitStart(auth)
    if (marker === undefined) throw new FirebaseConfigurationError()

    const id = demoAuthLockId(marker)
    const exitMarker = markDemoExit(marker)
    const finish = async () => {
      const current = readDemoSessionMarker()
      if (!current || demoAuthLockId(current) !== id) throw new FirebaseConfigurationError()
      // 目印を書けなかった場合、先行する再認証が世代を更新していることがある。
      const expected = current === exitMarker ? current : markDemoExit(current)
      // SDKが初期化時のストレージ障害でメモリに退避していても、対象はタブの保存状態。
      await setPersistence(auth, browserSessionPersistence)
      await signOut(auth)
      if (readDemoSessionMarker() !== expected) throw new FirebaseConfigurationError()
      window.sessionStorage.removeItem(demoSessionKey)
    }
    if (navigator.locks) {
      // タイムアウトはロックの取得待ちだけに適用する。取得済みのSDK処理には適用しない。
      await navigator.locks.request(
        `${demoAuthLockKey}:${id}`,
        { signal: AbortSignal.timeout(demoAuthLockWaitMs) },
        finish,
      )
    } else {
      // ロック導入前のデモだけは、この環境で新しいSDKサインインが開始されないため終了できる。
      if (window.sessionStorage.getItem(demoAuthLockKey) !== null) {
        throw new FirebaseConfigurationError()
      }
      await finish()
    }
    demoExit = 'complete'
  } catch (error) {
    demoExit = 'retry'
    throw error
  }
}

function readClientConfig() {
  return parseClientConfig({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    useEmulators: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS,
    nodeEnv: process.env.NODE_ENV,
  })
}

function getClientApp(demo: boolean, options: ReturnType<typeof readClientConfig>['options']) {
  const name = demo ? 'groundtrip-demo' : 'groundtrip-client'
  const existing = getApps().find((app) => app.name === name)
  if (existing && existing.options.projectId !== options.projectId) {
    throw new FirebaseConfigurationError()
  }
  return existing ?? initializeApp(options, name)
}

export function getDemoClientApp() {
  // 券交換のApp CheckはAuthを初期化せず、SDKによる認証情報の復元・保存もロック内で始める。
  return getClientApp(true, readClientConfig().options)
}

function createClientAuth(demo: boolean): Auth {
  const { options, emulator } = readClientConfig()
  const app = getClientApp(demo, options)
  const auth = demo ? initializeAuth(app, { persistence: browserSessionPersistence }) : getAuth(app)
  if (!emulator && auth.emulatorConfig) throw new FirebaseConfigurationError()
  if (emulator && !auth.emulatorConfig) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  }
  return auth
}

export function getDemoClientAuth(): Auth {
  return (demoAuth ??= createClientAuth(true))
}

export function getClientAuth({
  allowDemo = true,
  onDiscardDemoDocument,
}: {
  allowDemo?: boolean
  onDiscardDemoDocument?: (auth: Auth) => void
} = {}): Auth {
  if (demoDocumentDiscarded) throw new FirebaseConfigurationError()
  const marker = readDemoSessionMarker()
  if (demoExit !== 'idle' || marker?.startsWith(exitMarkerPrefix)) {
    throw new DemoSessionExitPendingError()
  }
  if (marker === undefined || marker === '') throw new FirebaseConfigurationError()
  if (marker && !allowDemo) throw new FirebaseConfigurationError()
  // #56のスコープ確認でも、古い文書が認証を使い続けることを防ぐ。
  if (clientAuth && marker !== clientDemoMarker) throw new FirebaseConfigurationError()
  if (marker && onDiscardDemoDocument) onDemoDocumentDiscard = onDiscardDemoDocument
  if (clientAuth) return clientAuth
  const auth = marker ? getDemoClientAuth() : createClientAuth(false)
  clientDemoMarker = marker
  clientAuth = auth
  if (typeof window !== 'undefined') {
    let userOnHide: Auth['currentUser'] | undefined
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) {
        userOnHide = auth.currentUser
        document.documentElement.hidden = true
      }
      if (marker && !demoDocumentDiscarded) {
        // 別文書の終了を目印で判別できない場合も、復元時に旧SDKのUserを使わせない。
        demoDocumentDiscarded = true
        onDemoDocumentDiscard?.(auth)
      }
    })
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return
      const sameSession =
        !demoDocumentDiscarded &&
        userOnHide !== undefined &&
        userOnHide === auth.currentUser &&
        marker === readDemoSessionMarker()
      userOnHide = undefined
      if (sameSession) {
        document.documentElement.hidden = false
        return
      }
      // 古いDOMを見せず、新しい認証世代の画面を読み込む。
      document.documentElement.hidden = true
      window.location.reload()
    })
  }
  return auth
}
