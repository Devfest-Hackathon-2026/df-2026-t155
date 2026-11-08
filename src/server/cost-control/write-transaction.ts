import 'server-only'

import type { Transaction } from 'firebase-admin/firestore'

export type WriteTransaction = <T>(action: (transaction: Transaction) => Promise<T>) => Promise<T>

export class WriteFenceError extends Error {
  constructor(readonly code: 'lease_lost' | 'write_result_unknown') {
    super(code)
    this.name = 'WriteFenceError'
  }
}
