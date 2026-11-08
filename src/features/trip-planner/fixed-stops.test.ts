import { describe, expect, it } from 'vitest'

import { GenerateTripRequestSchema } from '@/domain'

import {
  buildGenerateTripRequest,
  firstInvalidFixedStop,
  MAX_FIXED_STOPS,
  validateFixedStops,
  type FixedStopRow,
  type TripFormValues,
} from './form-model'

const row = (key: string, change: Partial<FixedStopRow> = {}): FixedStopRow => ({
  key,
  name: '展示（サンプル）',
  startTime: '14:00',
  duration: '90',
  ...change,
})

const base: Omit<TripFormValues, 'fixedStops'> = {
  region: '京都市東山エリア',
  date: '2026-11-14',
  preferences: '',
}

const build = (fixedStops: FixedStopRow[]) => buildGenerateTripRequest({ ...base, fixedStops })

describe('固定予定の入力：リクエストへの変換', () => {
  it('入力した固定予定を、isFixed: true の fixedStops として送る（契約を変えない）', () => {
    const result = build([row('a', { name: '  展示（サンプル） ' })])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.fixedStops).toEqual([
      {
        id: 'fixed-1',
        name: '展示（サンプル）',
        placeId: null,
        plannedStartTime: '14:00',
        durationMinutes: 90,
        isFixed: true,
        evidence: [],
      },
    ])
    // 入力は申告で、施設は特定しない。種別・根拠・Place IDを、勝手に付けない。
    expect(result.request.fixedStops[0]).not.toHaveProperty('kind')
    expect(GenerateTripRequestSchema.safeParse({ ...result.request, learnings: [] }).success).toBe(
      true,
    )
    expect(result.request).not.toHaveProperty('learnings')
  })

  it('複数の固定予定は、入力の並び順でIDを付ける（時刻順にはしない）', () => {
    const result = build([
      row('a', { name: '夕方の新幹線', startTime: '17:30', duration: '30' }),
      row('b', { name: '展示', startTime: '14:00', duration: '60' }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.fixedStops.map((stop) => [stop.id, stop.name])).toEqual([
      ['fixed-1', '夕方の新幹線'],
      ['fixed-2', '展示'],
    ])
  })

  it('固定予定がなければ、これまでどおり空配列', () => {
    const result = build([])

    expect(result.ok && result.request.fixedStops).toEqual([])
  })

  it('固定予定どうしが隣り合う（終了と開始が同時刻）のは、重なりではない', () => {
    const result = build([
      row('a', { startTime: '14:00', duration: '60' }),
      row('b', { name: '次の予定', startTime: '15:00', duration: '30' }),
    ])

    expect(result.ok).toBe(true)
  })

  it('最大4件まで', () => {
    const four = ['10:00', '12:00', '14:00', '16:00'].map((time, index) =>
      row(`r${index}`, { name: `予定${index}`, startTime: time, duration: '60' }),
    )

    expect(build(four).ok).toBe(true)
    const result = build([
      ...four,
      row('r5', { name: '5件目', startTime: '18:00', duration: '30' }),
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fixedStopErrors?.r5?.name).toContain(`最大${MAX_FIXED_STOPS}件`)
  })
})

describe('固定予定の入力：不備', () => {
  it.each([
    ['名前が空', { name: '   ' }, 'name', '予定の名前'],
    ['開始時刻が空', { startTime: '' }, 'startTime', '開始時刻を入力'],
    ['存在しない時刻', { startTime: '25:00' }, 'startTime', '正しい時刻'],
    ['滞在時間が空', { duration: '' }, 'duration', '滞在時間（分）を入力'],
    ['滞在時間が数字でない', { duration: 'abc' }, 'duration', '数字'],
    ['滞在時間が小数', { duration: '1.5' }, 'duration', '数字'],
    ['滞在時間が0', { duration: '0' }, 'duration', '1分以上'],
    ['滞在時間が1441分', { duration: '1441' }, 'duration', '1440分以内'],
    ['その日の24:00を超える', { startTime: '23:30', duration: '60' }, 'duration', '24:00'],
  ] as const)(
    '%s は、その項目の不備として返し、リクエストを作らない',
    (_name, change, field, text) => {
      const result = build([row('a', change)])

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.fixedStopErrors?.a?.[field]).toContain(text)
      // 他の項目（旅行先・日付）の案内は混ぜない。
      expect(result.errors).toEqual({})
    },
  )

  it('時刻が重なる固定予定は、重なった側の開始時刻の不備にする', () => {
    const result = build([
      row('a', { startTime: '14:00', duration: '90' }),
      row('b', { name: '重なる予定', startTime: '15:00', duration: '30' }),
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fixedStopErrors).toEqual({
      b: { startTime: '他の固定予定と、時間が重なっています' },
    })
  })

  it('旅行先の不備と固定予定の不備は、同時に返す', () => {
    const result = buildGenerateTripRequest({
      ...base,
      region: '',
      fixedStops: [row('a', { name: '' })],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.region).toBeDefined()
    expect(result.fixedStopErrors?.a?.name).toBeDefined()
  })

  it('固定予定に不備がなければ、fixedStopErrors を持たない', () => {
    const result = buildGenerateTripRequest({ ...base, region: '', fixedStops: [row('a')] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result).not.toHaveProperty('fixedStopErrors')
  })

  it('validateFixedStops：不備がなければ空', () => {
    expect(validateFixedStops([row('a')])).toEqual({})
  })
})

describe('firstInvalidFixedStop', () => {
  it('行の並び順で、行の中は名前・開始時刻・滞在時間の順に、最初の不備を返す', () => {
    const rows = [row('a'), row('b'), row('c')]

    expect(
      firstInvalidFixedStop(rows, { c: { name: 'x' }, b: { duration: 'y', startTime: 'z' } }),
    ).toEqual({ key: 'b', field: 'startTime' })
    expect(firstInvalidFixedStop(rows, {})).toBeUndefined()
  })
})
