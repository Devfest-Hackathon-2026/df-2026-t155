import { z } from 'zod'

import { TextSchema } from '../../domain/primitives'
import { buildGeminiResponseJsonSchema } from '../gemini/schema'

// Geminiに出力させる「代替候補の下書き」。共通のRevisionそのものではない。
// ID・Place ID・根拠・承認状態・時刻・滞在時間は含めない（AIの提案を照合済みの情報として扱わないため、
// これらはサーバーが決定論的に補う。時刻と滞在時間は、元の予定のまま変えない）。
export const RevisionCandidateDraftSchema = z.strictObject({
  name: TextSchema.describe('代替の地点の名称（実在する施設名や地名）'),
  summary: TextSchema.describe('この候補が、修正の理由に合う点の、利用者向けの短い説明（1文）'),
})

export const RevisionDraftFailureSchema = z.strictObject({
  status: z
    .enum(['no_candidates', 'insufficient_information'])
    .describe(
      '条件に合う代替候補を作れないならno_candidates、入力が足りず判断できないならinsufficient_information',
    ),
  reason: TextSchema.describe('作れない理由。利用者向けの短い説明'),
})

export const RevisionDraftSchema = z.strictObject({
  failure: RevisionDraftFailureSchema.nullable().describe(
    '候補を作れる場合はnull。作れない場合のみ設定し、candidatesは空にする',
  ),
  candidates: z.array(RevisionCandidateDraftSchema).max(3).describe('代替候補。最大3件'),
})

export type RevisionDraft = z.infer<typeof RevisionDraftSchema>

export function buildRevisionResponseJsonSchema(): Record<string, unknown> {
  return buildGeminiResponseJsonSchema(RevisionDraftSchema)
}
