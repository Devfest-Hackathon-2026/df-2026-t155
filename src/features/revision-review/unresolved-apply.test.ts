// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearApplyUnresolved,
  markApplyUnresolved,
  readUnresolvedApply,
  unresolvedApplyStorageKey,
} from './unresolved-apply'

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('結果不明の適用をブラウザ更新後も保持する', () => {
  it('フルリロード相当のモジュール再初期化後も、対象Revisionのロックが復元される', async () => {
    markApplyUnresolved('owner-A', 'trip-A', 0, 'revision-A')
    vi.resetModules()
    const reloaded = await import('./unresolved-apply')
    expect(reloaded.readUnresolvedApply('owner-A', 'trip-A')).toEqual({
      status: 'pending',
      value: { baseVersion: 0, revisionId: 'revision-A' },
    })
    expect(reloaded.readUnresolvedApply('owner-B', 'trip-A')).toEqual({ status: 'clear' })
    expect(reloaded.readUnresolvedApply('owner-A', 'trip-B')).toEqual({ status: 'clear' })
  })

  it('別UID・別Tripを分離し、対象Revisionが違うと誤って解除しない', () => {
    markApplyUnresolved('owner-A', 'trip-A', 3, 'revision-A')
    expect(() => clearApplyUnresolved('owner-A', 'trip-A', 'revision-other')).toThrow()
    expect(readUnresolvedApply('owner-A', 'trip-A').status).toBe('pending')
    clearApplyUnresolved('owner-A', 'trip-A', 'revision-A')
    expect(readUnresolvedApply('owner-A', 'trip-A')).toEqual({ status: 'clear' })
  })

  it('保存内容が壊れている場合は未確認扱いとし、再操作を許可しない', () => {
    window.localStorage.setItem(unresolvedApplyStorageKey('owner-A', 'trip-A'), '{broken')
    expect(readUnresolvedApply('owner-A', 'trip-A')).toEqual({ status: 'unavailable' })
    expect(() => markApplyUnresolved('owner-A', 'trip-A', 0, 'revision-B')).toThrow()
  })

  it('ストレージの書込失敗時にapply用の記録成功を返さない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(() => markApplyUnresolved('owner-A', 'trip-A', 0, 'revision-A')).toThrow(
      '適用を開始しませんでした',
    )
    expect(readUnresolvedApply('owner-A', 'trip-A')).toEqual({ status: 'clear' })
  })

  it('ストレージの読取失敗を記録なしとみなさない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage inaccessible')
    })
    expect(readUnresolvedApply('owner-A', 'trip-A')).toEqual({ status: 'unavailable' })
    expect(() => markApplyUnresolved('owner-A', 'trip-A', 0, 'revision-A')).toThrow()
  })

  it('保存済みの記録が残る間は別候補で上書きできない', () => {
    markApplyUnresolved('owner-A', 'trip-A', 0, 'revision-A')
    expect(() => markApplyUnresolved('owner-A', 'trip-A', 0, 'revision-B')).toThrow()
    expect(readUnresolvedApply('owner-A', 'trip-A')).toEqual({
      status: 'pending',
      value: { baseVersion: 0, revisionId: 'revision-A' },
    })
  })
})
