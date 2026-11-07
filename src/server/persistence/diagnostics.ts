import 'server-only'

import { FirebaseConfigurationError } from '@/lib/firebase/config'

import { LearningStoreError } from '../learnings/store'
import { PersistenceError } from './errors'

type DiagnosticCode =
  | 'firebase_configuration'
  | 'firestore_credentials'
  | 'firestore_permission'
  | 'firestore_database'
  | 'firestore_capacity'
  | 'firestore_unavailable'
  | 'firestore_internal'
  | 'stored_document_invalid'
  | 'learning_not_approved'
  | 'learning_invalid_owner'
  | 'unexpected'

function classifyStorageFailure(error: unknown): DiagnosticCode | undefined {
  if (error instanceof FirebaseConfigurationError) return 'firebase_configuration'
  // ADCの初期化はgRPCの外でも失敗する。既知の文言は分類だけに使う。
  if (
    error instanceof Error &&
    /(?:^|Getting metadata from plugin failed with error: )Could not load the default credentials\./.test(
      error.message,
    )
  ) {
    return 'firestore_credentials'
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  // Firestore SDKのgRPCステータス。生のcodeやメッセージはログに載せない。
  switch (code) {
    case 16: // UNAUTHENTICATED
    case 'app/invalid-credential':
      return 'firestore_credentials'
    case 7: // PERMISSION_DENIED
      return 'firestore_permission'
    case 5: // NOT_FOUND（文書が存在しない場合、getは空のスナップショットを返す）
    case 9: // FAILED_PRECONDITION
      return 'firestore_database'
    case 8: // RESOURCE_EXHAUSTED
      return 'firestore_capacity'
    case 4: // DEADLINE_EXCEEDED
    case 10: // ABORTED（SDKによる再試行後）
    case 14: // UNAVAILABLE
      return 'firestore_unavailable'
    case 2: // UNKNOWN
    case 13: // INTERNAL
      return 'firestore_internal'
  }
}

const lastLoggedAt = new Map<DiagnosticCode, number>()

export function reportPersistenceFailure(code: DiagnosticCode): void {
  const now = Date.now()
  const previous = lastLoggedAt.get(code)
  if (previous !== undefined && now - previous < 60_000) return
  lastLoggedAt.set(code, now)
  console.error('persistence_failure', { code })
}

export function diagnosePersistenceFailure(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) {
    if (error.code === 'invalid_stored_data') reportPersistenceFailure('stored_document_invalid')
    return error
  }
  if (error instanceof LearningStoreError) {
    if (error.code === 'version_conflict') return new PersistenceError('version_conflict')
    reportPersistenceFailure(
      error.code === 'not_approved' ? 'learning_not_approved' : 'learning_invalid_owner',
    )
    return new PersistenceError('internal_error')
  }
  const code = classifyStorageFailure(error)
  reportPersistenceFailure(code ?? 'unexpected')
  return new PersistenceError(code ? 'storage_unavailable' : 'internal_error')
}
