'use client'

import { getApps, initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth'

import { FirebaseConfigurationError, parseClientConfig } from './config'

let clientAuth: Auth | undefined

export function getClientAuth(): Auth {
  if (clientAuth) return clientAuth
  const { options, emulator } = parseClientConfig({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    useEmulators: process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS,
    nodeEnv: process.env.NODE_ENV,
  })
  const existing = getApps().find((app) => app.name === 'groundtrip-client')
  if (existing && existing.options.projectId !== options.projectId) {
    throw new FirebaseConfigurationError()
  }
  const app = existing ?? initializeApp(options, 'groundtrip-client')
  const auth = getAuth(app)
  if (!emulator && auth.emulatorConfig) throw new FirebaseConfigurationError()
  if (emulator && !auth.emulatorConfig) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  }
  clientAuth = auth
  return auth
}
