import type { Transaction } from 'firebase-admin/firestore'
import { vi } from 'vitest'

import { WriteFenceError } from '@/server/cost-control/write-transaction'

// mock-cost-control.ts に加えて、コミットを始めた後の失敗を結果不明（write_result_unknown）として返す。
// 共有枠の判定は許可で固定し、業務取引は本物と同じく、ステージ後の失敗を再実行せず区別する。
// 競合による再試行は既定のまま（再試行の度にステージ済みの印を戻す）。
vi.mock('@/server/cost-control/eligibility', () => ({ checkEligibility: async () => null }))
vi.mock('@/server/cost-control/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/cost-control/store')>()),
  reserveCost: async () => ({
    kind: 'allowed',
    workAvailableMs: 150_000,
    release: async () => undefined,
    revokeWrite: async () => undefined,
    async write<T>(assertActive: () => void, action: (tx: Transaction) => Promise<T>): Promise<T> {
      assertActive()
      const { getAdminFirestore } = await import('@/lib/firebase/admin')
      let staged = false
      try {
        return await getAdminFirestore().runTransaction(async (transaction) => {
          staged = false
          const result = await action(transaction)
          staged = true
          return result
        })
      } catch (error) {
        if (staged) throw new WriteFenceError('write_result_unknown')
        throw error
      }
    },
  }),
}))
