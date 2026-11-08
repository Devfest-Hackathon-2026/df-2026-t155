import { describe, expect, it, vi } from 'vitest'

import { createSessionScope, SessionChangedError } from '@/lib/auth/session-scope'

import {
  InvalidLearningSelectionError,
  resolveSelectionForRequest,
  type ScopedLearningSelection,
} from './selection-scope'

// session-scope.tsが読み込むFirebase側は使わない。
vi.mock('@/lib/auth/client', () => ({ getAuthSnapshot: vi.fn() }))

const scopeA = createSessionScope('user-a', 0)
const scopeB = createSessionScope('user-b', 1)
const chosen = (scope = scopeA, value = [{ id: 'learning-rest', version: 2 }]) =>
  ({ scope, value }) satisfies ScopedLearningSelection

describe('生成リクエストへ選択を取り出す口', () => {
  it('選択時と同じセッションなら、{ id, version } だけを複製して返す', () => {
    const selection = chosen(scopeA, [
      { id: 'learning-rest', version: 2 },
      { id: 'learning-kyoto', version: 5 },
    ])
    const result = resolveSelectionForRequest(selection, scopeA)
    expect(result).toEqual([
      { id: 'learning-rest', version: 2 },
      { id: 'learning-kyoto', version: 5 },
    ])
    // 保持している選択を、取り出した値の変更で壊さない。
    result.pop()
    expect(selection.value).toHaveLength(2)
  })

  it('UIDと認証世代が同じなら、再作成したスコープでも同じセッションとして扱う', () => {
    expect(resolveSelectionForRequest(chosen(), createSessionScope('user-a', 0))).toEqual([
      { id: 'learning-rest', version: 2 },
    ])
  })

  it('同じUIDでも再認証世代が変わった選択は送信しない', () => {
    const returnedToA = createSessionScope('user-a', 2)
    expect(() => resolveSelectionForRequest(chosen(scopeA), returnedToA)).toThrow(
      SessionChangedError,
    )
  })

  it('UIDが変わっていれば、同じIDと版でも SessionChangedError にする（黙って別人の本文にしない）', () => {
    expect(() => resolveSelectionForRequest(chosen(scopeA), scopeB)).toThrow(SessionChangedError)
    // 逆向きも同じ。
    expect(() => resolveSelectionForRequest(chosen(scopeB), scopeA)).toThrow(SessionChangedError)
  })

  it('選択が空でも、別のセッションで選んだものなら失敗にする', () => {
    expect(() => resolveSelectionForRequest(chosen(scopeA, []), scopeB)).toThrow(
      SessionChangedError,
    )
  })

  it('選択なし（null / undefined）は、学びを使わないものとして空を返す', () => {
    expect(resolveSelectionForRequest(null, scopeA)).toEqual([])
    expect(resolveSelectionForRequest(undefined, scopeB)).toEqual([])
  })

  it('形式が不正な選択は送らない。セッションの違いを先に判定する', () => {
    const bad: unknown[] = [
      [{ id: 'x' }],
      [{ id: 'x', version: 0 }],
      [{ id: 'x', version: 1.5 }],
      [{ id: 'x', version: 1, extra: true }],
      [
        { id: 'x', version: 1 },
        { id: 'x', version: 2 },
      ],
      ['x'],
    ]
    for (const value of bad) {
      const selection = { scope: scopeA, value } as unknown as ScopedLearningSelection
      expect(() => resolveSelectionForRequest(selection, scopeA)).toThrow(
        InvalidLearningSelectionError,
      )
      expect(() => resolveSelectionForRequest(selection, scopeB)).toThrow(SessionChangedError)
    }
  })
})
