import { z } from 'zod'

import { TripSchema, type Trip } from '@/domain'
import {
  ManualApplyBodySchema,
  ManualRevisionGrantSchema,
  type ManualApplyBody,
} from '@/domain/manual-revision'
import { SavedRevisionSchema } from '@/server/persistence/contracts'
import { sameStop } from './api-client'

// 未確認の適用を本人UID・Trip ID別に端末へ保存する。通信前に記録できないなら適用を始めない。
// in-memory Mapではブラウザのフルリロードでロックが失われるため、永続記録を正本にする。
const STORAGE_PREFIX = 'groundtrip:unresolved-apply:v1:'
const LOCK_CHANGED = 'groundtrip:apply-lock-changed'
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

const ManualReplaySchema = z.strictObject({
  id: ManualRevisionGrantSchema.shape.id,
  body: ManualApplyBodySchema,
})

function manualReplayKey(ownerUid: string, tripId: string) {
  return unresolvedApplyStorageKey(ownerUid, tripId) + ':manual-replay'
}

export function isManualApply(pending: UnresolvedApply) {
  return ManualRevisionGrantSchema.shape.id.safeParse(pending.revisionId).success
}

// 再読み込み後も、同じタブでは承認時の本文をそのまま再送する。
export function rememberManualApply(
  ownerUid: string,
  tripId: string,
  id: string,
  body: ManualApplyBody,
) {
  const value = JSON.stringify(ManualReplaySchema.parse({ id, body }))
  const key = manualReplayKey(ownerUid, tripId)
  window.sessionStorage.setItem(key, value)
  if (window.sessionStorage.getItem(key) !== value) throw new Error('manual request not stored')
}

export function readManualReplay(ownerUid: string, tripId: string, pending: UnresolvedApply) {
  try {
    const raw = window.sessionStorage.getItem(manualReplayKey(ownerUid, tripId))
    if (!raw) return
    const entry = ManualReplaySchema.safeParse(JSON.parse(raw))
    if (
      entry.success &&
      entry.data.id === pending.revisionId &&
      entry.data.body.expectedVersion === pending.baseVersion
    ) {
      return entry.data.body
    }
  } catch {
    // 本文を復元できないときは照会と取り消しを使える。
  }
}

// storageイベントは書き込んだタブに届かないため、同じ画面内の旅行前・旅行中にも変更を通知する。
export function subscribeApplyLock(ownerUid: string, tripId: string, onChange: () => void) {
  const key = unresolvedApplyStorageKey(ownerUid, tripId)
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) onChange()
  }
  const onLocalChange = (event: Event) => {
    if (event instanceof CustomEvent && event.detail === key) onChange()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(LOCK_CHANGED, onLocalChange)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(LOCK_CHANGED, onLocalChange)
  }
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
  window.dispatchEvent(
    new CustomEvent(LOCK_CHANGED, { detail: unresolvedApplyStorageKey(ownerUid, tripId) }),
  )
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
  if (isManualApply(current.value)) {
    try {
      window.sessionStorage.removeItem(manualReplayKey(ownerUid, tripId))
    } catch {
      // 再送には現在の永続ロックも必要。解除後の本文は送信できない。
    }
  }
  window.dispatchEvent(
    new CustomEvent(LOCK_CHANGED, { detail: unresolvedApplyStorageKey(ownerUid, tripId) }),
  )
}

export type LatestTripVerdict = { kind: 'applied'; trip: Trip } | { kind: 'unverified' }

export type ManualRecoveryAction = 'retry' | 'cancel'
export type RecoveryVerdict = LatestTripVerdict | { kind: 'not_applied'; trip: Trip }
export type RecoverManualApply = (
  tripId: string,
  pending: UnresolvedApply,
  action: ManualRecoveryAction,
  signal: AbortSignal,
) => Promise<RecoveryVerdict>

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
  if ('method' in revision.data && trip.data.version === baseVersion + 1) {
    const stop = trip.data.stops.find(({ id }) => id === revision.data.targetStopId)
    if (!stop || !sameStop(stop, revision.data.diff.after)) return { kind: 'unverified' }
  }
  return { kind: 'applied', trip: trip.data }
}
