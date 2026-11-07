import 'server-only'

import { FirebaseConfigurationError } from '../firebase/config'

// 生のcodeも任意文字列なので、許可した値以外はログへ渡さない。
export function classifyAuthFailure(error: unknown) {
  if (error instanceof FirebaseConfigurationError) {
    return { category: 'configuration', code: 'firebase_configuration' } as const
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  switch (code) {
    case 'auth/insufficient-permission':
      return { category: 'permission', code } as const
    case 'app/invalid-credential':
    case 'auth/invalid-credential':
      return { category: 'credential', code } as const
    case 'app/network-error':
    case 'auth/network-request-failed':
      return { category: 'network', code } as const
    case 'auth/internal-error':
      return { category: 'internal', code } as const
    default:
      return { category: 'unknown', code: 'unknown' } as const
  }
}

export type AuthDiagnostic = ReturnType<typeof classifyAuthFailure>

// 有限のコードごとに1プロセスで毎分1件まで。APIの利用制限の代用ではない。
const lastLoggedAt = new Map<AuthDiagnostic['code'], number>()

export function reportAuthUnavailable(diagnostic: AuthDiagnostic): void {
  const now = Date.now()
  const previous = lastLoggedAt.get(diagnostic.code)
  if (previous !== undefined && now - previous < 60_000) return
  lastLoggedAt.set(diagnostic.code, now)
  console.error('auth_unavailable', diagnostic)
}
