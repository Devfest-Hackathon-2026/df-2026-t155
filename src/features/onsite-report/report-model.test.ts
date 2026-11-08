import { describe, expect, it } from 'vitest'

import { RevisionContextSchema, TripSchema } from '@/domain'
import { sampleTrip } from '@/domain/samples'

import {
  MAX_NOTE_LENGTH,
  buildSubmission,
  firstInvalidField,
  fixedStops,
  initialValues,
  resolveTargetId,
  selectableStops,
  type ReportFormValues,
} from './report-model'

// sampleTrip：朝の庭園（固定）／昼食店A（固定でない）／14時の予約展示（固定）
const LUNCH = 'stop-lunch'
const valid: ReportFormValues = { targetStopId: LUNCH, preset: 'closed', note: '', kind: 'actual' }

// 固定されていない予定が2件の旅程
const twoOpenTrip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) =>
    stop.id === 'stop-exhibition' ? { ...stop, isFixed: false } : stop,
  ),
})
// 固定されていない予定が無い旅程
const allFixedTrip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, isFixed: true })),
})

describe('対象にできる予定', () => {
  it('固定予定は選べる予定に含まれず、固定予定として別に分かれる', () => {
    expect(selectableStops(sampleTrip).map((stop) => stop.id)).toEqual([LUNCH])
    expect(fixedStops(sampleTrip).map((stop) => stop.id)).toEqual([
      'stop-morning',
      'stop-exhibition',
    ])
  })

  it('選べる予定が1件だけなら自動で選択し、複数なら未選択のまま', () => {
    expect(initialValues(sampleTrip).targetStopId).toBe(LUNCH)
    expect(initialValues(twoOpenTrip).targetStopId).toBe('')
  })

  it('初期の対象は、固定されていない予定のときだけ使う', () => {
    expect(initialValues(twoOpenTrip, 'stop-exhibition').targetStopId).toBe('stop-exhibition')
    expect(initialValues(twoOpenTrip, 'stop-morning').targetStopId).toBe('')
    expect(initialValues(twoOpenTrip, 'no-such-stop').targetStopId).toBe('')
  })

  it('選択中の予定が選べなくなったら、未選択（または唯一の選択肢）に戻る', () => {
    expect(resolveTargetId(twoOpenTrip, 'stop-lunch')).toBe('stop-lunch')
    expect(resolveTargetId(twoOpenTrip, 'stop-morning')).toBe('')
    expect(resolveTargetId(sampleTrip, 'stop-morning')).toBe(LUNCH)
    expect(resolveTargetId(allFixedTrip, LUNCH)).toBe('')
  })

  it('自動選択を止めると、選べる予定が1件だけでも未選択のまま（対象の選び直しを求める）', () => {
    expect(initialValues(sampleTrip, undefined, false).targetStopId).toBe('')
    expect(resolveTargetId(sampleTrip, 'stop-morning', false)).toBe('')
    // 利用者が選んだ（選べる）予定は、そのまま使う。
    expect(resolveTargetId(sampleTrip, LUNCH, false)).toBe(LUNCH)
    expect(initialValues(sampleTrip, LUNCH, false).targetStopId).toBe(LUNCH)
  })
})

describe('送信データの作成', () => {
  it('プリセットを選ぶだけで送れ、context は共通契約に適合する', () => {
    const built = buildSubmission(sampleTrip, valid)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.submission.targetStopId).toBe(LUNCH)
    expect(RevisionContextSchema.safeParse(built.submission.context).success).toBe(true)
    expect(built.submission.context).toEqual({
      phase: 'on_site',
      report: { kind: 'actual', description: '閉店・臨時休業だった' },
    })
    expect(built.submission.reason).toContain('閉店・臨時休業だった')
  })

  it('実際／模擬は、選んだとおりに kind へ出る（取り違えない）', () => {
    for (const kind of ['actual', 'simulated'] as const) {
      const built = buildSubmission(sampleTrip, { ...valid, kind })
      expect(built.ok && built.submission.context.report.kind).toBe(kind)
    }
  })

  it('補足は、プリセットの文言に添えて reason と description の両方に入る', () => {
    const built = buildSubmission(sampleTrip, { ...valid, note: '  貼り紙があった  ' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.submission.context.report.description).toBe(
      '閉店・臨時休業だった。補足：貼り紙があった',
    )
    expect(built.submission.reason).toContain('貼り紙があった')
    expect(built.submission.reason).toContain('閉店・臨時休業だった')
  })

  it('空白だけの補足は無視する', () => {
    const built = buildSubmission(sampleTrip, { ...valid, note: '  　 \n ' })
    expect(built.ok && built.submission.context.report.description).toBe('閉店・臨時休業だった')
  })

  it('「その他」は補足が必須（空白だけも不備）で、書けば送れる', () => {
    const other = { ...valid, preset: 'other' as const }
    for (const note of ['', '   ']) {
      const built = buildSubmission(sampleTrip, { ...other, note })
      expect(built.ok).toBe(false)
      if (!built.ok) expect(Object.keys(built.errors)).toEqual(['note'])
    }
    const built = buildSubmission(sampleTrip, { ...other, note: '道が通行止め' })
    expect(built.ok && built.submission.context.report.description).toBe(
      'その他。補足：道が通行止め',
    )
  })

  it('報告の種類が未選択なら不備（既定の種類で送らない）', () => {
    const built = buildSubmission(sampleTrip, { ...valid, kind: '' })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(Object.keys(built.errors)).toEqual(['kind'])
  })

  it('何が起きたかが未選択なら不備', () => {
    const built = buildSubmission(sampleTrip, { ...valid, preset: '' })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(Object.keys(built.errors)).toEqual(['preset'])
  })

  it('固定予定・存在しない予定・未選択は、対象にできない', () => {
    for (const targetStopId of ['stop-morning', 'stop-exhibition']) {
      const built = buildSubmission(sampleTrip, { ...valid, targetStopId })
      expect(built.ok).toBe(false)
      if (!built.ok) expect(built.errors.target).toContain('固定予定')
    }
    expect(buildSubmission(sampleTrip, { ...valid, targetStopId: 'no-such-stop' }).ok).toBe(false)
    expect(buildSubmission(twoOpenTrip, { ...valid, targetStopId: '' }).ok).toBe(false)
  })

  it('すべて固定予定の旅程では、報告できない理由を示す', () => {
    const built = buildSubmission(allFixedTrip, { ...valid, targetStopId: '' })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.errors.target).toContain('すべて固定予定')
  })

  it('補足が長すぎると不備（空白は数えない）', () => {
    const tooLong = buildSubmission(sampleTrip, {
      ...valid,
      note: 'あ'.repeat(MAX_NOTE_LENGTH + 1),
    })
    expect(tooLong.ok).toBe(false)
    const padded = buildSubmission(sampleTrip, {
      ...valid,
      note: `${' '.repeat(50)}${'あ'.repeat(MAX_NOTE_LENGTH)}`,
    })
    expect(padded.ok).toBe(true)
  })

  it('不備が複数あるとき、画面の順で最初の不備を返す', () => {
    const built = buildSubmission(twoOpenTrip, {
      targetStopId: '',
      preset: '',
      note: '',
      kind: '',
    })
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(Object.keys(built.errors).sort()).toEqual(['kind', 'preset', 'target'])
    expect(firstInvalidField(built.errors)).toBe('target')
  })
})
