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
