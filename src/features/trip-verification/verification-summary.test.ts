import { describe, expect, it } from 'vitest'

import type { Evidence, Trip } from '@/domain'

import {
  CHECKED_AT,
  generated,
  hoursEvidence,
  identityEvidence,
  serverVerified,
  travelEvidence,
  userReport,
} from './test-fixtures'
import { summarizeVerification } from './verification-summary'

const withEvidence = (trip: Trip, byStopId: Record<string, Evidence[]>): Trip => ({
  ...trip,
  stops: trip.stops.map((stop) => ({ ...stop, evidence: byStopId[stop.id] ?? [] })),
})

describe('summarizeVerification', () => {
  it('Places・Routesで照合した根拠を、状態・項目ごとに数え、照合日時の範囲を求める', () => {
    const [morning, lunch, exhibition] = generated.stops
    const trip = withEvidence(generated, {
      [morning.id]: [identityEvidence(morning), hoursEvidence(morning, 'conflicting')],
      [lunch.id]: [
        identityEvidence(lunch, 'unverifiable'),
        travelEvidence(lunch, morning, 'consistent', '2026-11-08T11:00:00+09:00'),
      ],
      [exhibition.id]: [],
    })

    const { google, otherTotal } = summarizeVerification(trip)

    expect(google.counts).toEqual({ consistent: 2, conflicting: 1, unverifiable: 1 })
    expect(google.total).toBe(4)
    expect(google.bySubject).toEqual({ place_identity: 2, opening_hours: 1, travel_time: 1 })
    expect(google.earliestCheckedAt).toBe(CHECKED_AT)
    expect(google.latestCheckedAt).toBe('2026-11-08T11:00:00+09:00')
    expect(otherTotal).toBe(0)
  })

  it('公式・本人の報告・模擬データの根拠は、照合の件数に混ぜず、別に数える', () => {
    const [morning, lunch] = generated.stops
    const simulation: Evidence = {
      ...userReport('evidence-sim'),
      source: { kind: 'simulation', label: '模擬データ' },
    }
    const trip = withEvidence(generated, {
      [morning.id]: [identityEvidence(morning), userReport()],
      [lunch.id]: [simulation],
    })

    const { google, otherTotal } = summarizeVerification(trip)

    expect(google.total).toBe(1)
    expect(google.counts).toEqual({ consistent: 1, conflicting: 0, unverifiable: 0 })
    expect(otherTotal).toBe(2)
  })

  it('根拠が無い、または模擬・本人の報告だけなら、照合した根拠は0件で、日時もnull', () => {
    expect(summarizeVerification(generated).google).toMatchObject({
      total: 0,
      latestCheckedAt: null,
      earliestCheckedAt: null,
      bySubject: { place_identity: 0, opening_hours: 0, travel_time: 0 },
    })
    const reportOnly = withEvidence(generated, { 'stop-lunch': [userReport()] })
    expect(summarizeVerification(reportOnly).google.total).toBe(0)
    expect(summarizeVerification(reportOnly).otherTotal).toBe(1)
  })

  it('外部の情報源に1件も照会しなかった照合結果（全予定が照会対象外）は、照合した根拠が0件', () => {
    const skipped = serverVerified(generated, { skipped: generated.stops.map((stop) => stop.id) })
    expect(summarizeVerification(skipped).google.total).toBe(0)
  })
})
