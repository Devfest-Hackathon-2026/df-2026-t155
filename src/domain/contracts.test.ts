import { describe, expect, it } from 'vitest'

import {
  GenerateTripRequestSchema,
  GenerateTripResponseSchema,
  ReviseTripRequestSchema,
  ReviseTripResponseSchema,
} from './contracts'
import { RevisionSchema } from './revision'
import {
  sampleApprovedLearning,
  sampleGenerateTripRequest,
  sampleLearning,
  sampleRevision,
  sampleReviseTripRequest,
  sampleTrip,
} from './samples'

describe('旅程生成契約', () => {
  it('固定予定と承認済みの学びを入力し、提案として旅程を返す', () => {
    expect(GenerateTripRequestSchema.parse(sampleGenerateTripRequest).fixedStops).toHaveLength(2)
    expect(GenerateTripResponseSchema.parse({ status: 'proposed', trip: sampleTrip }).status).toBe(
      'proposed',
    )
  })

  it('未承認・却下済み・適用地域が異なる学びを次回生成に渡せない', () => {
    for (const learning of [
      sampleLearning,
      {
        ...sampleApprovedLearning,
        approval: { status: 'rejected', decidedAt: '2026-11-01T09:00:00Z' },
      },
      { ...sampleApprovedLearning, scope: { kind: 'region', region: '大阪' } },
    ]) {
      expect(
        GenerateTripRequestSchema.safeParse({ ...sampleGenerateTripRequest, learnings: [learning] })
          .success,
      ).toBe(false)
    }
  })

  it('固定予定の重複と、固定されていない予定の混入を拒否する', () => {
    for (const fixedStops of [[sampleTrip.stops[0], sampleTrip.stops[0]], [sampleTrip.stops[1]]]) {
      expect(
        GenerateTripRequestSchema.safeParse({ ...sampleGenerateTripRequest, fixedStops }).success,
      ).toBe(false)
    }
  })

  it('生成入力でも、翌日にまたがる固定予定を拒否する', () => {
    expect(
      GenerateTripRequestSchema.safeParse({
        ...sampleGenerateTripRequest,
        fixedStops: [{ ...sampleTrip.stops[0], plannedStartTime: '23:30' }],
      }).success,
    ).toBe(false)
  })
})

describe('部分修正契約', () => {
  it('旅行前・現地の実報告・模擬報告で同じ契約を使う', () => {
    for (const context of [
      { phase: 'planning' },
      { phase: 'on_site', report: { kind: 'actual', description: '入口の休業掲示を見た' } },
      sampleReviseTripRequest.context,
    ]) {
      expect(
        ReviseTripRequestSchema.parse({ ...sampleReviseTripRequest, context }).targetStopId,
      ).toBe('stop-lunch')
    }
  })

  it.each(['missing-stop', 'stop-exhibition'])(
    '不存在・固定済みの対象を拒否する: %s',
    (targetStopId) => {
      expect(
        ReviseTripRequestSchema.safeParse({ ...sampleReviseTripRequest, targetStopId }).success,
      ).toBe(false)
    },
  )

  it('候補は1件の前後差分と未承認状態で返し、旅程の上書きを受け付けない', () => {
    const response = { status: 'proposed', revisions: [sampleRevision] }
    const parsed = ReviseTripResponseSchema.parse(response)
    expect(parsed).toMatchObject({
      revisions: [{ targetStopId: 'stop-lunch', approval: { status: 'pending' } }],
    })
    expect(ReviseTripResponseSchema.safeParse({ ...response, trip: sampleTrip }).success).toBe(
      false,
    )
    expect(ReviseTripResponseSchema.safeParse({ status: 'proposed', revisions: [] }).success).toBe(
      false,
    )
  })

  it('別Stopへの差し替え・固定解除・固定予定の差し替えを拒否する', () => {
    for (const diff of [
      { ...sampleRevision.diff, after: { ...sampleRevision.diff.after, id: 'another-stop' } },
      { ...sampleRevision.diff, before: { ...sampleRevision.diff.before, isFixed: true } },
      { ...sampleRevision.diff, after: { ...sampleRevision.diff.after, isFixed: true } },
    ]) {
      expect(RevisionSchema.safeParse({ ...sampleRevision, diff }).success).toBe(false)
    }
  })

  it('未検証・不成立・情報不足の候補の承認を拒否する', () => {
    for (const status of ['not_checked', 'violated', 'unknown']) {
      expect(
        RevisionSchema.safeParse({
          ...sampleRevision,
          constraintCheck: { status, explanation: '固定予定を保てると確認できない' },
          approval: { status: 'approved', decidedAt: '2026-11-08T11:50:00+09:00' },
        }).success,
      ).toBe(false)
    }
  })

  it('制約検証と本人承認を別状態として保持し、候補生成では承認済みを返さない', () => {
    const approved = RevisionSchema.parse({
      ...sampleRevision,
      constraintCheck: { status: 'satisfied', explanation: 'テスト用の検証結果' },
      approval: { status: 'approved', decidedAt: '2026-11-08T11:50:00+09:00' },
    })
    expect(approved.approval.status).toBe('approved')
    expect(
      ReviseTripResponseSchema.safeParse({ status: 'proposed', revisions: [approved] }).success,
    ).toBe(false)
  })

  it('異なる旅程・版・対象の候補や重複IDを混ぜられない', () => {
    for (const other of [
      { ...sampleRevision, id: 'revision-other', tripId: 'other-trip' },
      { ...sampleRevision, id: 'revision-other', baseTripVersion: 1 },
      {
        ...sampleRevision,
        id: 'revision-other',
        targetStopId: 'other-stop',
        diff: {
          before: { ...sampleRevision.diff.before, id: 'other-stop' },
          after: { ...sampleRevision.diff.after, id: 'other-stop' },
        },
      },
      sampleRevision,
    ]) {
      expect(
        ReviseTripResponseSchema.safeParse({
          status: 'proposed',
          revisions: [sampleRevision, other],
        }).success,
      ).toBe(false)
    }
  })
})

describe('失敗契約', () => {
  it.each(['no_candidates', 'insufficient_information', 'external_service_error'])(
    '生成と修正で失敗を区別し、失敗応答に更新旅程を含めない: %s',
    (status) => {
      const failure = { status, message: '元旅程を保持して再試行してください' }
      for (const schema of [GenerateTripResponseSchema, ReviseTripResponseSchema]) {
        expect(schema.parse(failure).status).toBe(status)
        expect(schema.safeParse({ ...failure, trip: sampleTrip }).success).toBe(false)
      }
    },
  )
})

describe('ReviseTripResponse.comparisons（変更前後の移動区間の比較）', () => {
  const AT = '2026-11-08T11:30:00+09:00'
  const known = (fromStopId: string, toStopId: string, minutes = 10) => ({
    presence: 'segment' as const,
    segment: {
      fromStopId,
      toStopId,
      status: 'known' as const,
      mode: 'walk' as const,
      durationMinutes: minutes,
      source: { kind: 'routes' as const, label: 'Google Maps Platform（Routes API）' },
      checkedAt: AT,
      explanation: `徒歩で約${minutes}分`,
    },
  })
  const unknownSlot = (fromStopId: string, toStopId: string) => ({
    presence: 'segment' as const,
    segment: {
      fromStopId,
      toStopId,
      status: 'unknown' as const,
      mode: 'walk' as const,
      reason: 'not_queried' as const,
      explanation: '前後の施設を特定できていないため、確認できません。',
    },
  })
  const side = () => ({
    fromPrevious: known('stop-morning', 'stop-lunch'),
    toNext: known('stop-lunch', 'stop-exhibition'),
  })
  const comparison = (overrides: Record<string, unknown> = {}) => ({
    revisionId: sampleRevision.id,
    before: side(),
    after: side(),
    ...overrides,
  })
  const parse = (comparisons?: unknown) =>
    ReviseTripResponseSchema.safeParse({
      status: 'proposed',
      revisions: [sampleRevision],
      ...(comparisons === undefined ? {} : { comparisons }),
    })

  it('比較は任意（無くても有効）。あれば、Revisionごとに1件で有効', () => {
    expect(parse().success).toBe(true)
    expect(parse([comparison()]).success).toBe(true)
  })

  it('区間が存在しない（最初・最後の予定）ことと、確認できなかった区間（unknown）を区別できる', () => {
    const none = (reason: 'first_stop' | 'last_stop') => ({ presence: 'none' as const, reason })
    expect(
      parse([
        comparison({
          before: {
            fromPrevious: none('first_stop'),
            toNext: known('stop-lunch', 'stop-exhibition'),
          },
          after: {
            fromPrevious: none('first_stop'),
            toNext: known('stop-lunch', 'stop-exhibition'),
          },
        }),
      ]).success,
    ).toBe(true)
    expect(
      parse([
        comparison({
          before: {
            fromPrevious: unknownSlot('stop-morning', 'stop-lunch'),
            toNext: side().toNext,
          },
        }),
      ]).success,
    ).toBe(true)
  })

  it('存在しないRevisionへの比較・同じRevisionへの重複は拒否する', () => {
    expect(parse([comparison({ revisionId: 'revision-none' })]).success).toBe(false)
    expect(parse([comparison(), comparison()]).success).toBe(false)
  })

  it('変更前後で区間の有無が食い違う比較は拒否する', () => {
    expect(
      parse([
        comparison({
          after: { ...side(), fromPrevious: { presence: 'none', reason: 'first_stop' } },
        }),
      ]).success,
    ).toBe(false)
  })

  it('区間の端点が、Revisionの対象Stopと前後のStopに一致しない比較は拒否する', () => {
    // 対象Stopにつながらない区間
    expect(
      parse([
        comparison({
          before: { ...side(), fromPrevious: known('stop-morning', 'stop-exhibition') },
        }),
      ]).success,
    ).toBe(false)
    // 変更前後で、前の予定が違う区間
    expect(
      parse([
        comparison({ after: { ...side(), fromPrevious: known('stop-exhibition', 'stop-lunch') } }),
      ]).success,
    ).toBe(false)
    // 次の区間が、対象Stopから始まらない
    expect(
      parse([
        comparison({ after: { ...side(), toNext: known('stop-morning', 'stop-exhibition') } }),
      ]).success,
    ).toBe(false)
  })

  it('契約に反する移動区間（出典のない判明済みなど）を含む比較は拒否する', () => {
    const broken = {
      ...side().fromPrevious,
      segment: { ...side().fromPrevious.segment, source: undefined },
    }
    expect(parse([comparison({ before: { ...side(), fromPrevious: broken } })]).success).toBe(false)
  })
})

describe('ReviseTripRequest.travelModes（利用者が使える移動手段）', () => {
  const parse = (travelModes?: unknown) =>
    ReviseTripRequestSchema.safeParse({
      ...sampleReviseTripRequest,
      ...(travelModes === undefined ? {} : { travelModes }),
    })

  it('省略できる（省略時は徒歩だけとして扱う）', () => {
    expect(parse().success).toBe(true)
  })

  it('徒歩・車を指定できる。公共交通・空・未知の手段・3件以上は拒否する', () => {
    expect(parse(['walk']).success).toBe(true)
    expect(parse(['walk', 'drive']).success).toBe(true)
    expect(parse([]).success).toBe(false)
    expect(parse(['transit']).success).toBe(false)
    expect(parse(['walk', 'drive', 'walk']).success).toBe(false)
  })
})
