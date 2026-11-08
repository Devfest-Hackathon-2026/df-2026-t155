import { describe, expect, it } from 'vitest'

import { createSessionScope } from '@/lib/auth/session-scope'

import { bind, valueIn, type HeldSession } from './session-bound'

const held = (uid: string, epoch: number): HeldSession => ({
  scope: createSessionScope(uid, epoch),
  epoch,
})

describe('取得した結果とセッションの結び付き', () => {
  it('取得したセッションの画面では、結果が見える', () => {
    const session = held('user-a', 0)
    expect(valueIn(bind(session, 'データ'), session)).toBe('データ')
  })

  it('UIDが同じで別のスコープ参照（同じUIDの再通知）でも、世代が同じなら見える', () => {
    expect(valueIn(bind(held('user-a', 0), 'データ'), held('user-a', 0))).toBe('データ')
  })

  it('UIDが違えば、世代が同じでも見えない', () => {
    expect(valueIn(bind(held('user-a', 0), 'データ'), held('user-b', 0))).toBeUndefined()
  })

  it('UIDが同じでも世代が違えば（A→B→Aと戻った後）、最初のAの結果は見えない', () => {
    expect(valueIn(bind(held('user-a', 0), 'データ'), held('user-a', 2))).toBeUndefined()
  })

  it('結果が無い、またはセッションが無いときは、何も見えない', () => {
    expect(valueIn(null, held('user-a', 0))).toBeUndefined()
    expect(valueIn(bind(held('user-a', 0), 'データ'), null)).toBeUndefined()
  })
})
