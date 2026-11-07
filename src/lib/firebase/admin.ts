import 'server-only'

import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

import { FirebaseConfigurationError, parseServerConfig } from './config'

export function getAdminAuth() {
  // キャッシュ済みでも毎回チェックし、本番のEmulator設定を見逃さない。
  const config = parseServerConfig({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientProjectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    useEmulators: process.env.FIREBASE_USE_EMULATORS,
    authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    nodeEnv: process.env.NODE_ENV,
  })
  const existing = getApps().find((app) => app.name === 'groundtrip-admin')
  if (existing && existing.options.projectId !== config.projectId) {
    throw new FirebaseConfigurationError()
  }
  const app =
    existing ??
    initializeApp(
      config.emulator
        ? { projectId: config.projectId }
        : { projectId: config.projectId, credential: applicationDefault() },
      'groundtrip-admin',
    )
  return getAuth(app)
}
