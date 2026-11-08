import type { Transaction } from 'firebase-admin/firestore'
import { vi } from 'vitest'

// 既存の認証・業務ロジック単独のテスト用。統合テストでは本物の共有ストアを使用する。
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
      return getAdminFirestore().runTransaction(action)
    },
  }),
}))
