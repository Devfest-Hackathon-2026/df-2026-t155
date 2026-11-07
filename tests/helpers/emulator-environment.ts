import { parseServerConfig } from '../../src/lib/firebase/config'

const config = parseServerConfig({
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientProjectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  useEmulators: process.env.FIREBASE_USE_EMULATORS,
  authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
  nodeEnv: process.env.NODE_ENV,
})

if (!config.emulator || config.projectId !== 'demo-groundtrip') {
  throw new Error('統合テストはpnpm test:emulatorsから実行してください')
}
