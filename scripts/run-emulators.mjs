import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const mode = process.argv[2]
if (mode !== 'start' && mode !== 'test') throw new Error('startまたはtestを指定してください')

const require = createRequire(import.meta.url)
const env = {
  ...process.env,
  GCLOUD_PROJECT: 'demo-groundtrip',
  GOOGLE_CLOUD_PROJECT: 'demo-groundtrip',
  // Firestore SDKの初期化で、ローカル実行時にGCPメタデータを探さない。
  METADATA_SERVER_DETECTION: 'none',
  FIREBASE_PROJECT_ID: 'demo-groundtrip',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-groundtrip',
  NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-api-key',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-groundtrip.firebaseapp.com',
  NEXT_PUBLIC_FIREBASE_APP_ID: 'demo-app-id',
  NEXT_PUBLIC_FIREBASE_USE_EMULATORS: 'true',
  FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-groundtrip' }),
  FIREBASE_USE_EMULATORS: 'true',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
}
// 実プロジェクト用の環境変数をテストに持ち込まない。
delete env.GOOGLE_APPLICATION_CREDENTIALS
delete env.FIREBASE_TOKEN

const args = [
  require.resolve('firebase-tools/lib/bin/firebase.js'),
  mode === 'test' ? 'emulators:exec' : 'emulators:start',
  '--project',
  'demo-groundtrip',
  '--config',
  'firebase.json',
  '--only',
  'auth,firestore',
]
if (mode === 'test') {
  env.PERSISTENCE_ENABLED = 'true'
  args.push('pnpm exec vitest run --config vitest.integration.config.ts')
}
const child = spawn(process.execPath, args, { env, stdio: 'inherit' })
child.on('error', () => {
  console.error('Firebase Emulatorを起動できませんでした')
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
