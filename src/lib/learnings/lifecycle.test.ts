import { describe, expect, it } from 'vitest'

import { LearningSchema, type Learning } from '../../domain'
import { sampleApprovedLearning, sampleLearning } from '../../domain/samples'
import {
  approveLearning,
  editLearning,
  MAX_LEARNING_CONTENT_LENGTH,
  rejectLearning,
  selectApplicableLearnings,
} from './lifecycle'

const DECIDED_AT = '2026-11-08T20:00:00+09:00'

// sampleLearning＝未承認・京都市東山（架空デモ）に限る。sampleApprovedLearning＝承認済み・全地域。
const pending: Learning = sampleLearning
const region = pending.scope.kind === 'region' ? pending.scope.region : ''

describe('editLearning', () => {
  it('内容を編集でき、前後の空白は取り除く。元の学びは変更しない', () => {
    const snapshot = JSON.stringify(pending)
    const result = editLearning(pending, { content: '  昼食の営業情報を前日に確認する  ' })

    expect(result.ok && result.learning.content).toBe('昼食の営業情報を前日に確認する')
    expect(JSON.stringify(pending)).toBe(snapshot)
  })

  it('承認済みの学びを編集すると、必ず未承認（pending）に戻る（再承認が必要）', () => {
    const result = editLearning(sampleApprovedLearning, { content: '休憩は30分は欲しい' })

    expect(result.ok && result.learning.approval).toEqual({ status: 'pending' })
    expect(sampleApprovedLearning.approval.status).toBe('approved')
  })

  it('却下済みの学びを編集しても、承認済みにはならない（pendingに戻る）', () => {
    const rejected = rejectLearning(pending, DECIDED_AT)
    const result = editLearning(rejected, { content: '言い換える' })

    expect(result.ok && result.learning.approval.status).toBe('pending')
  })

  it('適用範囲だけを編集しても、未承認に戻る', () => {
    const result = editLearning(sampleApprovedLearning, {
      scope: { kind: 'region', region: '奈良市' },
    })

    expect(result.ok && result.learning.approval.status).toBe('pending')
    expect(result.ok && result.learning.scope).toEqual({ kind: 'region', region: '奈良市' })
  })

  it('空・長すぎる内容、空の地域は拒否する', () => {
    expect(editLearning(pending, { content: '   ' }).ok).toBe(false)
    expect(
      editLearning(pending, { content: 'あ'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1) }).ok,
    ).toBe(false)
    expect(editLearning(pending, { content: 'あ'.repeat(MAX_LEARNING_CONTENT_LENGTH) }).ok).toBe(
      true,
    )
    expect(editLearning(pending, { scope: { kind: 'region', region: '  ' } }).ok).toBe(false)
  })

  it('編集後の学びは、共通契約に適合する', () => {
    const result = editLearning(pending, { content: '別の内容' })

    expect(result.ok && LearningSchema.safeParse(result.learning).success).toBe(true)
  })
})

describe('approveLearning / rejectLearning', () => {
  it('承認すると、承認日時つきの承認済みになり、他の項目は変わらない', () => {
    const approved = approveLearning(pending, DECIDED_AT)

    expect(approved.approval).toEqual({ status: 'approved', decidedAt: DECIDED_AT })
    expect({ ...approved, approval: pending.approval }).toEqual(pending)
  })

  it('却下すると、却下日時つきの却下済みになる', () => {
    expect(rejectLearning(pending, DECIDED_AT).approval).toEqual({
      status: 'rejected',
      decidedAt: DECIDED_AT,
    })
  })

  it('タイムゾーンのない承認日時は拒否する（承認日時は必須で、契約で検証される）', () => {
    expect(() => approveLearning(pending, '2026-11-08 20:00')).toThrow()
  })

  it('却下した学びを、本人が考え直して承認できる', () => {
    const rejected = rejectLearning(pending, DECIDED_AT)

    expect(approveLearning(rejected, '2026-11-09T09:00:00+09:00').approval.status).toBe('approved')
  })
})

describe('selectApplicableLearnings: 未承認が次回へ適用されない', () => {
  const rejected = rejectLearning({ ...pending, id: 'learning-rejected' }, DECIDED_AT)
  const otherRegion = approveLearning(
    { ...pending, id: 'learning-nara', scope: { kind: 'region', region: '奈良市' } },
    DECIDED_AT,
  )
  const sameRegion = approveLearning({ ...pending, id: 'learning-higashiyama' }, DECIDED_AT)

  it('未承認（pending）の学びは、適用されない', () => {
    expect(selectApplicableLearnings([pending], region)).toEqual([])
  })

  it('却下済みの学びは、適用されない', () => {
    expect(selectApplicableLearnings([rejected], region)).toEqual([])
  })

  it('承認済みでも、適用地域が違う学びは、適用されない', () => {
    expect(selectApplicableLearnings([otherRegion], region)).toEqual([])
  })

  it('承認済みで、全地域または同じ地域の学びだけが、適用される', () => {
    const result = selectApplicableLearnings(
      [pending, rejected, otherRegion, sameRegion, sampleApprovedLearning],
      region,
    )

    expect(result.map((item) => item.id).sort()).toEqual(
      ['learning-higashiyama', sampleApprovedLearning.id].sort(),
    )
  })

  it('承認状態の申告が不正な学び（承認日時なし）は、適用されない', () => {
    const forged: unknown = { ...pending, approval: { status: 'approved' } }
    const result = LearningSchema.safeParse(forged)

    // 契約上、承認日時のない承認済みは、そもそも学びとして不正。
    expect(result.success).toBe(false)
    expect(
      selectApplicableLearnings([{ ...pending, approval: { status: 'pending' } }], region),
    ).toEqual([])
  })

  it('編集した（pendingに戻った）学びは、再承認するまで適用されない', () => {
    const edited = editLearning(sameRegion, { content: '内容を変えた' })

    expect(edited.ok && selectApplicableLearnings([edited.learning], region)).toEqual([])
  })
})
