import type { ConstraintCheck, Evidence } from '../../domain'

// 候補を照合した結果（根拠）から、決定論的な制約検証の結果を導く純粋ロジック。
// 他の予定の時刻は動かさないため、次の予定が固定予定でも、「候補の終了＋移動時間 ≦ 次の予定の開始」で、
// 固定予定への到達も判定できる。

export interface CandidateChecks {
  identity: Evidence | null
  hours: Evidence | null
  // 前の予定 → 候補。対象が最初の予定なら、区間が無い（expectsTravelBefore=false）。
  // 区間が有るのに根拠がnullなのは、未測定（隣の施設を特定できない等）で、「確認できない」として扱う。
  expectsTravelBefore: boolean
  travelBefore: Evidence | null
  // 候補 → 次の予定。対象が最後の予定なら、区間が無い（expectsTravelAfter=false）。
  expectsTravelAfter: boolean
  travelAfter: Evidence | null
  // 時刻が重なる場合はRoutesを照会しないため、根拠の有無とは別に判定する。
  overlaps?: boolean
  uncertainties?: readonly string[]
}

export type CandidateViolation = 'hours' | 'travel' | 'overlap'

export type CandidateJudgement =
  | { status: 'excluded'; reason: 'unidentified'; explanation: string }
  | {
      status: 'excluded'
      reason: 'violated'
      violations: readonly CandidateViolation[]
      explanation: string
    }
  | { status: 'candidate'; constraintCheck: ConstraintCheck }

// 候補として残すかと、残す場合の制約検証の結果。
// - 施設を特定できない（候補なし・名称不一致・複数で絞れない・検索失敗）：実在を確認できないため、候補にしない。
// - 営業時間が矛盾、または前後どちらかの移動が間に合わない：成立しないため、候補にしない（violated）。
// - すべて「情報源と整合」：satisfied。それ以外（確認できない項目がある）：unknown（承認はできない）。
export function judgeCandidate(checks: CandidateChecks): CandidateJudgement {
  if (checks.identity?.status !== 'consistent') {
    return {
      status: 'excluded',
      reason: 'unidentified',
      explanation: '施設を特定できないため、候補にできません。',
    }
  }

  if (checks.overlaps) {
    return {
      status: 'excluded',
      reason: 'violated',
      violations: ['overlap'],
      explanation: '前後の予定と時刻が重なっているため、候補にできません。',
    }
  }

  const items = (
    [
      { kind: 'hours', label: '営業時間', evidence: checks.hours, expected: true },
      {
        kind: 'travel',
        label: '前の予定からの移動',
        evidence: checks.travelBefore,
        expected: checks.expectsTravelBefore,
      },
      {
        kind: 'travel',
        label: '次の予定への移動',
        evidence: checks.travelAfter,
        expected: checks.expectsTravelAfter,
      },
    ] as const
  ).filter((item) => item.expected || item.evidence !== null)

  const conflicting = items.filter((item) => item.evidence?.status === 'conflicting')
  if (conflicting.length > 0) {
    return {
      status: 'excluded',
      reason: 'violated',
      violations: [...new Set(conflicting.map((item) => item.kind))],
      explanation: `${conflicting.map((item) => item.label).join('・')}が成立しないため、候補にできません。`,
    }
  }

  // 営業時間は必須の確認項目。移動は、対象の位置によって、前後のどちらかが無いことがある。
  // 区間が有るのに根拠が無い項目（未測定）は、整合とは扱わない。
  const unverified = items.filter((item) => item.evidence?.status !== 'consistent')
  const uncertainties = checks.uncertainties ?? []
  if (unverified.length === 0 && uncertainties.length === 0) {
    return {
      status: 'candidate',
      constraintCheck: {
        status: 'satisfied',
        explanation: `${items.map((item) => item.label).join('・')}は、情報源と整合しています。臨時休業・渋滞・遅延は考慮していません。`,
      },
    }
  }
  const unverifiedItems = unverified.map((item) => item.label).join('・')
  return {
    status: 'candidate',
    constraintCheck: {
      status: 'unknown',
      explanation: `${unverifiedItems ? `${unverifiedItems}を確認できませんでした。` : ''}${uncertainties.join('')}確認できるまで、承認できません。`,
    },
  }
}
