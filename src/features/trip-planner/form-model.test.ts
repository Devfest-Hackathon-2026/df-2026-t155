import { describe, expect, it } from 'vitest'

import { GenerateTripRequestSchema } from '@/domain'

import {
  buildGenerateTripRequest,
  DEFAULT_TIME_ZONE,
  firstInvalidField,
  initialFormValues,
  parsePreferences,
} from './form-model'

const valid = {
  region: '京都市東山エリア',
  date: '2026-11-14',
  preferences: 'ゆっくり歩きたい',
  fixedStops: [],
}

describe('parsePreferences', () => {
  it('1行を1つの希望として扱い、空行・前後の空白・改行コードの違いを無視する', () => {
    expect(parsePreferences('  ゆっくり歩きたい \r\n\r\n抹茶を食べたい\n   \n')).toEqual([
      'ゆっくり歩きたい',
      '抹茶を食べたい',
    ])
  })

  it('空文字や空白だけなら希望なし', () => {
    expect(parsePreferences('')).toEqual([])
    expect(parsePreferences('  \n \r\n')).toEqual([])
  })
})

describe('buildGenerateTripRequest: 正常系', () => {
  it('入力を共通契約のGenerateTripRequestに変換する（固定予定・学びは空）', () => {
    const result = buildGenerateTripRequest(valid)

    expect(result).toEqual({
      ok: true,
      request: {
        date: '2026-11-14',
        region: '京都市東山エリア',
        timeZone: DEFAULT_TIME_ZONE,
        preferences: ['ゆっくり歩きたい'],
        fixedStops: [],
        learnings: [],
      },
    })
    if (result.ok) expect(GenerateTripRequestSchema.safeParse(result.request).success).toBe(true)
  })

  it('希望条件は任意で、空でも作成できる', () => {
    const result = buildGenerateTripRequest({ ...valid, preferences: '' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.preferences).toEqual([])
  })

  it('旅行先の前後の空白は取り除く', () => {
    const result = buildGenerateTripRequest({ ...valid, region: '  京都市  ' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.region).toBe('京都市')
  })
})

describe('buildGenerateTripRequest: 入力不備', () => {
  it('何も入力していなければ、旅行先と日付の両方を案内する', () => {
    const result = buildGenerateTripRequest(initialFormValues)

    expect(result).toEqual({
      ok: false,
      errors: { region: '旅行先を入力してください', date: '日付を選んでください' },
    })
  })

  it('空白だけの旅行先は未入力として扱う', () => {
    const result = buildGenerateTripRequest({ ...valid, region: '   ' })

    expect(result).toEqual({ ok: false, errors: { region: '旅行先を入力してください' } })
  })

  it('日付だけ未入力でも、旅行先は案内しない', () => {
    const result = buildGenerateTripRequest({ ...valid, date: '' })

    expect(result).toEqual({ ok: false, errors: { date: '日付を選んでください' } })
  })

  it.each(['2026-02-30', '2026/11/14', 'あした', '2026-13-01'])(
    '存在しない日付や形式違い（%s）は契約の検証で拒否する',
    (date) => {
      const result = buildGenerateTripRequest({ ...valid, date })

      expect(result).toEqual({ ok: false, errors: { date: '正しい日付を選んでください' } })
    },
  )
})

describe('firstInvalidField', () => {
  it('画面上の並び順で最初の不備の項目を返す', () => {
    expect(firstInvalidField({ date: 'x', region: 'y' })).toBe('region')
    expect(firstInvalidField({ date: 'x' })).toBe('date')
    expect(firstInvalidField({ preferences: 'z' })).toBe('preferences')
  })

  it('不備がなければundefined', () => {
    expect(firstInvalidField({})).toBeUndefined()
    expect(firstInvalidField({ region: undefined })).toBeUndefined()
  })
})
