import { z } from 'zod'

import {
  LearningSchema,
  ProposalFailureSchema,
  type Learning,
  type ProposalFailure,
} from '../../domain'

import {
  GeminiCallError,
  type GeminiCallFailureReason,
  type GeminiJsonClient,
} from '../gemini/client'
import {
  buildCandidatesResponseJsonSchema,
  LearningCandidatesDraftSchema,
} from './candidates-draft'
import { hasMaterial, type LearningReviewInput } from './candidates-input'
import { buildCandidatesPrompt } from './candidates-prompt'

// 利用者の入力やAIの出力本文は含めない。原因の区分だけを記録する。
export type CandidatesFailureEvent =
  | { kind: 'gemini_call'; reason: GeminiCallFailureReason; status?: number }
  | { kind: 'unexpected_client_error'; errorName: string }
  | { kind: 'invalid_output'; detail: string }

export interface GenerateCandidatesDeps {
  client: GeminiJsonClient
  createId?: () => string
  report?: (event: CandidatesFailureEvent) => void
}

export type CandidatesFailure = ProposalFailure

// 返却前の検証用。提案の学びは1〜3件で、すべて未承認でなければならない。
export const LearningCandidatesResponseSchema = z.union([
  z.strictObject({
    status: z.literal('proposed'),
    learnings: z
      .array(LearningSchema.refine((learning) => learning.approval.status === 'pending'))
      .min(1)
      .max(3),
  }),
  ProposalFailureSchema,
])

// 学びの候補はすべて未承認（pending）。承認・保存は本人の操作で、ここでは行わない。
export type LearningCandidatesResponse =
  { status: 'proposed'; learnings: Learning[] } | CandidatesFailure

const GEMINI_FAILURE_MESSAGES: Record<GeminiCallFailureReason, string> = {
  not_configured: 'サーバーの設定が完了していないため、学びの候補を作れません。',
  api_error:
    'AIによる学びの候補の作成に接続できませんでした。時間をおいて、もう一度お試しください。',
  blocked: 'AIが入力内容を処理できませんでした。感想を見直して、もう一度お試しください。',
  incomplete: 'AIの処理が途中で終了しました。時間をおいて、もう一度お試しください。',
  empty_response: 'AIから候補が返されませんでした。時間をおいて、もう一度お試しください。',
}

const normalize = (text: string) => text.replace(/\s+/g, '').toLowerCase()

// 振り返りの材料から、学びの候補（1〜3件）を作る。材料が無ければAIを呼ばない。
export async function generateLearningCandidates(
  input: LearningReviewInput,
  deps: GenerateCandidatesDeps,
): Promise<LearningCandidatesResponse> {
  const { client, createId = () => crypto.randomUUID(), report } = deps

  if (!hasMaterial(input)) {
    return {
      status: 'insufficient_information',
      message: '感想か、承認した変更が無いため、学びの候補を作れません。感想を書いてみてください。',
    }
  }

  const { systemInstruction, prompt } = buildCandidatesPrompt(input)
  let text: string
  try {
    // 課金対象のGemini呼び出しは1回だけ。失敗時の自動再試行はしない。
    text = await client.generateJson({
      systemInstruction,
      prompt,
      responseJsonSchema: buildCandidatesResponseJsonSchema(),
    })
  } catch (error) {
    if (error instanceof GeminiCallError) {
      report?.({ kind: 'gemini_call', reason: error.reason, status: error.status })
      return { status: 'external_service_error', message: GEMINI_FAILURE_MESSAGES[error.reason] }
    }
    report?.({
      kind: 'unexpected_client_error',
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return { status: 'external_service_error', message: GEMINI_FAILURE_MESSAGES.api_error }
  }

  const invalid = (detail: string): CandidatesFailure => {
    report?.({ kind: 'invalid_output', detail })
    return {
      status: 'no_candidates',
      message: `AIの出力が条件を満たさなかったため、候補を作れませんでした（${detail}）。もう一度お試しください。`,
    }
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return invalid('出力を解釈できませんでした')
  }
  const draft = LearningCandidatesDraftSchema.safeParse(json)
  if (!draft.success) return invalid('出力の形式が不正です')

  if (draft.data.failure) {
    return {
      status: draft.data.failure.status,
      message: `AIの回答: ${draft.data.failure.reason}`,
    }
  }

  // 重複（空白・大文字小文字を除いて同じ内容）を除く。
  const seen = new Set<string>()
  const learnings: Learning[] = []
  for (const candidate of draft.data.candidates) {
    const key = normalize(candidate.content)
    if (seen.has(key)) continue
    seen.add(key)
    const learning = LearningSchema.safeParse({
      id: createId(),
      sourceTripId: input.trip.id,
      category: candidate.category,
      content: candidate.content,
      // 適用地域はAIに決めさせず、旅程の地域をサーバーが入れる。
      scope:
        candidate.scope === 'this_region'
          ? { kind: 'region', region: input.trip.region }
          : { kind: 'all_trips' },
      approval: { status: 'pending' },
    })
    if (!learning.success) return invalid('学びの形式が契約に適合しません')
    learnings.push(learning.data)
  }
  if (learnings.length === 0) return invalid('候補が空です')
  return { status: 'proposed', learnings }
}
