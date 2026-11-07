import { describe, expect, it } from 'vitest'

import { sampleRevision } from '../../domain/samples'
import {
  approvedRevisions,
  hasMaterial,
  isSimulated,
  revisionMaterialStatus,
  usableRevisions,
} from './material'

const approved = {
  ...sampleRevision,
  constraintCheck: { status: 'satisfied' as const, explanation: 'テスト用' },
  approval: { status: 'approved' as const, decidedAt: '2026-11-08T12:10:00+09:00' },
}
// sampleRevision は模擬報告（on_site・simulated）。実報告は、報告の種類を変えて作る。
const actual = {
  ...approved,
  id: 'revision-actual',
  context: {
    phase: 'on_site' as const,
    report: { kind: 'actual' as const, description: '昼食店Aが臨時休業だった' },
  },
}
const planning = { ...approved, id: 'revision-planning', context: { phase: 'planning' as const } }

describe('学びの材料の判定（画面とサーバーで共通）', () => {
  it('模擬報告かどうか：現地の模擬報告だけが、模擬', () => {
    expect(isSimulated(approved)).toBe(true)
    expect(isSimulated(actual)).toBe(false)
    expect(isSimulated(planning)).toBe(false)
  })

  it('承認済みの変更だけを数える（未承認・却下は除く）', () => {
    expect(approvedRevisions([approved, sampleRevision]).map((r) => r.id)).toEqual([approved.id])
  })

  it('材料にできるのは、承認済みで、模擬報告ではない変更だけ', () => {
    const list = [approved, actual, planning, sampleRevision]

    expect(usableRevisions(list).map((r) => r.id)).toEqual(['revision-actual', 'revision-planning'])
  })

  it('変更1件の扱い：材料にできる／模擬報告／未承認', () => {
    expect(revisionMaterialStatus(actual)).toBe('usable')
    expect(revisionMaterialStatus(approved)).toBe('simulated')
    expect(revisionMaterialStatus(sampleRevision)).toBe('not_approved')
  })

  it('材料があるか：感想か、使える変更のどちらか。模擬報告だけでは材料にならない', () => {
    expect(hasMaterial({ revisions: [approved], feedback: '' })).toBe(false)
    expect(hasMaterial({ revisions: [approved], feedback: '休みたかった' })).toBe(true)
    expect(hasMaterial({ revisions: [actual], feedback: '' })).toBe(true)
    expect(hasMaterial({ revisions: [], feedback: '' })).toBe(false)
  })
})
