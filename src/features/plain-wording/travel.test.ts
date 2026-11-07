import { describe, expect, it } from 'vitest'

import { TravelSegmentSchema, type TravelSegment } from '@/domain'

import { describeChange, describeTravelSegment } from './travel'

const AT = '2026-11-08T11:30:00+09:00'

function known(overrides: Record<string, unknown> = {}): TravelSegment {
  return TravelSegmentSchema.parse({
    fromStopId: 'stop-a',
    toStopId: 'stop-b',
    status: 'known',
    mode: 'walk',
    durationMinutes: 10,
    source: { kind: 'routes', label: 'Google Maps Platform（Routes API）' },
    checkedAt: AT,
    explanation: '徒歩で約10分',
    ...overrides,
  })
}

function unknown(overrides: Record<string, unknown> = {}): TravelSegment {
  return TravelSegmentSchema.parse({
    fromStopId: 'stop-a',
    toStopId: 'stop-b',
    status: 'unknown',
    mode: 'walk',
    reason: 'not_queried',
    explanation: '未照会',
    ...overrides,
  })
}

const UNKNOWN_TABLE = [
  ['not_queried', 'walk', undefined, '移動時間は、まだ確認していません', 'none'],
  ['transit_unsupported', 'transit', undefined, '公共交通は、確認の対象外です', 'unknown'],
  ['no_route', 'walk', AT, '移動時間を確認できません（経路が見つかりませんでした）', 'unknown'],
  ['api_error', 'drive', AT, '移動時間を確認できません（取得に失敗しました）', 'unknown'],
] as const

describe('describeTravelSegment：判明済み', () => {
  it('徒歩 約10分（Google Mapsで確認）', () => {
    const result = describeTravelSegment(known())
    expect(result.label).toBe('徒歩 約10分（Google Mapsで確認）')
    expect(result.tone).toBe('ok')
    expect(result.detail).toContain('渋滞・遅延は考慮していません')
    expect(result.provenance).toContain('2026年11月8日 11:30（UTC+09:00）')
  })

  it.each([
    [0, '徒歩 0分'],
    [1, '徒歩 約1分'],
    [59, '徒歩 約59分'],
    [60, '徒歩 約1時間'],
    [125, '徒歩 約2時間5分'],
  ])('durationMinutes=%i → %s', (durationMinutes, prefix) => {
    expect(describeTravelSegment(known({ durationMinutes })).label.startsWith(prefix)).toBe(true)
  })

  it('手段が車なら、車と表示する', () => {
    expect(describeTravelSegment(known({ mode: 'drive' })).label).toBe(
      '車 約10分（Google Mapsで確認）',
    )
  })

  it('数値は構造化された値から作られ、説明文の数字に影響されない', () => {
    const result = describeTravelSegment(known({ explanation: '実際には999分かかります' }))
    expect(result.label).toContain('約10分')
    expect(result.label).not.toContain('999')
    expect(result.detail).not.toContain('999')
    expect(result.provenance).not.toContain('999')
  })

  it('模擬（simulation）は「デモ用の想定」と明示し、確認済みを思わせない', () => {
    const result = describeTravelSegment(
      known({ source: { kind: 'simulation', label: '架空デモ' } }),
    )
    expect(result.label).toBe('徒歩 約10分（デモ用の想定）')
    expect(result.tone).toBe('demo')
    expect(result.label).not.toContain('Google Maps')
    expect(result.label).not.toContain('確認')
    expect(result.detail).toContain('実際の経路を確認した結果ではありません')
  })
})

describe('describeTravelSegment：未確認', () => {
  it.each(UNKNOWN_TABLE)('%s → %s', (reason, mode, checkedAt, label, tone) => {
    const result = describeTravelSegment(unknown({ reason, mode, checkedAt }))
    expect(result.label).toBe(label)
    expect(result.tone).toBe(tone)
    expect(result.detail).toContain('仮の値や推定値で補っていません')
    expect(result.provenance !== undefined).toBe(checkedAt !== undefined)
  })

  it('4つの理由は、すべて別の文言', () => {
    const labels = UNKNOWN_TABLE.map(
      ([reason, mode, checkedAt]) =>
        describeTravelSegment(unknown({ reason, mode, checkedAt })).label,
    )
    expect(new Set(labels).size).toBe(4)
  })

  it('数値を出さない（0分や説明文の数字を使わない）', () => {
    for (const [reason, mode, checkedAt] of UNKNOWN_TABLE) {
      const result = describeTravelSegment(
        unknown({ reason, mode, checkedAt, explanation: '999分かかる見込み' }),
      )
      expect(result.label).not.toMatch(/\d/)
      expect(result.detail).not.toMatch(/\d/)
    }
  })

  it('「間に合う見込み」は出ない', () => {
    for (const [reason, mode, checkedAt] of UNKNOWN_TABLE) {
      const result = describeTravelSegment(unknown({ reason, mode, checkedAt }))
      expect(result.label + result.detail).not.toContain('間に合う見込み')
    }
  })
})

describe('describeChange', () => {
  it.each([
    [10, 7, 'shorter', '3分短くなる', -3],
    [10, 25, 'longer', '15分長くなる', 15],
    [10, 10, 'same', '変わらない', 0],
    [10, 75, 'longer', '1時間5分長くなる', 65],
  ] as const)('%i分 → %i分は %s', (from, to, kind, label, deltaMinutes) => {
    const result = describeChange(known({ durationMinutes: from }), known({ durationMinutes: to }))
    expect(result.kind).toBe(kind)
    expect(result.label).toBe(label)
    expect(result.deltaMinutes).toBe(deltaMinutes)
  })

  it('数値は構造化された値から作られ、説明文の数字に影響されない', () => {
    const result = describeChange(
      known({ durationMinutes: 10, explanation: '999分' }),
      known({ durationMinutes: 8, explanation: '999分' }),
    )
    expect(result.label).toBe('2分短くなる')
    expect(result.deltaMinutes).toBe(-2)
  })

  it('どちらかが未確認なら、差の数値を出さず「未確認」', () => {
    const pairs: [TravelSegment, TravelSegment][] = [
      [known(), unknown()],
      [unknown(), known()],
      [unknown(), unknown()],
      [known(), unknown({ reason: 'api_error', checkedAt: AT })],
    ]
    for (const [before, after] of pairs) {
      const result = describeChange(before, after)
      expect(result.kind).toBe('unconfirmed')
      expect(result.label).toContain('未確認')
      expect(result.label).not.toMatch(/\d/)
      expect(result.detail).not.toMatch(/\d/)
      expect(result.deltaMinutes).toBeUndefined()
      expect('deltaMinutes' in result).toBe(false)
    }
  })

  it('手段が違う・確認方法が違う・別の区間は、比べずに「未確認」', () => {
    const cases: [TravelSegment, TravelSegment][] = [
      [known({ mode: 'walk' }), known({ mode: 'drive', durationMinutes: 3 })],
      [known(), known({ source: { kind: 'simulation', label: '架空デモ' }, durationMinutes: 3 })],
      [known(), known({ toStopId: 'stop-c', durationMinutes: 3 })],
    ]
    for (const [before, after] of cases) {
      const result = describeChange(before, after)
      expect(result.kind).toBe('unconfirmed')
      expect(result.deltaMinutes).toBeUndefined()
      expect(result.label).not.toMatch(/\d/)
    }
  })

  it('模擬どうしの差は、「デモ用の想定」と明示する', () => {
    const demo = (durationMinutes: number) =>
      known({ source: { kind: 'simulation', label: '架空デモ' }, durationMinutes })
    const result = describeChange(demo(10), demo(4))
    expect(result.label).toBe('6分短くなる（デモ用の想定）')
    expect(result.tone).toBe('demo')
  })
})
