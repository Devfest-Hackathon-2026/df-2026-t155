import { z } from 'zod'

import { IdSchema, LocalTimeSchema, TextSchema } from '../../domain/primitives'

// Geminiに出力させる「旅程の下書き」。共通のTripそのものではない。
// ID・版・Place ID・根拠（evidence）は含めない。AIの提案を施設照合済みの情報として
// 扱わないため、これらはサーバーが決定論的に補う（evidenceは空、placeIdはnull）。
export const DraftStopSchema = z.strictObject({
  fixedStopId: IdSchema.nullable().describe(
    '入力の固定予定に対応する地点ならそのid。固定予定でない地点はnull',
  ),
  name: TextSchema.describe('地点の名称（施設名や地名）'),
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

// Geminiが対象とするJSON Schemaの一部に含まれないキー。拒否や無視を避けるため渡さない。
// 厳密な制約（時刻形式・最小長・範囲）は、受け取った出力をZodで検証して保証する。
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'pattern',
  'minLength',
  'maxLength',
  'format',
  'exclusiveMinimum',
  'exclusiveMaximum',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function toGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiSchema)
  if (!isRecord(node)) return node

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
    // Zodが整数に付ける安全な整数の上限は意味を持たないため省く。
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue
    if (key === 'properties' && isRecord(value)) {
      // propertiesのキーはプロパティ名なので、名前は残して値だけ変換する。
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, toGeminiSchema(schema)]),
      )
      continue
    }
    result[key] = toGeminiSchema(value)
  }
  // 「0より大きい整数」は、サポートされるminimumで表す。
  if (node.type === 'integer' && node.exclusiveMinimum === 0) result.minimum = 1
  return result
}

// GeminiのresponseJsonSchemaにはZodから生成したJSON Schemaを渡し、型と制約の二重管理を避ける。
export function buildDraftResponseJsonSchema(): Record<string, unknown> {
  const schema = toGeminiSchema(z.toJSONSchema(GeneratedTripDraftSchema, { io: 'input' }))
  if (!isRecord(schema)) throw new Error('JSON Schemaの生成に失敗しました')
  return schema
}
