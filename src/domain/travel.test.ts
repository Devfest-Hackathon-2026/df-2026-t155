import { describe, expect, it } from 'vitest'

import { TravelSegmentSchema } from './travel'

const AT = '2026-11-08T11:30:00+09:00'
const known = {
  fromStopId: 'stop-morning',
  toStopId: 'stop-lunch',
  status: 'known',
  mode: 'walk',
  durationMinutes: 12,
  distanceMeters: 900,
  source: { kind: 'routes', label: 'Google Maps Platform（Routes API）' },
  checkedAt: AT,
  explanation: '徒歩で約12分',
}
const unknown = {
  fromStopId: 'stop-lunch',
  toStopId: 'stop-exhibition',
  status: 'unknown',
  mode: 'transit',
  reason: 'transit_unsupported',
  explanation: '公共交通は、現段階では未対応です',
}

describe('TravelSegment', () => {
  it('判明済み：移動時間・手段・出典・照合時刻がそろえば有効', () => {
    expect(TravelSegmentSchema.safeParse(known).success).toBe(true)
    expect(
      TravelSegmentSchema.safeParse({ ...known, source: { kind: 'simulation', label: '架空デモ' } })
        .success,
    ).toBe(true)
  })

  it.each([
    ['出典なし', { source: undefined }],
    ['照合時刻なし', { checkedAt: undefined }],
    ['移動時間なし', { durationMinutes: undefined }],
    ['負の移動時間', { durationMinutes: -1 }],
    ['小数の移動時間', { durationMinutes: 1.5 }],
    ['公共交通は判明済みにできない', { mode: 'transit' }],
    ['タイムゾーンなしの照合時刻', { checkedAt: '2026-11-08T11:30:00' }],
    ['説明なし', { explanation: ' ' }],
    ['未知の項目', { extra: 1 }],
  ])('判明済みで拒否：%s', (_name, change) => {
    expect(TravelSegmentSchema.safeParse({ ...known, ...change }).success).toBe(false)
  })

  it('未確認：公共交通の未対応は、照合時刻なしで有効', () => {
    expect(TravelSegmentSchema.safeParse(unknown).success).toBe(true)
  })

  it('未確認：未照会は、照合時刻を持てない', () => {
    const base = { ...unknown, mode: 'walk', reason: 'not_queried' }
    expect(TravelSegmentSchema.safeParse(base).success).toBe(true)
    expect(TravelSegmentSchema.safeParse({ ...base, checkedAt: AT }).success).toBe(false)
  })

  it('未確認：試行した失敗（経路なし・API失敗）は、照合時刻が必須', () => {
    for (const reason of ['no_route', 'api_error']) {
      const base = { ...unknown, mode: 'drive', reason, explanation: '経路を取得できませんでした' }
      expect(TravelSegmentSchema.safeParse(base).success).toBe(false)
      expect(TravelSegmentSchema.safeParse({ ...base, checkedAt: AT }).success).toBe(true)
    }
  })

  it('未確認：公共交通の未対応の理由は、手段がtransitのときだけ', () => {
    expect(TravelSegmentSchema.safeParse({ ...unknown, mode: 'walk' }).success).toBe(false)
  })

  it.each([
    ['not_queried', undefined],
    ['no_route', AT],
    ['api_error', AT],
  ])(
    '未確認：手段がtransitなら、理由は%s にできない（双方向で対応させる）',
    (reason, checkedAt) => {
      const invalid = { ...unknown, mode: 'transit', reason, checkedAt }
      expect(TravelSegmentSchema.safeParse(invalid).success).toBe(false)
    },
  )

  it('未確認：個別スキーマは公開せず、検証の入口はTravelSegmentSchemaだけ', async () => {
    const exported = await import('./travel')
    expect(Object.keys(exported)).not.toContain('KnownTravelSegmentSchema')
    expect(Object.keys(exported)).not.toContain('UnknownTravelSegmentSchema')
  })

  it('未確認に、移動時間・出典を持たせられない（失敗を移動時間0に変換できない）', () => {
    expect(TravelSegmentSchema.safeParse({ ...unknown, durationMinutes: 0 }).success).toBe(false)
    expect(
      TravelSegmentSchema.safeParse({
        ...unknown,
        source: { kind: 'routes', label: 'Google Maps Platform（Routes API）' },
      }).success,
    ).toBe(false)
  })

  it('未確認は、理由が必須', () => {
    expect(TravelSegmentSchema.safeParse({ ...unknown, reason: undefined }).success).toBe(false)
    expect(TravelSegmentSchema.safeParse({ ...unknown, reason: 'unknown' }).success).toBe(false)
  })

  it('出発と到着が同じStopの区間は拒否する', () => {
    expect(TravelSegmentSchema.safeParse({ ...known, toStopId: known.fromStopId }).success).toBe(
      false,
    )
  })

  it('状態が未知・欠けている場合は拒否する', () => {
    expect(TravelSegmentSchema.safeParse({ ...known, status: 'satisfied' }).success).toBe(false)
    expect(TravelSegmentSchema.safeParse({ ...known, status: undefined }).success).toBe(false)
  })
})
