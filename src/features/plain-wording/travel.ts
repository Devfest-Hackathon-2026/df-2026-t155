import type { TravelSegment } from '@/domain'

import { formatApproxDuration, formatCheckedAt, formatSpan } from './format'
import {
  CHANGE_WORDING,
  MODE_LABELS,
  TRAVEL_DEMO_SUFFIX,
  TRAVEL_ROUTES_CONFIRMED,
  TRAVEL_ROUTES_NOTE,
  TRAVEL_SIMULATION_NOTE,
  TRAVEL_UNKNOWN_NOTE,
  TRAVEL_UNKNOWN_WORDING,
  type Tone,
} from './wording'

export type TravelWording = {
  label: string
  detail: string
  // 照合・照会した時刻（照会を試みた場合だけ）。
  provenance?: string
  tone: Tone
}

// 移動区間を、利用者向けの言葉にする。数値は、構造化された値（durationMinutes）からだけ作り、
// 説明文（explanation）からは取り出さない。取得できていない値を、0分や推定値で補わない。
export function describeTravelSegment(segment: TravelSegment): TravelWording {
  if (segment.status === 'known') {
    const duration = `${MODE_LABELS[segment.mode]} ${formatApproxDuration(segment.durationMinutes)}`
    const provenance = `出典：${segment.source.label}／照合：${formatCheckedAt(segment.checkedAt)}`
    if (segment.source.kind === 'simulation') {
      return {
        label: `${duration}（${TRAVEL_DEMO_SUFFIX}）`,
        detail: TRAVEL_SIMULATION_NOTE,
        provenance,
        tone: 'demo',
      }
    }
    return {
      label: `${duration}（${TRAVEL_ROUTES_CONFIRMED}）`,
      detail: `${TRAVEL_ROUTES_CONFIRMED}しました。${TRAVEL_ROUTES_NOTE}`,
      provenance,
      tone: 'ok',
    }
  }
  const wording = TRAVEL_UNKNOWN_WORDING[segment.reason]
  return {
    label: wording.label,
    detail: TRAVEL_UNKNOWN_NOTE,
    ...(segment.checkedAt !== undefined
      ? { provenance: `照会：${formatCheckedAt(segment.checkedAt)}` }
      : {}),
    tone: wording.tone,
  }
}

export type ChangeKind = 'shorter' | 'longer' | 'same' | 'unconfirmed'

export type ChangeWording = {
  kind: ChangeKind
  label: string
  detail?: string
  // 比べられるときだけ（後－前。負なら短くなる）。比べられないときは持たない。
  deltaMinutes?: number
  tone: Tone
}

function unconfirmed(detail: string): ChangeWording {
  return { kind: 'unconfirmed', label: CHANGE_WORDING.unconfirmed, detail, tone: 'unknown' }
}

// 移動時間の前後の差。比較できる値（どちらも判明済みで、同じ区間・手段・確認方法）からだけ数値を出す。
// どちらかが未確認なら、差の数値を出さず「未確認」とする。
export function describeChange(before: TravelSegment, after: TravelSegment): ChangeWording {
  if (before.status !== 'known' || after.status !== 'known') {
    return unconfirmed(CHANGE_WORDING.unknownSegment)
  }
  if (before.fromStopId !== after.fromStopId || before.toStopId !== after.toStopId) {
    return unconfirmed(CHANGE_WORDING.differentSection)
  }
  if (before.mode !== after.mode) return unconfirmed(CHANGE_WORDING.differentMode)
  if (before.source.kind !== after.source.kind) return unconfirmed(CHANGE_WORDING.differentSource)

  const isDemo = before.source.kind === 'simulation'
  const delta = after.durationMinutes - before.durationMinutes
  const tone: Tone = isDemo ? 'demo' : 'ok'
  const suffix = isDemo ? `（${TRAVEL_DEMO_SUFFIX}）` : ''
  const detail = isDemo ? TRAVEL_SIMULATION_NOTE : TRAVEL_ROUTES_NOTE
  if (delta === 0) {
    return { kind: 'same', label: `${CHANGE_WORDING.same}${suffix}`, detail, deltaMinutes: 0, tone }
  }
  const kind: ChangeKind = delta < 0 ? 'shorter' : 'longer'
  const verb = delta < 0 ? '短くなる' : '長くなる'
  return {
    kind,
    label: `${formatSpan(Math.abs(delta))}${verb}${suffix}`,
    detail,
    deltaMinutes: delta,
    tone,
  }
}
