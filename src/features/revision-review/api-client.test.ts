import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision, sampleReviseTripRequest } from '@/domain/samples'

import {
  readRevisionProposal,
  requestRevisions,
  type RevisionProposal,
  type TravelSlot,
} from './api-client'

afterEach(() => vi.unstubAllGlobals())

const protectedHeaders = async () =>
  new Headers({ Authorization: 'Bearer test.id.token', 'X-Firebase-AppCheck': 'test.app.check' })

const request = { ...sampleReviseTripRequest, travelModes: ['walk'] as const }
const input = { ...request, travelModes: [...request.travelModes] }
const signal = new AbortController().signal

describe('候補生成 API の表示境界', () => {
  it('PR #28 の構造化比較を受け取り、対応する区間を検証する', async () => {
    const [first, target, next] = input.trip.stops
    const fromPrevious = {
      presence: 'segment',
      segment: {
        fromStopId: first.id,
        toStopId: target.id,
        status: 'unknown',
        mode: 'walk',
        reason: 'not_queried',
        explanation: '出発地点が未同定',
      },
    } as const
    const toNext = {
      presence: 'segment',
      segment: {
        fromStopId: target.id,
        toStopId: next.id,
        status: 'known',
        mode: 'walk',
        durationMinutes: 0,
        source: { kind: 'routes', label: 'Google Routes' },
        checkedAt: '2026-11-08T11:46:00+09:00',
        explanation: '構造化数値を使用',
      },
    } as const
    const proposal: RevisionProposal = {
      status: 'proposed',
      revisions: [sampleRevision],
      comparisons: [
        {
          revisionId: sampleRevision.id,
          before: { fromPrevious, toNext },
          after: { fromPrevious, toNext },
        },
      ],
    }
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(proposal))
    vi.stubGlobal('fetch', fetchFn)

    const result = await requestRevisions(input, signal, { getHeaders: protectedHeaders })
    expect(fetchFn).toHaveBeenCalledWith('/api/trips/revise', {
      method: 'POST',
      headers: expect.any(Headers),
      body: JSON.stringify(input),
      signal,
    })
    const sent = new Headers(fetchFn.mock.calls[0][1]?.headers)
    expect(sent.get('Authorization')).toBe('Bearer test.id.token')
    expect(sent.get('X-Firebase-AppCheck')).toBe('test.app.check')
    expect(sent.get('Content-Type')).toBe('application/json')
    expect(result).toEqual(proposal)
    expect(readRevisionProposal(proposal, input)).toEqual(proposal)
    expect(
      readRevisionProposal(
        { ...proposal, revisions: [{ ...sampleRevision, baseTripVersion: 1 }] },
        input,
      ),
    ).toBeNull()
    expect(
      readRevisionProposal(
        {
          ...proposal,
          comparisons: [
            {
              revisionId: sampleRevision.id,
              before: { fromPrevious, toNext },
              after: {
                fromPrevious,
                toNext: { ...toNext, segment: { ...toNext.segment, toStopId: first.id } },
              },
            },
          ],
        },
        input,
      ),
    ).toBeNull()
  })

  it('依頼の理由や文脈と異なるRevisionは、別の依頼の応答として拒否する', () => {
    const proposal = { status: 'proposed', revisions: [sampleRevision] }
    expect(readRevisionProposal(proposal, input)).not.toBeNull()
    // 前後の空白だけの違いでは、不一致にしない（サーバーは契約で整えた値を返す）。
    expect(
      readRevisionProposal(proposal, { ...input, reason: `  ${input.reason}\n` }),
    ).not.toBeNull()

    // 理由の取り違え。
    expect(readRevisionProposal(proposal, { ...input, reason: '別の依頼の理由' })).toBeNull()
    // 文脈の取り違え：旅行前、報告の種類（模擬／実際）、報告内容。
    expect(readRevisionProposal(proposal, { ...input, context: { phase: 'planning' } })).toBeNull()
    expect(
      readRevisionProposal(proposal, {
        ...input,
        context: {
          phase: 'on_site',
          report: { kind: 'actual', description: '昼食店Aの臨時休業（模擬報告）' },
        },
      }),
    ).toBeNull()
    expect(
      readRevisionProposal(proposal, {
        ...input,
        context: { phase: 'on_site', report: { kind: 'simulated', description: '別の出来事' } },
      }),
    ).toBeNull()
    // 候補が複数あっても、1件でも食い違えば全体を拒否する。
    expect(
      readRevisionProposal(
        {
          status: 'proposed',
          revisions: [
            sampleRevision,
            { ...sampleRevision, id: 'revision-other', reason: '別の理由' },
          ],
        },
        input,
      ),
    ).toBeNull()
  })

  it.each([
    ['not_queried', '2026-11-08T11:46:00+09:00'],
    ['transit_unsupported', '2026-11-08T11:46:00+09:00'],
    ['api_error', undefined],
    ['no_route', undefined],
  ] as const)('経路未確認の理由 %s と照合時刻が矛盾すれば拒否する', (reason, checkedAt) => {
    const [first, target] = input.trip.stops
    const slots = {
      fromPrevious: {
        presence: 'segment',
        segment: {
          status: 'unknown',
          reason,
          checkedAt,
          fromStopId: first.id,
          toStopId: target.id,
          mode: reason === 'transit_unsupported' ? 'transit' : 'walk',
          explanation: '未確認の区間',
        },
      },
      toNext: {
        presence: 'segment',
        segment: {
          status: 'unknown',
          reason: 'not_queried',
          fromStopId: target.id,
          toStopId: input.trip.stops[2].id,
          mode: 'walk',
          explanation: '未照会',
        },
      },
    } as const
    expect(
      readRevisionProposal(
        {
          status: 'proposed',
          revisions: [sampleRevision],
          comparisons: [{ revisionId: sampleRevision.id, before: slots, after: slots }],
        },
        input,
      ),
    ).toBeNull()
  })

  it.each([
    [404, null, 'unavailable'],
    [503, null, 'unavailable'],
    [409, null, 'conflict'],
    [400, { status: 'invalid_request' }, 'invalid_request'],
    [413, { status: 'payload_too_large' }, 'invalid_request'],
    [415, { status: 'unsupported_media_type' }, 'invalid_request'],
    [500, { status: 'internal_error' }, 'unexpected'],
    [422, { status: 'no_candidates', message: '候補なし' }, 'no_candidates'],
    [422, { status: 'insufficient_information', message: '情報不足' }, 'insufficient_information'],
    [
      502,
      { status: 'external_service_error', message: '外部サービス失敗' },
      'external_service_error',
    ],
    [
      200,
      { status: 'proposed', revisions: [sampleRevision], comparisons: [{ revisionId: 123 }] },
      'unexpected',
    ],
    [502, { status: 'no_candidates', message: 'HTTPと本文の不一致' }, 'unexpected'],
  ] as const)('HTTP %s と本文 %j を %s として扱う', async (http, body, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: http })),
    )
    expect((await requestRevisions(input, signal, { getHeaders: protectedHeaders })).status).toBe(
      status,
    )
  })

  it('JSONでない成功応答を候補として扱わない', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>')))
    expect(await requestRevisions(input, signal, { getHeaders: protectedHeaders })).toEqual({
      status: 'unexpected',
    })
  })

  it('本文受信中の切断は通信中断として扱う', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error('network'))
      },
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)))
    expect(await requestRevisions(input, signal, { getHeaders: protectedHeaders })).toEqual({
      status: 'interrupted',
    })
  })
})

const [previous, target, next] = input.trip.stops
const evidence = (subject: 'place_identity' | 'opening_hours' | 'travel_time' | 'other') => ({
  ...sampleRevision.diff.after.evidence[0],
  id: `candidate-${subject}`,
  subject,
  source:
    subject === 'travel_time'
      ? { kind: 'routes' as const, label: 'Google Routes' }
      : { kind: 'places' as const, label: 'Google Places' },
  status: 'consistent' as const,
})
const satisfied: RevisionProposal['revisions'][number] = {
  ...sampleRevision,
  constraintCheck: { status: 'satisfied', explanation: '制約を満たす' },
  diff: {
    ...sampleRevision.diff,
    after: {
      ...sampleRevision.diff.after,
      placeId: 'candidate-place',
      evidence: [evidence('place_identity'), evidence('opening_hours')],
    },
  },
}
const makeLeg = (
  fromStopId: string,
  toStopId: string,
  durationMinutes: number,
  mode: 'walk' | 'drive' = 'walk',
  kind: 'routes' | 'simulation' = 'routes',
): TravelSlot => ({
  presence: 'segment',
  segment: {
    status: 'known',
    mode,
    fromStopId,
    toStopId,
    durationMinutes,
    checkedAt: '2026-11-08T11:46:00+09:00',
    source: { kind, label: '試験データ' },
    explanation: '比較用の移動区間',
  },
})

const validLegs = {
  fromPrevious: makeLeg(previous.id, target.id, 60),
  toNext: makeLeg(target.id, next.id, 45),
}
const candidateProposal = (after = validLegs, revision = satisfied): RevisionProposal => ({
  status: 'proposed',
  revisions: [revision],
  comparisons: [{ revisionId: revision.id, before: validLegs, after }],
})

describe('候補の承認に使う前提の検証', () => {
  it('時刻にちょうど収まる両区間は承認可のままにする', () => {
    expect(
      readRevisionProposal(candidateProposal(), input)?.revisions[0].constraintCheck.status,
    ).toBe('satisfied')
  })

  it.each([
    ['前の予定から1分遅れる', { ...validLegs, fromPrevious: makeLeg(previous.id, target.id, 61) }],
    ['次の固定予定に1分遅れる', { ...validLegs, toNext: makeLeg(target.id, next.id, 46) }],
  ] as const)('%s satisfied を承認不可にする', (_, legs) => {
    const result = readRevisionProposal(candidateProposal(legs), input)
    expect(result?.revisions[0].constraintCheck.status).toBe('violated')
    expect(result?.revisions[0].impactSummary).not.toBe(satisfied.impactSummary)
  })

  it('候補自体が次の固定予定に重なる場合は移動未取得でも違反になる', () => {
    const revision = {
      ...satisfied,
      diff: { ...satisfied.diff, after: { ...satisfied.diff.after, durationMinutes: 121 } },
    }
    const result = readRevisionProposal({ status: 'proposed', revisions: [revision] }, input)
    expect(result?.revisions[0].constraintCheck.status).toBe('violated')
  })

  it('車が許可されていなければ応答を拒否し、明示された場合は受け取る', () => {
    const proposal = candidateProposal({
      ...validLegs,
      toNext: makeLeg(target.id, next.id, 45, 'drive'),
    })
    expect(readRevisionProposal(proposal, sampleReviseTripRequest)).toBeNull()
    expect(readRevisionProposal(proposal, input)).toBeNull()
    expect(
      readRevisionProposal(proposal, { ...input, travelModes: ['walk', 'drive'] })?.revisions[0]
        .constraintCheck.status,
    ).toBe('satisfied')
  })

  it.each([
    [
      '移動未取得',
      candidateProposal({
        ...validLegs,
        toNext: {
          presence: 'segment',
          segment: {
            status: 'unknown',
            mode: 'walk',
            reason: 'not_queried',
            fromStopId: target.id,
            toStopId: next.id,
            explanation: '未取得',
          },
        },
      }),
    ],
    [
      '模擬の移動',
      candidateProposal({
        ...validLegs,
        toNext: makeLeg(target.id, next.id, 900, 'walk', 'simulation'),
      }),
    ],
    ['比較なし', { status: 'proposed', revisions: [satisfied] }],
  ] as const)('%s は検証済み時間として使わない', (_, proposal) => {
    expect(readRevisionProposal(proposal, input)?.revisions[0].constraintCheck.status).toBe(
      'unknown',
    )
  })

  it.each([
    ['walk', 'transit_unsupported', null],
    ['transit', 'not_queried', null],
    ['transit', 'transit_unsupported', 'unknown'],
  ] as const)('共通スキーマで %s と %s の双方向整合を確認する', (mode, reason, expected) => {
    const proposal = candidateProposal({
      ...validLegs,
      toNext: {
        presence: 'segment',
        segment: {
          status: 'unknown',
          mode,
          reason,
          fromStopId: target.id,
          toStopId: next.id,
          explanation: '未取得',
        },
      },
    })
    expect(readRevisionProposal(proposal, input)?.revisions[0].constraintCheck.status ?? null).toBe(
      expected,
    )
  })

  it.each([
    ['opening_hours', 'unverifiable', 'unknown'],
    ['opening_hours', 'conflicting', 'violated'],
    ['travel_time', 'conflicting', 'violated'],
    ['other', 'unverifiable', 'satisfied'],
  ] as const)('%s の %s を関連する制約にだけ反映する', (subject, status, expected) => {
    const revision = {
      ...satisfied,
      diff: {
        ...satisfied.diff,
        after: {
          ...satisfied.diff.after,
          evidence: [
            ...satisfied.diff.after.evidence,
            { ...evidence(subject), id: 'additional-evidence', status },
          ],
        },
      },
    }
    const result = readRevisionProposal(candidateProposal(validLegs, revision), input)
    expect(result?.revisions[0].constraintCheck.status).toBe(expected)
    expect(result?.revisions[0].diff.after.evidence.at(-1)?.status).toBe(status)
  })

  it('先頭のStopに存在しない区間を要求せず、固定Stopは変更させない', () => {
    const revision = {
      ...satisfied,
      targetStopId: previous.id,
      diff: {
        before: { ...previous, isFixed: false },
        after: {
          ...satisfied.diff.after,
          id: previous.id,
          plannedStartTime: previous.plannedStartTime,
        },
      },
    }
    const slots = {
      fromPrevious: { presence: 'none', reason: 'first_stop' } as const,
      toNext: makeLeg(previous.id, target.id, 45),
    }
    const proposal: RevisionProposal = {
      status: 'proposed',
      revisions: [revision],
      comparisons: [{ revisionId: revision.id, before: slots, after: slots }],
    }
    const firstInput = { ...input, targetStopId: previous.id }
    expect(readRevisionProposal(proposal, firstInput)).toBeNull()
    expect(
      readRevisionProposal(proposal, {
        ...firstInput,
        trip: { ...input.trip, stops: input.trip.stops.with(0, revision.diff.before) },
      })?.revisions[0].constraintCheck.status,
    ).toBe('satisfied')
  })

  it('候補の上限3件を受け取り、4件以上は拒否する', () => {
    const revisions = Array.from({ length: 4 }, (_, index) => ({
      ...satisfied,
      id: `candidate-${index}`,
    }))
    expect(
      readRevisionProposal({ status: 'proposed', revisions: revisions.slice(0, 3) }, input)
        ?.revisions,
    ).toHaveLength(3)
    expect(readRevisionProposal({ status: 'proposed', revisions }, input)).toBeNull()
  })
})

describe('候補生成 API の保護ヘッダーと失敗', () => {
  it.each([
    ['AppCheckUnavailableError', 'app_check_unavailable'],
    ['ClientAuthError', 'auth_required'],
  ] as const)('%s でヘッダーを用意できなければ送信しない（%s）', async (name, status) => {
    const fetchFn = vi.fn<typeof fetch>()
    const getHeaders = vi.fn().mockRejectedValue(Object.assign(new Error('生の詳細'), { name }))
    const result = await requestRevisions(input, signal, { fetchFn, getHeaders })

    expect(result.status).toBe(status)
    expect(JSON.stringify(result)).not.toContain('生の詳細')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)(
    'HTTP %i は %s として区別し、サーバーの文言を出さず、再送しない',
    async (http, status) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ message: '内部の詳細' }, { status: http }))
      const result = await requestRevisions(input, signal, {
        fetchFn,
        getHeaders: protectedHeaders,
      })

      expect(result.status).toBe(status)
      expect(JSON.stringify(result)).not.toContain('内部の詳細')
      expect(fetchFn).toHaveBeenCalledTimes(1)
    },
  )
})
