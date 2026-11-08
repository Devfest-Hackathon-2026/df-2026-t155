import type { Evidence, EvidenceStatus, Trip } from '@/domain'
import { isGoogleSource } from '@/features/trip-map/model'

// 照合した項目。照合APIが確認の対象にしているのは、この3つだけ（臨時休業・混雑・公共交通は対象外）。
export const verifiedSubjects = ['place_identity', 'opening_hours', 'travel_time'] as const
export type VerifiedSubject = (typeof verifiedSubjects)[number]

export type StatusCounts = Record<EvidenceStatus, number>

export interface VerificationSummary {
  // Places・Routes（Google Maps Platform）で照合した根拠。件数の単位は根拠（予定の数ではない）。
  google: {
    counts: StatusCounts
    total: number
    // 照合日時の範囲（根拠がなければnull）。
    latestCheckedAt: string | null
    earliestCheckedAt: string | null
    // 項目ごとの件数。0件の項目は「照合していない」項目。
    bySubject: Record<VerifiedSubject, number>
  }
  // 公式情報・本人の報告・模擬データ由来の根拠の数。照合（Places・Routes）の結果ではない。
  otherTotal: number
}

const time = (value: string) => new Date(value).getTime()

function isVerifiedSubject(subject: Evidence['subject']): subject is VerifiedSubject {
  return (verifiedSubjects as readonly string[]).includes(subject)
}

export function summarizeVerification(trip: Trip): VerificationSummary {
  const counts: StatusCounts = { consistent: 0, conflicting: 0, unverifiable: 0 }
  const bySubject: Record<VerifiedSubject, number> = {
    place_identity: 0,
    opening_hours: 0,
    travel_time: 0,
  }
  let latest: string | null = null
  let earliest: string | null = null
  let otherTotal = 0
  for (const stop of trip.stops) {
    for (const item of stop.evidence) {
      if (!isGoogleSource(item.source.kind)) {
        otherTotal += 1
        continue
      }
      counts[item.status] += 1
      if (isVerifiedSubject(item.subject)) bySubject[item.subject] += 1
      if (!latest || time(item.checkedAt) > time(latest)) latest = item.checkedAt
      if (!earliest || time(item.checkedAt) < time(earliest)) earliest = item.checkedAt
    }
  }
  return {
    google: {
      counts,
      total: counts.consistent + counts.conflicting + counts.unverifiable,
      latestCheckedAt: latest,
      earliestCheckedAt: earliest,
      bySubject,
    },
    otherTotal,
  }
}
