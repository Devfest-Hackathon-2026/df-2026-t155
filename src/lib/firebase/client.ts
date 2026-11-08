'use client'

import { getApps, initializeApp } from 'firebase/app'
import {
  browserSessionPersistence,
  connectAuthEmulator,
  getAuth,
  initializeAuth,
  type Auth,
} from 'firebase/auth'

import { FirebaseConfigurationError, parseClientConfig } from './config'

let clientAuth: Auth | undefined
let clientDemoMarker: string | null | undefined

let demoAuth: Auth | undefined
const demoSessionKey = 'groundtrip-demo-session'

function readDemoSessionMarker(): string | null | undefined {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(demoSessionKey)
  } catch {
    return undefined
  }
}

export function isDemoSessionActive(): boolean {
  return Boolean(readDemoSessionMarker())
}

export function activateDemoSession(): void {
  // 認証情報はFirebaseに任せ、別文書でも再認証を区別できる目印だけを保存する。
  window.sessionStorage.setItem(demoSessionKey, crypto.randomUUID())
}

function createClientAuth(demo: boolean): Auth {
  const { options, emulator } = parseClientConfig({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    useEmulators: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS,
    nodeEnv: process.env.NODE_ENV,
  })
  const name = demo ? 'groundtrip-demo' : 'groundtrip-client'
  const existing = getApps().find((app) => app.name === name)
  if (existing && existing.options.projectId !== options.projectId) {
    throw new FirebaseConfigurationError()
  }
  const app = existing ?? initializeApp(options, name)
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

export function getClientAuth(): Auth {
  const marker = readDemoSessionMarker()
  if (clientAuth) {
    // #56のスコープ確認でも、古い文書が認証を使い続けることを防ぐ。
    if (marker !== clientDemoMarker) throw new FirebaseConfigurationError()
    return clientAuth
  }
  const auth = marker ? getDemoClientAuth() : createClientAuth(false)
  clientDemoMarker = marker
  clientAuth = auth
  if (typeof window !== 'undefined') {
    let userOnHide: Auth['currentUser'] | undefined
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) return
      userOnHide = auth.currentUser
      document.documentElement.hidden = true
    })
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return
      const sameSession =
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
