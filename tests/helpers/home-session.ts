import { createSessionScope, type SessionScope } from '@/lib/auth/session-scope'
import type { LearningLoadResult } from '@/features/learning-reuse/api-client'

// トップ画面（HomePlanner）のテストで、認証済みの利用者と「保存済みの学びなし」を用意するための部品。
// 認証SDKは使わない。useSessionScope をモックし、固定のスコープを返す。
//
// 使い方（テストファイルの先頭）：
//   vi.mock('@/lib/auth/use-session-scope', async () => (await import('...home-session')).sessionScopeModule)
export const homeScope: SessionScope = createSessionScope('user-1', 0)

export const sessionScopeModule = {
  useSessionScope: () => ({
    status: 'authenticated' as const,
    scope: homeScope,
    scopeEpoch: 0,
  }),
}

// 保存済みの学びがない利用者。取得したセッションと組で返す（本物のapi-clientと同じ形）。
export const noSavedLearnings = async (scope: SessionScope): Promise<LearningLoadResult> => ({
  ok: true,
  learnings: { scope, value: [] },
})
