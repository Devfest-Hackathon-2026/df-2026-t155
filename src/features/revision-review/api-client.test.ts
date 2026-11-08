import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision, sampleReviseTripRequest } from '@/domain/samples'

import {
  confirmedTrip,
  readRevisionProposal,
  requestRevisions,
  type RevisionProposal,
  type TravelSlot,
} from './api-client'
import { checkStopEvidence } from './proposal-checks'

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
    [200, { status: 'no_candidates', message: '候補なし' }, 'no_candidates'],
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
const candidateInput = { ...input, context: { phase: 'planning' } as const }
const satisfied: RevisionProposal['revisions'][number] = {
  ...sampleRevision,
  context: candidateInput.context,
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
  comparisons: [
    { revisionId: revision.id, originalPlaceId: 'original-place', before: validLegs, after },
  ],
})

describe('候補の承認に使う前提の検証', () => {
  it.each([null, undefined])(
    '元施設の同定結果が %s なら、候補自身が照合済みでも承認できない',
    (originalPlaceId) => {
      const planning = { phase: 'planning' } as const
      const proposal = candidateProposal(validLegs, { ...satisfied, context: planning })
      const { revisionId, before, after } = proposal.comparisons![0]
      const legs = { revisionId, before, after }
      const comparison = originalPlaceId === undefined ? legs : { ...legs, originalPlaceId }
      const result = readRevisionProposal(
        { ...proposal, comparisons: [comparison] },
        { ...candidateInput, context: planning },
      )
      expect(result?.revisions[0].constraintCheck).toMatchObject({
        status: 'unknown',
        explanation: expect.stringContaining('元の施設'),
      })
    },
  )

  it('理由や文脈を取り違えた応答を受け付けない', () => {
    expect(
      readRevisionProposal(
        candidateProposal(validLegs, { ...satisfied, reason: '別の依頼' }),
        candidateInput,
      ),
    ).toBeNull()
    expect(
      readRevisionProposal(
        candidateProposal(validLegs, { ...satisfied, context: sampleReviseTripRequest.context }),
        candidateInput,
      ),
    ).toBeNull()
  })
  it('時刻にちょうど収まる両区間は承認可のままにする', () => {
    expect(
      readRevisionProposal(candidateProposal(), candidateInput)?.revisions[0].constraintCheck
        .status,
    ).toBe('satisfied')
  })

  it.each([
    ['前の予定から1分遅れる', { ...validLegs, fromPrevious: makeLeg(previous.id, target.id, 61) }],
    ['次の固定予定に1分遅れる', { ...validLegs, toNext: makeLeg(target.id, next.id, 46) }],
  ] as const)('%s satisfied を承認不可にする', (_, legs) => {
    const result = readRevisionProposal(candidateProposal(legs), candidateInput)
    expect(result?.revisions[0].constraintCheck.status).toBe('violated')
    expect(result?.revisions[0].impactSummary).not.toBe(satisfied.impactSummary)
  })

  it('候補自体が次の固定予定に重なる場合は移動未取得でも違反になる', () => {
    const revision = {
      ...satisfied,
      diff: { ...satisfied.diff, after: { ...satisfied.diff.after, durationMinutes: 121 } },
    }
    const result = readRevisionProposal(
      { status: 'proposed', revisions: [revision] },
      candidateInput,
    )
    expect(result?.revisions[0].constraintCheck.status).toBe('violated')
  })

  it('施設IDなしの satisfied は、移動・営業時間が整合していても承認できない', () => {
    const revision = {
      ...satisfied,
      diff: { ...satisfied.diff, after: { ...satisfied.diff.after, placeId: null } },
    }
    expect(
      readRevisionProposal(candidateProposal(validLegs, revision), candidateInput)?.revisions[0],
    ).toMatchObject({ constraintCheck: { status: 'unknown' } })
  })

  it('元の予定と同じPlace IDなら、別名での satisfied も承認できない', () => {
    const original = { ...target, placeId: satisfied.diff.after.placeId }
    const revision = { ...satisfied, diff: { ...satisfied.diff, before: original } }
    const trip = { ...candidateInput.trip, stops: candidateInput.trip.stops.with(1, original) }
    expect(
      readRevisionProposal(candidateProposal(validLegs, revision), { ...candidateInput, trip })
        ?.revisions[0].constraintCheck.status,
    ).toBe('unknown')
  })

  it('比較区間が欠け、前の予定と重なる場合も承認できない', () => {
    const revision = {
      ...satisfied,
      diff: { ...satisfied.diff, after: { ...satisfied.diff.after, plannedStartTime: '10:59' } },
    }
    expect(
      readRevisionProposal({ status: 'proposed', revisions: [revision] }, candidateInput)
        ?.revisions[0].constraintCheck.status,
    ).toBe('violated')
  })

  it('比較IDの重複・未知ID・変更前の端点違いを拒否する', () => {
    const proposal = candidateProposal()
    const comparison = proposal.comparisons![0]
    for (const comparisons of [
      [comparison, comparison],
      [{ ...comparison, revisionId: 'unknown-revision' }],
      [
        {
          ...comparison,
          before: { ...comparison.before, fromPrevious: makeLeg(next.id, target.id, 10) },
        },
      ],
    ]) {
      expect(readRevisionProposal({ ...proposal, comparisons }, candidateInput)).toBeNull()
    }
  })

  it.each([
    ['opening_hours', 'user_report', 'unknown'],
    ['travel_time', 'user_report', 'unknown'],
    ['other', 'user_report', 'unknown'],
    ['other', 'official', 'unknown'],
    ['opening_hours', 'simulation', 'satisfied'],
  ] as const)('矛盾する %s の出典 %s を区別する', (subject, kind, status) => {
    const context = {
      phase: 'on_site',
      report: {
        kind: 'actual',
        description: '閉店・臨時休業だった',
        category: 'closed',
        targetStopId: target.id,
      },
    } as const
    const reported = {
      ...evidence(subject),
      id: 'reported-evidence',
      status: 'conflicting' as const,
      source: { kind, label: '出典のラベル' },
    }
    const revision = {
      ...satisfied,
      context,
      diff: {
        ...satisfied.diff,
        after: { ...satisfied.diff.after, evidence: [...satisfied.diff.after.evidence, reported] },
      },
    }
    const result = readRevisionProposal(candidateProposal(validLegs, revision), {
      ...candidateInput,
      context,
    })
    expect(result?.revisions[0].constraintCheck.status).toBe(status)
    expect(result?.revisions[0].diff.after.evidence.at(-1)).toEqual(reported)
    if (subject === 'opening_hours') {
      expect(checkStopEvidence(revision.diff.after, subject).status).toBe(
        kind === 'simulation' ? 'consistent' : 'conflicting',
      )
    }
  })

  it('適用後、根拠の checkedAt だけが更新された応答を採用する', () => {
    const after = {
      ...satisfied.diff.after,
      evidence: satisfied.diff.after.evidence.map((item) => ({
        ...item,
        checkedAt: '2026-11-08T12:01:00+09:00',
      })),
    }
    const result = {
      ...candidateInput.trip,
      version: candidateInput.trip.version + 1,
      stops: candidateInput.trip.stops.with(1, after),
    }
    const approved = { ...satisfied, context: { phase: 'planning' } as const }
    expect(confirmedTrip(candidateInput.trip, approved, result)).toEqual(result)
  })

  it('適用応答では対象の再照合根拠が必要で、対象外の空欄には表示中の根拠を維持する', () => {
    const base = candidateInput.trip
    const after = satisfied.diff.after
    const result = {
      ...base,
      version: base.version + 1,
      stops: base.stops.map((stop) => (stop.id === target.id ? after : { ...stop, evidence: [] })),
    }
    expect(confirmedTrip(base, satisfied, result)).toEqual({
      ...result,
      stops: base.stops.with(1, after),
    })
    expect(
      confirmedTrip(base, satisfied, {
        ...result,
        stops: result.stops.with(1, { ...after, evidence: [] }),
      }),
    ).toBeNull()
    expect(
      confirmedTrip(base, satisfied, {
        ...result,
        stops: result.stops.with(2, { ...result.stops[2], name: '対象外の変更' }),
      }),
    ).toBeNull()
  })

  it('定型の遅延報告に対する satisfied は、元の時刻表だけで承認できない', () => {
    const context = {
      phase: 'on_site',
      report: {
        kind: 'actual',
        description: '表示用の文面',
        category: 'delayed',
        targetStopId: target.id,
      },
    } as const
    const proposal = candidateProposal(validLegs, { ...satisfied, context })
    expect(
      readRevisionProposal(proposal, { ...candidateInput, context })?.revisions[0].constraintCheck,
    ).toMatchObject({ status: 'unknown', explanation: expect.stringContaining('遅れ') })
  })

  it('車が許可されていなければ応答を拒否し、明示された場合は受け取る', () => {
    const proposal = candidateProposal({
      ...validLegs,
      toNext: makeLeg(target.id, next.id, 45, 'drive'),
    })
    expect(readRevisionProposal(proposal, sampleReviseTripRequest)).toBeNull()
    expect(readRevisionProposal(proposal, candidateInput)).toBeNull()
    expect(
      readRevisionProposal(proposal, { ...candidateInput, travelModes: ['walk', 'drive'] })
        ?.revisions[0].constraintCheck.status,
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
    expect(
      readRevisionProposal(proposal, candidateInput)?.revisions[0].constraintCheck.status,
    ).toBe('unknown')
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
    expect(
      readRevisionProposal(proposal, candidateInput)?.revisions[0].constraintCheck.status ?? null,
    ).toBe(expected)
  })

  it.each([
    ['opening_hours', 'unverifiable', 'unknown'],
    ['opening_hours', 'conflicting', 'unknown'],
    ['travel_time', 'conflicting', 'unknown'],
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
    const result = readRevisionProposal(candidateProposal(validLegs, revision), candidateInput)
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
      comparisons: [
        { revisionId: revision.id, originalPlaceId: 'original-place', before: slots, after: slots },
      ],
    }
    const firstInput = { ...candidateInput, targetStopId: previous.id }
    expect(readRevisionProposal(proposal, firstInput)).toBeNull()
    expect(
      readRevisionProposal(proposal, {
        ...firstInput,
        trip: {
          ...candidateInput.trip,
          stops: candidateInput.trip.stops.with(0, revision.diff.before),
        },
      })?.revisions[0].constraintCheck.status,
    ).toBe('satisfied')
  })

  it('候補の上限3件を受け取り、4件以上は拒否する', () => {
    const revisions = Array.from({ length: 4 }, (_, index) => ({
      ...satisfied,
      id: `candidate-${index}`,
    }))
    expect(
      readRevisionProposal({ status: 'proposed', revisions: revisions.slice(0, 3) }, candidateInput)
        ?.revisions,
    ).toHaveLength(3)
    expect(readRevisionProposal({ status: 'proposed', revisions }, candidateInput)).toBeNull()
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
