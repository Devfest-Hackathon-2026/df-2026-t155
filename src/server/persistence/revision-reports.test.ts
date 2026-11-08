import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore'
import { describe, expect, it, vi } from 'vitest'

import type { Actor } from '@/lib/auth/server'

import { REVISION_LIMIT } from './limits'
import { readReportStates } from './revision-reports'

const actor: Actor = { uid: 'owner-a' }
const trip = { id: 'trip-a', stops: [] }

describe('旧Tripの報告状態を復元する際の操作期限', () => {
  it('先行するTrip読取の間に期限切れとなったら、追加のRevisionクエリを開始しない', async () => {
    const collection = vi.fn()
    const snapshot = {
      get: vi.fn(() => undefined),
      ref: { collection },
    } as unknown as DocumentSnapshot
    let active = true
    const get = vi.fn(async () => {
      // 先行するTrip読取が完了した時点で操作期限を迎える。
      active = false
      return snapshot
    })
    const transaction = { get } as unknown as Transaction
    const firstSnapshot = await get()
    const assertActive = vi.fn(() => {
      if (!active) throw new Error('operation is no longer active')
    })

    await expect(
      readReportStates(transaction, actor, firstSnapshot, trip, assertActive),
    ).rejects.toThrow('operation is no longer active')
    expect(assertActive).toHaveBeenCalledOnce()
    expect(collection).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledOnce()
  })

  it('期限内の旧Tripでは、追加のRevisionクエリを実行して復元できる', async () => {
    const query = { kind: 'revision-query' }
    const limit = vi.fn(() => query)
    const snapshot = {
      get: vi.fn(() => undefined),
      ref: { collection: vi.fn(() => ({ limit })) },
    } as unknown as DocumentSnapshot
    const get = vi.fn(async () => ({ size: 0, docs: [] }))
    const assertActive = vi.fn()

    const result = await readReportStates(
      { get } as unknown as Transaction,
      actor,
      snapshot,
      trip,
      assertActive,
    )

    expect(result).toEqual([])
    expect(assertActive).toHaveBeenCalledOnce()
    expect(limit).toHaveBeenCalledWith(REVISION_LIMIT + 1)
    expect(get).toHaveBeenCalledExactlyOnceWith(query)
  })

  it('報告状態を保存済みのTripでは、余計な期限確認や追加クエリを行わない', async () => {
    const collection = vi.fn()
    const snapshot = {
      get: vi.fn(() => []),
      ref: { collection },
    } as unknown as DocumentSnapshot
    const get = vi.fn()
    const assertActive = vi.fn()

    const transaction = { get } as unknown as Transaction
    const result = await readReportStates(transaction, actor, snapshot, trip, assertActive)

    expect(result).toEqual([])
    expect(assertActive).not.toHaveBeenCalled()
    expect(collection).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })
})
