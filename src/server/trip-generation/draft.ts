import { z } from 'zod'

import { StopKindSchema } from '../../domain/models'
import { IdSchema, LocalTimeSchema, TextSchema } from '../../domain/primitives'
import { buildGeminiResponseJsonSchema } from '../gemini/schema'

// Geminiに出力させる「旅程の下書き」。共通のTripそのものではない。
// ID・版・Place ID・根拠（evidence）は含めない。AIの提案を施設照合済みの情報として
// 扱わないため、これらはサーバーが決定論的に補う（evidenceは空、placeIdはnull）。
export const DraftStopSchema = z.strictObject({
  fixedStopId: IdSchema.nullable().describe(
    '入力の固定予定に対応する地点ならそのid。固定予定でない地点はnull',
  ),
  name: TextSchema.describe('地点の名称（施設名や地名）'),
  kind: StopKindSchema.optional().describe('旅程上の予定種別。判断できなければ省略する'),
  plannedStartTime: LocalTimeSchema.describe(
    '予定開始時刻。旅程のタイムゾーンでの24時間表記HH:mm（例: 09:30、14:00）',
  ),
  durationMinutes: z.int().positive().max(1440).describe('滞在時間（分）'),
})

export const DraftLearningApplicationSchema = z.strictObject({
  learningId: IdSchema.describe('反映した承認済みの学びのid。入力にあるidだけを使う'),
  stopIndexes: z
    .array(z.int().nonnegative())
    .min(1)
    .describe('反映した地点のstops配列での位置（0始まり）'),
  explanation: TextSchema.describe('その学びをどう反映したかの説明'),
})

export const DraftFailureSchema = z.strictObject({
  status: z
    .enum(['no_candidates', 'insufficient_information'])
    .describe(
      '条件を満たす旅程を作れないならno_candidates、入力が足りず判断できないならinsufficient_information',
    ),
  reason: TextSchema.describe('作れない理由。利用者向けの短い説明'),
})

export const GeneratedTripDraftSchema = z.strictObject({
  failure: DraftFailureSchema.nullable().describe(
    '旅程を作れる場合はnull。作れない場合のみ設定し、stopsは空にする',
  ),
  stops: z.array(DraftStopSchema).max(4).describe('時刻順に並べた3〜4地点'),
  learningApplications: z.array(DraftLearningApplicationSchema),
})

export type DraftStop = z.infer<typeof DraftStopSchema>
export type GeneratedTripDraft = z.infer<typeof GeneratedTripDraftSchema>

// GeminiのresponseJsonSchemaにはZodから生成したJSON Schemaを渡し、型と制約の二重管理を避ける。
export function buildDraftResponseJsonSchema(): Record<string, unknown> {
  return buildGeminiResponseJsonSchema(GeneratedTripDraftSchema)
}
