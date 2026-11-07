import type { Evidence, Stop } from '@/domain'
import { toMinutes } from '@/features/trip-map/model'

import type { TravelComparison, TravelSlot } from './api-client'

export function routesSegment(slot?: TravelSlot) {
  if (
    slot?.presence === 'segment' &&
    slot.segment.status === 'known' &&
    slot.segment.source.kind === 'routes'
  )
    return slot.segment
}

function checkableEvidence(evidence: Evidence, subject: Evidence['subject']) {
  if (evidence.subject !== subject) return false
  return subject === 'travel_time'
    ? evidence.source.kind === 'routes'
    : evidence.source.kind === 'places' || evidence.source.kind === 'official'
}

export function checkStopEvidence(stop: Stop, subject: 'place_identity' | 'opening_hours') {
  const evidence = stop.evidence.filter((item) => checkableEvidence(item, subject))
  if (evidence.some(({ status }) => status === 'conflicting'))
    return { status: 'conflicting' } as const
  const consistent = evidence.find(({ status }) => status === 'consistent')
  if (consistent && evidence.every(({ status }) => status === 'consistent')) {
    return { status: 'consistent', checkedAt: consistent.checkedAt } as const
  }
  return { status: 'unverifiable' } as const
}

// 同一日の旅程内の時刻を分単位で照合する。空欄・模擬データは移動時間の証明に使わない。
export function checkCandidate(
  candidate: Stop,
  previous?: Stop,
  next?: Stop,
  comparison?: TravelComparison,
) {
  const legs = [
    { from: previous, to: candidate, slot: comparison?.after.fromPrevious },
    { from: candidate, to: next, slot: comparison?.after.toNext },
  ]
  let hasUnknownTravel = false
  for (const { from, to, slot } of legs) {
    if (!from || !to) continue
    const available =
      toMinutes(to.plannedStartTime) - toMinutes(from.plannedStartTime) - from.durationMinutes
    const segment = routesSegment(slot)
    if (available < 0 || (segment && segment.durationMinutes > available)) {
      return {
        status: 'violated',
        explanation: '前後の予定を動かさずに移動・滞在できる時間を超えています。',
      } as const
    }
    if (!segment) hasUnknownTravel = true
  }

  const identity = checkStopEvidence(candidate, 'place_identity').status
  const hours = checkStopEvidence(candidate, 'opening_hours').status
  const travel = candidate.evidence.filter((item) => checkableEvidence(item, 'travel_time'))
  if (
    identity === 'conflicting' ||
    hours === 'conflicting' ||
    travel.some(({ status }) => status === 'conflicting')
  ) {
    return {
      status: 'violated',
      explanation: '施設・営業時間・移動について、候補と情報源の内容に矛盾があります。',
    } as const
  }
  if (
    !candidate.placeId ||
    identity !== 'consistent' ||
    hours !== 'consistent' ||
    hasUnknownTravel ||
    travel.some(({ status }) => status === 'unverifiable')
  ) {
    return {
      status: 'unknown',
      explanation: '施設・営業時間・前後の移動に確認できていない項目があります。',
    } as const
  }
  return { status: 'satisfied' } as const
}

// 同じ項目の再照合日時は更新できる。承認時の裏付けの欠落・差し替えや、新たな懸念を成功と扱わない。
export function retainsApprovedEvidence(approved: Stop, applied: Stop) {
  const matches = (left: Evidence, right: Evidence) =>
    left.subject === right.subject &&
    left.status === right.status &&
    left.source.kind === right.source.kind &&
    left.source.label === right.source.label &&
    left.source.url === right.source.url &&
    left.claim === right.claim &&
    left.applicability === right.applicability
  return (
    approved.evidence.every(
      (item) =>
        item.status !== 'consistent' || applied.evidence.some((current) => matches(item, current)),
    ) &&
    applied.evidence.every(
      (item) =>
        item.status === 'consistent' ||
        approved.evidence.some((original) => matches(item, original)),
    )
  )
}
