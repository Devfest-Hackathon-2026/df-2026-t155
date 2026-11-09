import { describe, expect, it } from 'vitest'

import { TripSchema, type Evidence, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'
import { setStopFixed } from '@/features/trip-map/model'

import {
  combineEvidence,
  isFixedOnlyChange,
  itineraryFingerprint,
  mergeVerification,
} from './merge-verification'

const evidence = (id: string): Evidence => ({
  id,
  subject: 'place_identity',
  claim: '施設の同定',
  applicability: '名称と地域',
  source: { kind: 'places', label: 'Google Places' },
  checkedAt: '2026-11-08T10:00:00+09:00',
  status: 'consistent',
  explanation: '説明',
})

// 照合前の旅程（根拠なし）。朝と14時の予定が固定、昼食は固定でない。
const sent: Trip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
})
// 照合結果：送った旅程に、Place IDと根拠だけが付く。
const result: Trip = TripSchema.parse({
  ...sent,
  stops: sent.stops.map((stop) => ({
    ...stop,
    placeId: `place-${stop.id}`,
    evidence: [evidence(`e-${stop.id}`)],
  })),
})

const renameFirst = (trip: Trip): Trip => ({
  ...trip,
  stops: trip.stops.map((stop, index) => (index === 0 ? { ...stop, name: '別の場所' } : stop)),
})

describe('itineraryFingerprint', () => {
  it('固定・版・Place ID・根拠が違っても、内容が同じなら同じ指紋になる', () => {
    const toggled = setStopFixed(sent, 'stop-lunch', true)!
    expect(itineraryFingerprint(toggled)).toBe(itineraryFingerprint(sent))
    expect(itineraryFingerprint({ ...sent, version: sent.version + 1 })).toBe(
      itineraryFingerprint(sent),
    )
    expect(itineraryFingerprint(result)).toBe(itineraryFingerprint(sent))
  })

  it('名称・時刻・滞在・順序が違えば、指紋が変わる', () => {
    const base = itineraryFingerprint(sent)
    expect(itineraryFingerprint(renameFirst(sent))).not.toBe(base)
    expect(
      itineraryFingerprint({
        ...sent,
        stops: sent.stops.map((stop, i) =>
          i === 1 ? { ...stop, plannedStartTime: '12:30' } : stop,
        ),
      }),
    ).not.toBe(base)
    expect(
      itineraryFingerprint({
        ...sent,
        stops: sent.stops.map((stop, i) => (i === 1 ? { ...stop, durationMinutes: 90 } : stop)),
      }),
    ).not.toBe(base)
    expect(
      itineraryFingerprint({
        ...sent,
        stops: sent.stops.map((stop, i) => (i === 1 ? { ...stop, kind: 'sight' } : stop)),
      }),
    ).not.toBe(base)
    expect(itineraryFingerprint({ ...sent, stops: [...sent.stops].reverse() })).not.toBe(base)
  })

  it('オブジェクトのキーの並びが違っても、同じ内容なら同じ指紋になる', () => {
    const reordered: Trip = {
      ...sent,
      stops: sent.stops.map(
        (stop) => Object.fromEntries(Object.entries(stop).reverse()) as typeof stop,
      ),
    }
    expect(itineraryFingerprint(reordered)).toBe(itineraryFingerprint(sent))
  })
})

describe('isFixedOnlyChange', () => {
  it('固定の切り替え（版の更新を含む）だけの変更は、固定だけの変更とする', () => {
    expect(isFixedOnlyChange(sent, setStopFixed(sent, 'stop-lunch', true)!)).toBe(true)
    expect(isFixedOnlyChange(sent, setStopFixed(sent, 'stop-morning', false)!)).toBe(true)
    // 照合結果の根拠を持つ旅程でも、固定だけなら根拠は変わらない。
    expect(isFixedOnlyChange(result, setStopFixed(result, 'stop-lunch', true)!)).toBe(true)
    // 変更が無い場合も、取り下げる理由はない。
    expect(isFixedOnlyChange(result, result)).toBe(true)
  })

  it('名称・時刻などの内容が変わっていれば、固定の変更が重なっていても固定だけではない', () => {
    expect(isFixedOnlyChange(sent, renameFirst(sent))).toBe(false)
    expect(isFixedOnlyChange(sent, renameFirst(setStopFixed(sent, 'stop-lunch', true)!))).toBe(
      false,
    )
  })

  it('根拠やPlace IDが差し替わった変更は、固定だけの変更ではない', () => {
    const replaced: Trip = {
      ...result,
      stops: result.stops.map((stop, i) =>
        i === 1 ? { ...stop, evidence: [evidence('e-other')] } : stop,
      ),
    }
    expect(isFixedOnlyChange(result, replaced)).toBe(false)
    const placeChanged: Trip = {
      ...result,
      stops: result.stops.map((stop, i) => (i === 1 ? { ...stop, placeId: 'place-other' } : stop)),
    }
    expect(isFixedOnlyChange(result, placeChanged)).toBe(false)
  })
})

describe('combineEvidence', () => {
  it('現在の旅程の固定と版を残し、結果の根拠とPlace IDだけを取り込む', () => {
    const current = setStopFixed(sent, 'stop-lunch', true)!
    const combined = combineEvidence(current, result)

    expect(combined.version).toBe(current.version)
    expect(combined.stops.find((stop) => stop.id === 'stop-lunch')?.isFixed).toBe(true)
    for (const stop of combined.stops) {
      const verified = result.stops.find((item) => item.id === stop.id)!
      expect(stop.evidence).toEqual(verified.evidence)
      expect(stop.placeId).toBe(verified.placeId)
    }
  })

  it('結果にない予定は、そのまま残す（IDで対応させ、並びには頼らない）', () => {
    const current = setStopFixed(sent, 'stop-lunch', true)!
    const partial: Trip = { ...result, stops: [...result.stops].reverse().slice(0, 2) }
    const combined = combineEvidence(current, partial)
    expect(combined.stops.map((stop) => stop.id)).toEqual(current.stops.map((stop) => stop.id))
    const missing = current.stops.find(
      (stop) => !partial.stops.some((item) => item.id === stop.id),
    )!
    expect(combined.stops.find((stop) => stop.id === missing.id)).toBe(missing)
    const found = combined.stops.find((stop) => stop.id === partial.stops[0].id)!
    expect(found.evidence).toEqual(partial.stops[0].evidence)
  })
})

describe('combineEvidence: 照合由来と、それ以外の根拠', () => {
  const report: Evidence = {
    ...evidence('e-report'),
    source: { kind: 'user_report', label: '本人の現地報告' },
  }
  const simulation: Evidence = {
    ...evidence('e-simulation'),
    source: { kind: 'simulation', label: '模擬データ' },
  }

  it('本人の報告・模擬データ・公式情報の根拠は、照合の結果で置き換えず、残す', () => {
    const current: Trip = {
      ...sent,
      stops: sent.stops.map((stop, i) =>
        i === 1 ? { ...stop, evidence: [report, simulation] } : stop,
      ),
    }

    const combined = combineEvidence(current, result)

    expect(combined.stops[1].evidence.map((item) => item.id)).toEqual([
      'e-report',
      'e-simulation',
      'e-stop-lunch',
    ])
  })

  it('照合由来（Places・Routes）の古い根拠は、今回の結果で置き換える。同定できなかった予定のPlace IDはnullになる', () => {
    const stale: Evidence = { ...evidence('e-old'), status: 'consistent' }
    const current: Trip = {
      ...sent,
      stops: sent.stops.map((stop, i) =>
        i === 1 ? { ...stop, placeId: 'place-old', evidence: [stale, report] } : stop,
      ),
    }
    const unidentified: Trip = {
      ...result,
      stops: result.stops.map((stop, i) =>
        i === 1
          ? { ...stop, placeId: null, evidence: [{ ...evidence('e-new'), status: 'unverifiable' }] }
          : stop,
      ),
    }

    const combined = combineEvidence(current, unidentified)

    expect(combined.stops[1].placeId).toBeNull()
    expect(combined.stops[1].evidence.map((item) => `${item.id}:${item.status}`)).toEqual([
      'e-report:consistent',
      'e-new:unverifiable',
    ])
  })

  it('応答に混ざった、Places・Routes以外の根拠は取り込まない（照合の結果として本人の報告などを作らせない）', () => {
    const injected: Trip = {
      ...result,
      stops: result.stops.map((stop, i) =>
        i === 1 ? { ...stop, evidence: [...stop.evidence, report] } : stop,
      ),
    }

    const combined = combineEvidence(sent, injected)

    expect(combined.stops[1].evidence.map((item) => item.id)).toEqual(['e-stop-lunch'])
  })
})

describe('mergeVerification', () => {
  it('確認中に固定を切り替えていても、固定を残して根拠だけを取り込む', () => {
    const current = setStopFixed(sent, 'stop-lunch', true)!
    const merged = mergeVerification(sent, current, result)!
    expect(merged.stops.find((stop) => stop.id === 'stop-lunch')?.isFixed).toBe(true)
    expect(merged.stops.every((stop) => stop.evidence.length === 1)).toBe(true)
  })

  it('確認中に内容が変わっていれば、結果を取り込まない（null）', () => {
    expect(mergeVerification(sent, renameFirst(sent), result)).toBeNull()
  })

  it('結果の内容が、送った旅程と違っていれば取り込まない（null）', () => {
    expect(mergeVerification(sent, sent, renameFirst(result))).toBeNull()
  })
})
