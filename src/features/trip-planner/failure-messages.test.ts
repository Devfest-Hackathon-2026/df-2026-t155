import { describe, expect, it } from 'vitest'

import { failureGuidance } from './failure-messages'

describe('旅程生成の失敗案内', () => {
  it('認証・利用制限・送信不可・サービス停止を、それぞれ別の見出しで案内し、入力が残ることを伝える', () => {
    const kinds = [
      'unauthorized',
      'rate_limited',
      'auth_required',
      'app_check_unavailable',
      'service_unavailable',
    ] as const
    const titles = kinds.map((kind) => failureGuidance[kind].title)
    expect(new Set(titles).size).toBe(kinds.length)
    for (const kind of kinds.slice(0, 4)) {
      expect(failureGuidance[kind].action).toContain('入力内容はそのまま')
    }
  })
})
