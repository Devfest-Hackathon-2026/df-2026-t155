import { describe, expect, it } from 'vitest'

import { EvidenceSchema, LearningSchema, StopSchema, TripSchema } from './models'
import { sampleLearning, sampleTrip } from './samples'

describe('Trip / Stop', () => {
  it('1地域3地点・安定ID・固定予定・学びの適用先を読み込める', () => {
    const trip = TripSchema.parse(JSON.parse(JSON.stringify(sampleTrip)))
    expect(trip.stops.map((stop) => stop.id)).toEqual([
      'stop-morning',
      'stop-lunch',
      'stop-exhibition',
    ])
    expect(trip.stops[2]).toMatchObject({ plannedStartTime: '14:00', isFixed: true })
    expect(trip.learningApplications[0].targetStopIds).toEqual(['stop-lunch'])
  })

  it('4地点も扱えるが、2地点・5地点・重複IDを拒否する', () => {
    const fourth = { ...sampleTrip.stops[0], id: 'stop-fourth', plannedStartTime: '16:00' }
    expect(
      TripSchema.safeParse({ ...sampleTrip, stops: [...sampleTrip.stops, fourth] }).success,
    ).toBe(true)
    for (const stops of [
      sampleTrip.stops.slice(0, 2),
      [...sampleTrip.stops, fourth, { ...fourth, id: 'stop-fifth' }],
      [sampleTrip.stops[0], sampleTrip.stops[1], { ...sampleTrip.stops[2], id: 'stop-morning' }],
    ]) {
      expect(TripSchema.safeParse({ ...sampleTrip, stops }).success).toBe(false)
    }
  })

  it.each([
    { date: '2026-02-30' },
    { region: ' ' },
    { timeZone: 'Unknown/Zone' },
    { version: -1 },
    {
      learningApplications: [
        { learningId: 'learning-rest', targetStopIds: ['missing'], explanation: '休憩を増やす' },
      ],
    },
  ])('不正な日付・地域・版・参照などを拒否する: %j', (invalid) => {
    expect(TripSchema.safeParse({ ...sampleTrip, ...invalid }).success).toBe(false)
  })

  it.each([
    { id: '' },
    { placeId: '' },
    { plannedStartTime: '24:00' },
    { durationMinutes: 0 },
    { durationMinutes: 1.5 },
    { isFixed: 'false' },
  ])('Stopの不正値を拒否し、暗黙に型変換しない: %j', (invalid) => {
    expect(StopSchema.safeParse({ ...sampleTrip.stops[0], ...invalid }).success).toBe(false)
  })

  it('滞在が翌日にまたがる旅程を拒否する', () => {
    const trip = structuredClone(sampleTrip)
    trip.stops[2].plannedStartTime = '23:30'
    expect(TripSchema.safeParse(trip).success).toBe(false)
  })
})

describe('Evidence', () => {
  const evidence = sampleTrip.stops[0].evidence[0]

  it('照合の3状態と模擬情報の出典を保持する', () => {
    expect(sampleTrip.stops.flatMap((stop) => stop.evidence.map((item) => item.status))).toEqual([
      'consistent',
      'conflicting',
      'unverifiable',
    ])
    expect(EvidenceSchema.parse(evidence).source.kind).toBe('simulation')
  })

  it.each([
    { status: 'verified' },
    { checkedAt: '2026-11-05T12:00:00' },
    { checkedAt: undefined },
    { applicability: '' },
    { source: { kind: 'gemini', label: 'AIの説明' } },
    { source: { kind: 'official', label: '公式', url: 'javascript:alert(1)' } },
  ])('根拠の欠落・曖昧な状態・AIを出典とするデータを拒否する: %j', (invalid) => {
    expect(EvidenceSchema.safeParse({ ...evidence, ...invalid }).success).toBe(false)
  })
})

describe('Learning', () => {
  it('振り返りの学び候補と本人の承認・却下を区別する', () => {
    for (const status of ['approved', 'rejected']) {
      expect(
        LearningSchema.parse({
          ...sampleLearning,
          approval: { status, decidedAt: '2026-11-08T18:00:00+09:00' },
        }).approval.status,
      ).toBe(status)
    }
    expect(sampleLearning.approval.status).toBe('pending')
    expect(
      LearningSchema.safeParse({ ...sampleLearning, approval: { status: 'approved' } }).success,
    ).toBe(false)
  })
})

describe('Stop.kind（予定の種別・任意）', () => {
  it('種別なしの既存のStopは、そのまま有効（観光だと推測しない）', () => {
    const stop = StopSchema.parse(JSON.parse(JSON.stringify(sampleTrip.stops[0])))
    expect(stop.kind).toBeUndefined()
  })

  it.each(['sight', 'meal', 'transport', 'other'] as const)('種別 %s を受け付ける', (kind) => {
    expect(StopSchema.parse({ ...sampleTrip.stops[0], kind }).kind).toBe(kind)
  })

  it('予約・購入などの状態は種別にできない（固定・予約は別の軸）', () => {
    for (const kind of ['reserved', 'fixed', 'ticket', '', null]) {
      expect(StopSchema.safeParse({ ...sampleTrip.stops[0], kind }).success).toBe(false)
    }
  })

  it('種別は固定（isFixed）と独立している', () => {
    expect(StopSchema.parse({ ...sampleTrip.stops[0], kind: 'meal', isFixed: true })).toMatchObject(
      {
        kind: 'meal',
        isFixed: true,
      },
    )
    expect(
      StopSchema.parse({ ...sampleTrip.stops[0], kind: 'sight', isFixed: false }),
    ).toMatchObject({ kind: 'sight', isFixed: false })
  })

  it('種別つきのTripも、契約で検証できる', () => {
    const trip = {
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop, index) => ({
        ...stop,
        kind: index === 1 ? 'meal' : 'sight',
      })),
    }
    expect(TripSchema.safeParse(trip).success).toBe(true)
  })
})
