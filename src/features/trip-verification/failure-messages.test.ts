import { describe, expect, it } from 'vitest'

import { verificationFailureGuidance } from './failure-messages'

describe('根拠の確認の失敗案内', () => {
  it('App Check不可は、認証不可・認証失敗・利用制限とは別の見出しで、旅程がそのままと伝える', () => {
    const titles = (
      ['app_check_unavailable', 'auth_required', 'unauthorized', 'rate_limited'] as const
    ).map((kind) => verificationFailureGuidance[kind].title)
    expect(new Set(titles).size).toBe(4)
    expect(verificationFailureGuidance.app_check_unavailable.action).toContain('旅程はそのまま')
  })
})
