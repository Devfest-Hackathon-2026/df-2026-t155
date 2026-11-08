import { z } from 'zod'

import { TripSchema, type Trip } from '@/domain'
import { SavedRevisionSchema } from '@/server/persistence/contracts'

// 未確認の適用を本人UID・Trip ID別に端末へ保存する。通信前に記録できないなら適用を始めない。
// in-memory Mapではブラウザのフルリロードでロックが失われるため、永続記録を正本にする。
const STORAGE_PREFIX = 'groundtrip:unresolved-apply:v1:'
const PendingSchema = z.strictObject({
  baseVersion: z.int().nonnegative(),
  revisionId: z.string().min(1).max(256),
})

export type UnresolvedApply = Readonly<z.infer<typeof PendingSchema>>
export type UnresolvedApplyState =
  { status: 'clear' } | { status: 'pending'; value: UnresolvedApply } | { status: 'unavailable' }

export function unresolvedApplyStorageKey(ownerUid: string, tripId: string): string {
  return STORAGE_PREFIX + encodeURIComponent(ownerUid) + ':' + encodeURIComponent(tripId)
}

// 保存先の読取失敗・破損・認証UID不明は「記録なし」ではない。再操作を許可しない。
export function readUnresolvedApply(
  ownerUid: string | null | undefined,
  tripId: string,
): UnresolvedApplyState {
  if (!ownerUid?.trim() || !tripId.trim() || typeof window === 'undefined') {
    return { status: 'unavailable' }
  }
  try {
    const raw = window.localStorage.getItem(unresolvedApplyStorageKey(ownerUid, tripId))
    if (raw === null) return { status: 'clear' }
    const parsed = PendingSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return { status: 'unavailable' }
    return { status: 'pending', value: parsed.data }
  } catch {
    return { status: 'unavailable' }
  }
}

// applyのHTTP送信より前に同期的に書き込む。書込失敗を握りつぶして送信してはならない。
export function markApplyUnresolved(
  ownerUid: string,
  tripId: string,
  baseVersion: number,
  revisionId: string,
): UnresolvedApply {
  const pending = PendingSchema.parse({ baseVersion, revisionId })
  if (readUnresolvedApply(ownerUid, tripId).status !== 'clear') {
    throw new Error('未確認の適用状態を確認できないため、再操作できません。')
  }
  const serialized = JSON.stringify(pending)
  try {
    const key = unresolvedApplyStorageKey(ownerUid, tripId)
    window.localStorage.setItem(key, serialized)
    if (window.localStorage.getItem(key) !== serialized) throw new Error('write not persisted')
  } catch {
    throw new Error('未確認の適用状態を保存できないため、適用を開始しませんでした。')
  }
  return pending
}

// 対象Revisionの確定結果が得られた場合だけ削除する。別の候補の記録は消さない。
export function clearApplyUnresolved(ownerUid: string, tripId: string, revisionId: string): void {
  const current = readUnresolvedApply(ownerUid, tripId)
  if (current.status === 'unavailable') {
    throw new Error('未確認状態を読み取れません。再操作はできません。')
  }
  if (current.status === 'clear') return
  if (current.value.revisionId !== revisionId) {
    throw new Error('別の候補の未確認状態は解除できません。')
  }
  try {
    window.localStorage.removeItem(unresolvedApplyStorageKey(ownerUid, tripId))
  } catch {
    throw new Error('未確認状態を解除できませんでした。')
  }
  if (readUnresolvedApply(ownerUid, tripId).status !== 'clear') {
    throw new Error('未確認状態の解除を確認できませんでした。')
  }
}

export type LatestTripVerdict = { kind: 'applied'; trip: Trip } | { kind: 'unverified' }

// 同じ版のGETは遅延コミットを否定せず、版増加も別の更新かもしれない。
// 対象Revisionの承認記録と版が揃った場合だけ、適用済みと確認する。
export function judgeLatestTrip(
  tripId: string,
  baseVersion: number,
  revisionId: string,
  latest: unknown,
  savedRevision: unknown,
): LatestTripVerdict {
  const trip = TripSchema.safeParse(latest)
  const revision = SavedRevisionSchema.safeParse(savedRevision)
  if (!trip.success || !revision.success) return { kind: 'unverified' }
  if (
    trip.data.id !== tripId ||
    trip.data.version <= baseVersion ||
    revision.data.id !== revisionId ||
    revision.data.tripId !== tripId ||
    revision.data.baseTripVersion !== baseVersion ||
    revision.data.approval.status !== 'approved'
  )
    return { kind: 'unverified' }
  return { kind: 'applied', trip: trip.data }
}
