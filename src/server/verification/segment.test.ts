import { describe, expect, it, vi } from 'vitest'

import { TravelSegmentSchema } from '../../domain'
import type { RouteOptions, RouteResult } from '../maps'
import {
  measureSegment,
  segmentEvidenceFields,
  type MeasureSegmentInput,
  type TravelModeSetting,
} from './segment'

const AT = '2026-11-06T03:00:00.000Z'
const BASE = { claim: '前の予定の終了後、この予定の開始時刻までに移動できる', applicability: '例' }

const found = (minutes: number): RouteResult => ({
  status: 'found',
  durationSeconds: minutes * 60,
  minutes,
})
type ByMode = { WALK?: RouteResult | Error; DRIVE?: RouteResult | Error }

const run = async (
  byMode: ByMode,
  options: { modes: readonly TravelModeSetting[]; available: number } & Partial<
    Pick<MeasureSegmentInput, 'fromPlaceId' | 'toPlaceId'>
  >,
) => {
  const computeRoute = vi.fn(async (route: RouteOptions): Promise<RouteResult> => {
    const value = byMode[route.mode as keyof ByMode] ?? { status: 'no_route' as const }
    if (value instanceof Error) throw value
    return value
  })
  const measurement = await measureSegment(
    { computeRoute },
    {
      fromStopId: 'stop-a',
      toStopId: 'stop-b',
      fromPlaceId: options.fromPlaceId === undefined ? 'P1' : options.fromPlaceId,
      toPlaceId: options.toPlaceId === undefined ? 'P2' : options.toPlaceId,
      availableMinutes: options.available,
      modes: options.modes,
      checkedAt: AT,
    },
  )
  return { measurement, computeRoute }
}

describe('measureSegment: 複数の移動手段の部分失敗', () => {
  it('徒歩で間に合わず、車の経路を確認できないときは、区間全体を「確認できない」とする（矛盾にしない）', async () => {
    const { measurement } = await run(
      { WALK: found(60), DRIVE: { status: 'no_route' } },
      { modes: ['walk', 'drive'], available: 45 },
    )

    expect(measurement.fit).toEqual({ status: 'unknown' })
    expect(measurement.segment).toMatchObject({
      status: 'unknown',
      reason: 'no_route',
      // 失敗の理由と、その理由が対応する手段（確認できなかった車）を一致させる。
      mode: 'drive',
      checkedAt: AT,
    })
    // 確認できた所要時間は保持する。
    expect(measurement.confirmed).toEqual([{ mode: 'walk', minutes: 60 }])
    expect(TravelSegmentSchema.safeParse(measurement.segment).success).toBe(true)

    const fields = segmentEvidenceFields(measurement, BASE)
    expect(fields?.status).toBe('unverifiable')
    expect(fields?.explanation).toContain('間に合うか確認できません')
  })

  it('徒歩で間に合わず、車の取得が失敗したときは、api_errorと車を対応させる', async () => {
    const { measurement } = await run(
      { WALK: found(60), DRIVE: new Error('boom') },
      { modes: ['walk', 'drive'], available: 45 },
    )

    expect(measurement.segment).toMatchObject({
      status: 'unknown',
      reason: 'api_error',
      mode: 'drive',
    })
    expect(measurement.confirmed).toEqual([{ mode: 'walk', minutes: 60 }])
    expect(segmentEvidenceFields(measurement, BASE)?.status).toBe('unverifiable')
  })

  it('徒歩の取得が失敗し、車では間に合わないときも、区間全体を「確認できない」とする', async () => {
    const { measurement } = await run(
      { WALK: new Error('boom'), DRIVE: found(50) },
      { modes: ['walk', 'drive'], available: 45 },
    )

    expect(measurement.fit).toEqual({ status: 'unknown' })
    expect(measurement.segment).toMatchObject({ reason: 'api_error', mode: 'walk' })
    expect(measurement.confirmed).toEqual([{ mode: 'drive', minutes: 50 }])
  })

  it('徒歩の取得が失敗しても、車で間に合うなら、車で間に合う見込みとする', async () => {
    const { measurement } = await run(
      { WALK: new Error('boom'), DRIVE: found(20) },
      { modes: ['walk', 'drive'], available: 45 },
    )

    expect(measurement.fit).toEqual({ status: 'fits', slackMinutes: 25 })
    expect(measurement.segment).toMatchObject({ status: 'known', mode: 'drive' })
  })

  it('使える手段のすべてを確認できて、どれでも間に合わないときだけ、矛盾あり', async () => {
    const { measurement } = await run(
      { WALK: found(60), DRIVE: found(50) },
      { modes: ['walk', 'drive'], available: 45 },
    )

    expect(measurement.fit).toEqual({ status: 'too_long', shortageMinutes: 5 })
    expect(measurement.segment).toMatchObject({ status: 'known', mode: 'drive' })
    expect(segmentEvidenceFields(measurement, BASE)?.status).toBe('conflicting')
  })

  it('徒歩だけを許可し、経路が無いときは、手段は徒歩と対応する', async () => {
    const { measurement } = await run({}, { modes: ['walk'], available: 45 })

    expect(measurement.segment).toMatchObject({ reason: 'no_route', mode: 'walk' })
  })

  it('徒歩で間に合えば、車は調べない（呼び出しを節約）', async () => {
    const { measurement, computeRoute } = await run(
      { WALK: found(10), DRIVE: found(5) },
      { modes: ['walk', 'drive'], available: 45 },
    )

    expect(measurement.fit).toEqual({ status: 'fits', slackMinutes: 35 })
    expect(computeRoute).toHaveBeenCalledTimes(1)
  })
})

describe('measureSegment: 照会していない区間', () => {
  it('施設を特定できない区間は、Routesを呼ばず、Routes由来の根拠にならない（null）', async () => {
    const { measurement, computeRoute } = await run(
      {},
      { modes: ['walk'], available: 45, fromPlaceId: null },
    )

    expect(measurement.segment).toMatchObject({ status: 'unknown', reason: 'not_queried' })
    expect(measurement.segment).not.toHaveProperty('checkedAt')
    expect(computeRoute).not.toHaveBeenCalled()
    expect(segmentEvidenceFields(measurement, BASE)).toBeNull()
  })

  it('時刻がすでに重なっている区間は、Routesを呼ばず、Routes由来の根拠にならない（null）', async () => {
    const { measurement, computeRoute } = await run({}, { modes: ['walk'], available: -30 })

    expect(measurement.fit).toEqual({ status: 'too_long', shortageMinutes: 30 })
    expect(computeRoute).not.toHaveBeenCalled()
    expect(segmentEvidenceFields(measurement, BASE)).toBeNull()
  })
})
