import { describe, expect, it } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import { endTime, formatMinutes, setStopFixed, worstEvidence } from './model'

// サンプルの根拠: 朝＝情報源と整合、昼食＝矛盾あり、展示＝確認できない
const consistent = sampleTrip.stops[0].evidence[0]
const conflicting = sampleTrip.stops[1].evidence[0]
const unverifiable = sampleTrip.stops[2].evidence[0]

describe('endTime / formatMinutes', () => {
  it('開始時刻と滞在分数から終了時刻を求める', () => {
    expect(endTime({ plannedStartTime: '10:00', durationMinutes: 60 })).toBe('11:00')
    expect(endTime({ plannedStartTime: '12:00', durationMinutes: 75 })).toBe('13:15')
    expect(endTime({ plannedStartTime: '09:45', durationMinutes: 30 })).toBe('10:15')
  })

  it('当日の終わり（24:00）ちょうどまで表せる', () => {
    expect(endTime({ plannedStartTime: '23:00', durationMinutes: 60 })).toBe('24:00')
    expect(formatMinutes(5)).toBe('00:05')
  })
})

describe('worstEvidence', () => {
  it('矛盾あり > 確認できない > 情報源と整合 の順で、最も重い根拠を返す', () => {
    expect(worstEvidence([consistent, unverifiable, conflicting])?.status).toBe('conflicting')
    expect(worstEvidence([consistent, unverifiable])?.status).toBe('unverifiable')
    expect(worstEvidence([consistent])?.status).toBe('consistent')
  })

  it('並び順に依存しない', () => {
    expect(worstEvidence([conflicting, consistent])?.status).toBe('conflicting')
    expect(worstEvidence([consistent, conflicting])?.status).toBe('conflicting')
  })

  it('根拠が無ければnull（未照合）', () => {
    expect(worstEvidence([])).toBeNull()
  })
})

describe('setStopFixed', () => {
  it('対象の固定状態だけを変え、保存済みの版を維持する。他の予定・内容は一切変えない', () => {
    const next = setStopFixed(sampleTrip, 'stop-lunch', true)
    if (!next) throw new Error('更新されることを期待しました')

    expect(next.version).toBe(sampleTrip.version)
    expect(next.stops[1]).toEqual({ ...sampleTrip.stops[1], isFixed: true })
    expect(next.stops[0]).toEqual(sampleTrip.stops[0])
    expect(next.stops[2]).toEqual(sampleTrip.stops[2])
    expect({ ...next, stops: [] }).toEqual({ ...sampleTrip, stops: [] })
  })

  it('元のTripを書き換えない', () => {
    const snapshot = JSON.stringify(sampleTrip)
    setStopFixed(sampleTrip, 'stop-lunch', true)
    setStopFixed(sampleTrip, 'stop-morning', false)

    expect(JSON.stringify(sampleTrip)).toBe(snapshot)
  })

  it('固定を解除できる', () => {
    const next = setStopFixed(sampleTrip, 'stop-morning', false)

    expect(next?.stops[0].isFixed).toBe(false)
    expect(next?.version).toBe(sampleTrip.version)
  })

  it('すでにその状態なら、同じTripを返し、版を上げない', () => {
    expect(setStopFixed(sampleTrip, 'stop-morning', true)).toBe(sampleTrip)
    expect(setStopFixed(sampleTrip, 'stop-lunch', false)).toBe(sampleTrip)
  })

  it('存在しないIDはnull', () => {
    expect(setStopFixed(sampleTrip, 'stop-unknown', true)).toBeNull()
  })
})
