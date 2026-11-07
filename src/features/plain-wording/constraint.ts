import type { ConstraintCheck, TravelMode } from '@/domain'

import {
  CONSTRAINT_CHECKED_ITEMS,
  CONSTRAINT_CHECKED_SUFFIX,
  CONSTRAINT_CHECKED_UNKNOWN_SCOPE,
  CONSTRAINT_MODES_PREFIX,
  CONSTRAINT_NOT_CONSIDERED,
  CONSTRAINT_SATISFIED_LABELS,
  CONSTRAINT_UNKNOWN_LABELS,
  CONSTRAINT_WORDING,
  MODE_LABELS,
  MODES_UNSPECIFIED,
  REASON_PREFIX,
  type Tone,
} from './wording'

// 検証の範囲を表す文脈。ConstraintCheckの判定そのものは変えず、言葉にするためだけに使う。
// 省略した項目は「分からない」として扱い、検証したとは書かない。
export type ConstraintContext = {
  // 検証に使った移動手段（例：['walk']）。渡されたときだけ書く。
  travelModes?: readonly TravelMode[]
  // 営業時間を検証したか。
  checkedOpeningHours?: boolean
  // 前の予定からの移動区間を検証したか（最初の予定ならfalse）。
  hasPreviousSegment?: boolean
  // 次の予定への移動区間を検証したか（最後の予定ならfalse）。
  hasNextSegment?: boolean
  // 次の予定が固定予定か。
  nextStopIsFixed?: boolean
}

export type ConstraintWording = {
  label: string
  detail: string
  tone: Tone
  // 承認できる案として出してよいか。satisfiedだけがtrue。本人の承認そのものではない。
  canApprove: boolean
}

export function describeTravelModes(modes: readonly TravelMode[] | undefined): string {
  const unique = [...new Set(modes ?? [])]
  if (unique.length === 0) return MODES_UNSPECIFIED
  const labels = unique.map((mode) => MODE_LABELS[mode])
  return unique.length === 1 ? `${labels[0]}のみ` : labels.join('・')
}

function satisfiedLabel(context: ConstraintContext): string {
  if (context.hasNextSegment === true) {
    return context.nextStopIsFixed === true
      ? CONSTRAINT_SATISFIED_LABELS.nextFixed
      : CONSTRAINT_SATISFIED_LABELS.nextStop
  }
  // 次の移動区間が無い（最後の予定）ときは、移動に触れない。
  if (context.hasNextSegment === false && context.checkedOpeningHours === true) {
    return CONSTRAINT_SATISFIED_LABELS.withOpeningHours
  }
  return CONSTRAINT_SATISFIED_LABELS.generic
}

function satisfiedDetail(context: ConstraintContext): string {
  const items: string[] = []
  if (context.checkedOpeningHours === true) items.push(CONSTRAINT_CHECKED_ITEMS.openingHours)
  if (context.hasPreviousSegment === true) items.push(CONSTRAINT_CHECKED_ITEMS.previousSegment)
  if (context.hasNextSegment === true) items.push(CONSTRAINT_CHECKED_ITEMS.nextSegment)
  const scope =
    items.length > 0
      ? `${items.join('、')}${CONSTRAINT_CHECKED_SUFFIX}`
      : CONSTRAINT_CHECKED_UNKNOWN_SCOPE
  const modes =
    context.travelModes && context.travelModes.length > 0
      ? `${CONSTRAINT_MODES_PREFIX}${describeTravelModes(context.travelModes)}。`
      : ''
  return [scope, modes, CONSTRAINT_NOT_CONSIDERED].filter((part) => part !== '').join('')
}

function unknownLabel(context: ConstraintContext): string {
  if (context.hasNextSegment === true) return CONSTRAINT_UNKNOWN_LABELS.withNextSegment
  if (context.hasPreviousSegment === true) return CONSTRAINT_UNKNOWN_LABELS.withMovement
  return CONSTRAINT_UNKNOWN_LABELS.generic
}

// 制約判定（決定論的な検証の結果）を、利用者向けの言葉にする。根拠の照合や本人の承認とは別。
// 判定は再計算せず、渡された状態を言葉にするだけ。「間に合う見込み」は、satisfiedで
// 次の移動区間を検証したと文脈で分かるときだけ使う。
export function describeConstraint(
  check: Pick<ConstraintCheck, 'status' | 'explanation'>,
  context: ConstraintContext = {},
): ConstraintWording {
  switch (check.status) {
    case 'satisfied': {
      const wording = CONSTRAINT_WORDING.satisfied
      return {
        label: satisfiedLabel(context),
        detail: satisfiedDetail(context),
        tone: wording.tone,
        canApprove: wording.canApprove,
      }
    }
    case 'violated': {
      const wording = CONSTRAINT_WORDING.violated
      return {
        label: wording.label,
        detail: `${REASON_PREFIX}${check.explanation} ${wording.detail}`,
        tone: wording.tone,
        canApprove: wording.canApprove,
      }
    }
    case 'unknown': {
      const wording = CONSTRAINT_WORDING.unknown
      return {
        label: unknownLabel(context),
        detail: `${wording.detail} ${REASON_PREFIX}${check.explanation}`,
        tone: wording.tone,
        canApprove: wording.canApprove,
      }
    }
    case 'not_checked': {
      const wording = CONSTRAINT_WORDING.not_checked
      return {
        label: wording.label,
        detail: wording.detail,
        tone: wording.tone,
        canApprove: wording.canApprove,
      }
    }
  }
}
