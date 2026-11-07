import { describe, expect, it } from 'vitest'

import type { Evidence } from '../../domain'
import { judgeCandidate, type CandidateChecks } from './constraints'

const evidenceOf = (status: Evidence['status']): Evidence => ({
  id: `evidence-${status}`,
  subject: 'other',
  claim: '確認する内容',
  applicability: '2026-11-08',
  source: { kind: 'places', label: '情報源' },
  checkedAt: '2026-11-07T12:00:00+09:00',
  status,
  explanation: '説明',
})

const consistent = evidenceOf('consistent')

const checks = (overrides: Partial<CandidateChecks> = {}): CandidateChecks => ({
  identity: consistent,
  hours: consistent,
  expectsTravelBefore: true,
  travelBefore: consistent,
  expectsTravelAfter: true,
  travelAfter: consistent,
  ...overrides,
})

describe('judgeCandidate: 区間が必要なのに根拠が無い（未測定）場合', () => {
  it('すべて整合なら satisfied', () => {
    expect(judgeCandidate(checks())).toMatchObject({
      status: 'candidate',
      constraintCheck: { status: 'satisfied' },
    })
  })

  it('次の予定への区間が必要なのに根拠が無ければ unknown（説明に「次の予定への移動」を含む）', () => {
    const result = judgeCandidate(checks({ travelAfter: null }))

    expect(result).toMatchObject({ status: 'candidate', constraintCheck: { status: 'unknown' } })
    if (result.status !== 'candidate') throw new Error('候補を期待しました')
    expect(result.constraintCheck.explanation).toContain('次の予定への移動')
    expect(result.constraintCheck.explanation).not.toContain('前の予定からの移動')
  })

  it('前の予定からの区間が必要なのに根拠が無ければ unknown（説明に「前の予定からの移動」を含む）', () => {
    const result = judgeCandidate(checks({ travelBefore: null }))

    expect(result).toMatchObject({ status: 'candidate', constraintCheck: { status: 'unknown' } })
    if (result.status !== 'candidate') throw new Error('候補を期待しました')
    expect(result.constraintCheck.explanation).toContain('前の予定からの移動')
  })

  it('区間が無い（最初・最後の予定）なら、根拠が無くても satisfied', () => {
    expect(
      judgeCandidate(checks({ expectsTravelBefore: false, travelBefore: null })),
    ).toMatchObject({ status: 'candidate', constraintCheck: { status: 'satisfied' } })
    expect(judgeCandidate(checks({ expectsTravelAfter: false, travelAfter: null }))).toMatchObject({
      status: 'candidate',
      constraintCheck: { status: 'satisfied' },
    })
  })

  it('矛盾（conflicting）があれば、別の区間が未測定でも除外する', () => {
    expect(
      judgeCandidate(checks({ hours: evidenceOf('conflicting'), travelAfter: null })),
    ).toMatchObject({ status: 'excluded', reason: 'violated' })
  })

  it('施設を特定できなければ、候補にしない', () => {
    expect(judgeCandidate(checks({ identity: null }))).toMatchObject({
      status: 'excluded',
      reason: 'unidentified',
    })
  })
})
