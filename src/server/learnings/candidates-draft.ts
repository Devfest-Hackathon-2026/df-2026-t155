import { z } from 'zod'

import { TextSchema } from '../../domain/primitives'
import { buildGeminiResponseJsonSchema } from '../gemini/schema'
import { MAX_LEARNING_CONTENT_LENGTH } from '../../lib/learnings/lifecycle'

// Geminiに出力させる「学びの候補」の下書き。共通のLearningそのものではない。
// ID・元の旅程ID・適用地域・承認状態は含めない。AIが決めてよいのは内容と種類と、適用範囲の大枠だけで、
// それ以外はサーバーが決定論的に補う（承認状態は必ずpending）。
export const CandidateDraftSchema = z.strictObject({
  category: z
    .enum(['verification', 'preference'])
    .describe(
      'verification＝情報源やAIの提案と、実際が食い違った事実・次回確認すべき点。preference＝本人の好み・移動負担・過ごし方の経験',
    ),
  content: TextSchema.max(MAX_LEARNING_CONTENT_LENGTH).describe(
    `次回の旅程づくりに使える学びを、${MAX_LEARNING_CONTENT_LENGTH}文字以内の1文で。本人が編集する下書き`,
  ),
  scope: z
    .enum(['all_trips', 'this_region'])
    .describe('地域を問わず使えるならall_trips、この地域に限るならthis_region'),
})

export const CandidateFailureSchema = z.strictObject({
  status: z
    .enum(['no_candidates', 'insufficient_information'])
    .describe(
      '学びにできる内容が無いならno_candidates、材料が足りないならinsufficient_information',
    ),
  reason: TextSchema.describe('作れない理由。利用者向けの短い説明'),
})

export const LearningCandidatesDraftSchema = z.strictObject({
  failure: CandidateFailureSchema.nullable().describe(
    '候補を作れる場合はnull。作れない場合のみ設定し、candidatesは空にする',
  ),
  candidates: z.array(CandidateDraftSchema).max(3).describe('学びの候補。1〜3件'),
})

export type CandidateDraft = z.infer<typeof CandidateDraftSchema>
export type LearningCandidatesDraft = z.infer<typeof LearningCandidatesDraftSchema>

export function buildCandidatesResponseJsonSchema(): Record<string, unknown> {
  return buildGeminiResponseJsonSchema(LearningCandidatesDraftSchema)
}
