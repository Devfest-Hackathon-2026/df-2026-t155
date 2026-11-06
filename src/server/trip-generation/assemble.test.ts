import { describe, expect, it } from 'vitest'

import { TripSchema } from '../../domain'
import { sampleGenerateTripRequest } from '../../domain/samples'
import { assembleTrip } from './assemble'
import type { GeneratedTripDraft } from './draft'

// sampleGenerateTripRequestの固定予定: stop-morning 10:00(60分) / stop-exhibition 14:00(60分)
const request = sampleGenerateTripRequest
const fixedMorning = request.fixedStops[0]
const fixedExhibition = request.fixedStops[1]

const createIdFactory = () => {
  let count = 0
  return () => `gen-${(count += 1)}`
}

const validDraft = (): GeneratedTripDraft => ({
  failure: null,
  stops: [
    { fixedStopId: 'stop-morning', name: '朝', plannedStartTime: '10:00', durationMinutes: 60 },
    { fixedStopId: null, name: '昼食店（テスト）', plannedStartTime: '12:00', durationMinutes: 75 },
    {
      fixedStopId: 'stop-exhibition',
      name: '展示',
      plannedStartTime: '14:00',
      durationMinutes: 60,
    },
  ],
  learningApplications: [
    { learningId: 'learning-rest', stopIndexes: [1], explanation: '昼食後の休憩を確保した' },
  ],
})

const assemble = (draft: GeneratedTripDraft) => assembleTrip(request, draft, createIdFactory())

describe('assembleTrip: 正常系', () => {
  it('下書きを共通データモデルのTripに変換し、版0・入力の条件を引き継ぐ', () => {
    const result = assemble(validDraft())
    if (!result.ok) throw new Error(result.reason)

    expect(TripSchema.safeParse(result.trip).success).toBe(true)
    expect(result.trip).toMatchObject({
      version: 0,
      date: request.date,
      region: request.region,
      timeZone: request.timeZone,
      preferences: request.preferences,
    })
    expect(result.trip.stops.map((stop) => stop.plannedStartTime)).toEqual([
      '10:00',
      '12:00',
      '14:00',
    ])
  })

  it('AIが作った地点は未同定・未照合（Place IDはnull、根拠は空）で、固定ではない', () => {
    const result = assemble(validDraft())
    if (!result.ok) throw new Error(result.reason)

    const generated = result.trip.stops[1]
    expect(generated).toMatchObject({ placeId: null, isFixed: false, evidence: [] })
    expect(generated.name).toBe('昼食店（テスト）')
  })

  it('固定予定の内容（ID・名前・時刻・滞在・固定状態）は、AIが変えても入力どおりに保たれる', () => {
    const draft = validDraft()
    draft.stops[0] = {
      fixedStopId: 'stop-morning',
      name: 'AIが勝手に改名した名前',
      plannedStartTime: '09:00',
      durationMinutes: 10,
    }
    const result = assemble(draft)
    if (!result.ok) throw new Error(result.reason)

    expect(result.trip.stops[0]).toMatchObject({
      id: fixedMorning.id,
      name: fixedMorning.name,
      plannedStartTime: fixedMorning.plannedStartTime,
      durationMinutes: fixedMorning.durationMinutes,
      isFixed: true,
    })
    expect(result.trip.stops[2]).toMatchObject({
      id: fixedExhibition.id,
      name: fixedExhibition.name,
      isFixed: true,
    })
  })

  it('HTTP入力の固定予定にあるPlace IDと根拠は、検証済みとして引き継がず未照合に戻す', () => {
    // 入力（クライアントの自己申告）には、Place IDと「情報源と整合」の根拠が付いている。
    expect(fixedMorning.evidence.some((item) => item.status === 'consistent')).toBe(true)
    const withClaimedPlace = {
      ...request,
      fixedStops: [{ ...fixedMorning, placeId: 'client-claimed-place-id' }, fixedExhibition],
    }
    const result = assembleTrip(withClaimedPlace, validDraft(), createIdFactory())
    if (!result.ok) throw new Error(result.reason)

    for (const stop of result.trip.stops.filter((item) => item.isFixed)) {
      expect(stop.placeId).toBeNull()
      expect(stop.evidence).toEqual([])
    }
    expect(JSON.stringify(result.trip)).not.toContain('client-claimed-place-id')
  })

  it('IDはサーバーが採番し、重複しない', () => {
    const result = assemble(validDraft())
    if (!result.ok) throw new Error(result.reason)

    const ids = [result.trip.id, ...result.trip.stops.map((stop) => stop.id)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(result.trip.stops[1].id).toMatch(/^gen-/)
  })

  it('学びの反映は、反映先の地点IDと説明を記録する', () => {
    const result = assemble(validDraft())
    if (!result.ok) throw new Error(result.reason)

    expect(result.trip.learningApplications).toEqual([
      {
        learningId: 'learning-rest',
        targetStopIds: [result.trip.stops[1].id],
        explanation: '昼食後の休憩を確保した',
      },
    ])
  })

  it('学びを反映しなかった場合は反映の記録を作らない', () => {
    const draft = { ...validDraft(), learningApplications: [] }
    const result = assemble(draft)
    if (!result.ok) throw new Error(result.reason)

    expect(result.trip.learningApplications).toEqual([])
  })

  it('同じ反映先の指定が重なっても、地点IDは重複させない', () => {
    const draft = validDraft()
    draft.learningApplications[0].stopIndexes = [1, 1]
    const result = assemble(draft)
    if (!result.ok) throw new Error(result.reason)

    expect(result.trip.learningApplications[0].targetStopIds).toHaveLength(1)
  })

  it('固定予定がない入力でも3地点の旅程を組み立てられる', () => {
    const noFixed = { ...request, fixedStops: [], learnings: [] }
    const draft: GeneratedTripDraft = {
      failure: null,
      stops: [
        { fixedStopId: null, name: 'A', plannedStartTime: '09:00', durationMinutes: 60 },
        { fixedStopId: null, name: 'B', plannedStartTime: '11:00', durationMinutes: 60 },
        { fixedStopId: null, name: 'C', plannedStartTime: '13:00', durationMinutes: 60 },
      ],
      learningApplications: [],
    }
    expect(assembleTrip(noFixed, draft, createIdFactory()).ok).toBe(true)
  })
})

describe('assembleTrip: 異常系（AIの出力を採用しない）', () => {
  const expectFailure = (draft: GeneratedTripDraft, reason: RegExp) => {
    const result = assemble(draft)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(reason)
  }

  it('固定予定が欠けている旅程は採用しない', () => {
    const draft = validDraft()
    draft.stops[2] = {
      fixedStopId: null,
      name: 'X',
      plannedStartTime: '14:00',
      durationMinutes: 60,
    }
    expectFailure(draft, /固定予定が旅程に含まれていません/)
  })

  it('入力にない固定予定IDを指定した旅程は採用しない', () => {
    const draft = validDraft()
    draft.stops[0].fixedStopId = 'stop-unknown'
    expectFailure(draft, /入力にない固定予定ID/)
  })

  it('同じ固定予定を複数回含む旅程は採用しない', () => {
    const draft = validDraft()
    draft.stops[1] = { ...draft.stops[0] }
    expectFailure(draft, /複数回含まれています/)
  })

  it('地点の時刻が重なる旅程は採用しない', () => {
    const draft = validDraft()
    draft.stops[1].plannedStartTime = '10:30'
    expectFailure(draft, /時刻が重なっている/)
  })

  it('時刻順に並んでいない旅程は採用しない', () => {
    const draft = validDraft()
    draft.stops = [draft.stops[2], draft.stops[1], draft.stops[0]]
    expectFailure(draft, /時刻が重なっている|時刻順/)
  })

  it('前の地点の終了時刻ちょうどに始まる地点は許可する（境界）', () => {
    const draft = validDraft()
    draft.stops[1].plannedStartTime = '11:00'
    draft.stops[1].durationMinutes = 180
    expect(assemble(draft).ok).toBe(true)
  })

  it('入力にない学びを反映済みとして記録した旅程は採用しない', () => {
    const draft = validDraft()
    draft.learningApplications[0].learningId = 'learning-made-up'
    expectFailure(draft, /入力にない学び/)
  })

  it('同じ学びを複数回記録した旅程は採用しない', () => {
    const draft = validDraft()
    draft.learningApplications.push({ ...draft.learningApplications[0] })
    expectFailure(draft, /同じ学びが複数回/)
  })

  it('存在しない地点を学びの反映先にした旅程は採用しない', () => {
    const draft = validDraft()
    draft.learningApplications[0].stopIndexes = [3]
    expectFailure(draft, /存在しない地点/)
  })

  it('地点が2件以下の旅程は共通データモデルの検証で採用しない', () => {
    const draft = validDraft()
    draft.stops = [draft.stops[0], draft.stops[2]]
    expectFailure(draft, /共通データモデルの検証に失敗/)
  })

  it('当日内に収まらない滞在は共通データモデルの検証で採用しない', () => {
    const noFixed = { ...request, fixedStops: [], learnings: [] }
    const draft: GeneratedTripDraft = {
      failure: null,
      stops: [
        { fixedStopId: null, name: 'A', plannedStartTime: '09:00', durationMinutes: 60 },
        { fixedStopId: null, name: 'B', plannedStartTime: '11:00', durationMinutes: 60 },
        { fixedStopId: null, name: 'C', plannedStartTime: '23:00', durationMinutes: 120 },
      ],
      learningApplications: [],
    }
    const result = assembleTrip(noFixed, draft, createIdFactory())
    expect(result.ok).toBe(false)
  })
})
