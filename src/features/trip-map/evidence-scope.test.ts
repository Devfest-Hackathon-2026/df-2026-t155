import { describe, expect, it, vi } from 'vitest'

import { TripSchema, type Evidence, type Stop, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'
import type { PlaceSearchResult, RouteOptions, RouteResult } from '@/server/maps'
import { reviseTrip } from '@/server/revision/revise-trip'
import { verifyTrip } from '@/server/verification/verify-trip'

import { evidenceTarget, segmentEvidence } from './evidence-scope'

const evidence = (
  id: string,
  subject: Evidence['subject'],
  kind: Evidence['source']['kind'] = 'routes',
  status: Evidence['status'] = 'consistent',
): Evidence => ({
  id,
  subject,
  claim: '主張',
  applicability: '範囲',
  source: { kind, label: kind },
  checkedAt: '2026-11-08T10:00:00+09:00',
  status,
  explanation: '説明',
})

const stop = (id: string, items: Evidence[] = []): Stop => ({
  id,
  name: id,
  placeId: null,
  plannedStartTime: '10:00',
  durationMinutes: 30,
  isFixed: false,
  evidence: items,
})

describe('evidenceTarget', () => {
  it('施設の存在・営業時間は、その予定そのもの', () => {
    expect(evidenceTarget(stop('a'), evidence('x', 'place_identity', 'places'))).toBe('stop')
    expect(evidenceTarget(stop('a'), evidence('x', 'opening_hours', 'places'))).toBe('stop')
  })

  it('移動の根拠は、idの規約で方向が決まる（前の予定→この予定／この予定→次の予定）', () => {
    const a = stop('a')
    expect(evidenceTarget(a, evidence('evidence-a-travel', 'travel_time'))).toBe('from_previous')
    expect(evidenceTarget(a, evidence('evidence-a-travel-next', 'travel_time'))).toBe('to_next')
  })

  it('他の予定のidを持つ移動の根拠、規約に合わないid、移動以外の「その他」は、特定できない', () => {
    const a = stop('a')
    expect(evidenceTarget(a, evidence('evidence-b-travel', 'travel_time'))).toBe('unknown')
    expect(evidenceTarget(a, evidence('evidence-a-travel-prev', 'travel_time'))).toBe('unknown')
    expect(evidenceTarget(a, evidence('anything', 'travel_time'))).toBe('unknown')
    expect(evidenceTarget(a, evidence('evidence-a-other', 'other'))).toBe('unknown')
  })

  it('予定のidが規約の語尾に似ていても、取り違えない', () => {
    const tricky = stop('x-travel')
    expect(evidenceTarget(tricky, evidence('evidence-x-travel-travel', 'travel_time'))).toBe(
      'from_previous',
    )
    expect(evidenceTarget(tricky, evidence('evidence-x-travel-travel-next', 'travel_time'))).toBe(
      'to_next',
    )
    // 「x-travel」の予定にとって、`evidence-x-travel` は規約の形ではない（予定idは「x」）。
    expect(evidenceTarget(tricky, evidence('evidence-x-travel', 'travel_time'))).toBe('unknown')
  })
})

describe('segmentEvidence', () => {
  const travel = (id: string) => evidence(`evidence-${id}-travel`, 'travel_time')
  const travelNext = (id: string) => evidence(`evidence-${id}-travel-next`, 'travel_time')

  it('区間は、終点側の「前から」と、起点側の「次へ」の根拠。方向が合わないものは含めない', () => {
    const stops = [
      stop('a', [travel('a'), travelNext('a')]),
      stop('b', [travel('b'), travelNext('b')]),
      stop('c', [travel('c'), travelNext('c')]),
    ]

    // a→b：b.travel（前から）と a.travel-next（次へ）だけ。b.travel-next（b→c）やa.travel（?→a）は入らない。
    expect(segmentEvidence(stops, 1).map((item) => [item.evidence.id, item.owner])).toEqual([
      ['evidence-b-travel', 'destination'],
      ['evidence-a-travel-next', 'origin'],
    ])
    expect(segmentEvidence(stops, 2).map((item) => [item.evidence.id, item.owner])).toEqual([
      ['evidence-c-travel', 'destination'],
      ['evidence-b-travel-next', 'origin'],
    ])
  })

  it('b→c の根拠だけが b にあるとき、a→b の区間には何も返さない（方向の取り違え）', () => {
    const stops = [stop('a'), stop('b', [travelNext('b')]), stop('c')]
    expect(segmentEvidence(stops, 1)).toEqual([])
    expect(segmentEvidence(stops, 2).map((item) => item.evidence.id)).toEqual([
      'evidence-b-travel-next',
    ])
  })

  it('Routes以外（模擬・本人の報告・公式）と、区間を特定できない根拠は含めない', () => {
    const stops = [
      stop('a'),
      stop('b', [
        evidence('evidence-b-travel', 'travel_time', 'simulation'),
        evidence('evidence-b-travel', 'travel_time', 'user_report'),
        evidence('evidence-unclear', 'travel_time', 'routes'),
      ]),
    ]
    expect(segmentEvidence(stops, 1)).toEqual([])
  })

  it('最初の予定には前の区間が無く、範囲外の位置は空', () => {
    const stops = [stop('a', [travel('a')]), stop('b')]
    expect(segmentEvidence(stops, 0)).toEqual([])
    expect(segmentEvidence(stops, 5)).toEqual([])
  })
})

// ここから先は、idの命名規約が、サーバーが実際に作る根拠と一致しているかの契約のテスト。
// サーバーの根拠のid・種類が変わったら、このテストが落ちる（路線図の区間ラベルが黙って「未確認」になるのを防ぐ）。
describe('契約：サーバーが作る根拠と、命名規約の一致', () => {
  const NOW = new Date('2026-11-07T03:00:00.000Z')
  const KYOTO_ADDRESS = '日本、〒605-0862 京都府京都市東山区清水1丁目294'
  const sundayAllDay = [
    { open: { day: 0, hour: 8, minute: 0 }, close: { day: 0, hour: 20, minute: 0 } },
  ]
  const found = (placeId: string, name: string): PlaceSearchResult => ({
    status: 'found',
    candidates: [
      {
        placeId,
        name,
        address: KYOTO_ADDRESS,
        openingHours: { status: 'available', periods: sundayAllDay },
      },
    ],
  })
  const places: Record<string, PlaceSearchResult> = {
    朝の庭園: found('P1', '朝の庭園（架空）'),
    昼食店A: found('P2', '昼食店A（架空）'),
    '14時の予約展示': found('P3', '14時の予約展示（架空）'),
    昼食店B: found('P4', '昼食店B'),
  }
  const maps = () => ({
    searchPlaces: vi.fn(async ({ query }: { query: string }): Promise<PlaceSearchResult> => {
      const key = Object.keys(places).find((name) => query.includes(name))
      return key ? places[key] : { status: 'no_candidates' }
    }),
    computeRoute: vi.fn(async (options: RouteOptions): Promise<RouteResult> => ({
      status: 'found',
      durationSeconds: options.mode === 'WALK' ? 600 : 300,
      minutes: options.mode === 'WALK' ? 10 : 5,
    })),
  })
  const unverified: Trip = TripSchema.parse({
    ...sampleTrip,
    stops: sampleTrip.stops.map((item) => ({ ...item, placeId: null, evidence: [] })),
  })

  it('照合（verifyTrip）：施設・営業時間はその予定、移動は「前の予定→この予定」', async () => {
    const result = await verifyTrip(unverified, { maps: maps(), now: () => NOW })
    if (result.status !== 'verified') throw new Error('照合に失敗した')

    for (const item of result.trip.stops) {
      for (const e of item.evidence) {
        const target = evidenceTarget(item, e)
        expect(target, `${e.id}`).not.toBe('unknown')
        expect(target).toBe(e.subject === 'travel_time' ? 'from_previous' : 'stop')
      }
    }
    // 区間の根拠は、終点側の予定に付き、起点側の予定には付かない。
    const lunchTravel = segmentEvidence(result.trip.stops, 1)
    expect(lunchTravel.map((item) => [item.evidence.id, item.owner])).toEqual([
      ['evidence-stop-lunch-travel', 'destination'],
    ])
    expect(segmentEvidence(result.trip.stops, 2).map((item) => item.evidence.id)).toEqual([
      'evidence-stop-exhibition-travel',
    ])
  })

  it('部分修正の候補（reviseTrip）：前の予定からは from_previous、次の予定へは to_next', async () => {
    const draft = JSON.stringify({
      failure: null,
      candidates: [{ name: '昼食店B', summary: '昼食に合う候補です' }],
    })
    const response = await reviseTrip(
      {
        trip: unverified,
        targetStopId: 'stop-lunch',
        reason: '昼食店が臨時休業だった',
        context: { phase: 'planning' },
      },
      {
        client: { generateJson: vi.fn().mockResolvedValue(draft) },
        maps: maps(),
        now: () => NOW,
      },
    )
    if (response.status !== 'proposed') throw new Error(`候補が作れなかった：${response.status}`)

    const after = response.revisions[0].diff.after
    const byId = Object.fromEntries(after.evidence.map((e) => [e.id, evidenceTarget(after, e)]))
    expect(byId).toEqual({
      'evidence-stop-lunch-place': 'stop',
      'evidence-stop-lunch-hours': 'stop',
      'evidence-stop-lunch-travel': 'from_previous',
      'evidence-stop-lunch-travel-next': 'to_next',
    })
    // 候補を旅程に差し替えると、朝→昼食店B と 昼食店B→展示 の両方の区間に、それぞれ根拠が1件付く。
    const applied = unverified.stops.map((item) => (item.id === after.id ? after : item))
    expect(segmentEvidence(applied, 1).map((item) => item.evidence.id)).toEqual([
      'evidence-stop-lunch-travel',
    ])
    expect(segmentEvidence(applied, 2).map((item) => item.evidence.id)).toEqual([
      'evidence-stop-lunch-travel-next',
    ])
  })
})
