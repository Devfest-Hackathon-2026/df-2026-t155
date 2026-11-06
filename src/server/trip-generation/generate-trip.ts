import type { GenerateTripRequest, GenerateTripResponse, ProposalFailure } from '../../domain'
import {
  GeminiCallError,
  type GeminiCallFailureReason,
  type GeminiJsonClient,
} from '../gemini/client'
import { assembleTrip } from './assemble'
import { buildDraftResponseJsonSchema, GeneratedTripDraftSchema } from './draft'
import { buildTripPrompt } from './prompt'

// 利用者の入力やAIの出力本文は含めない。原因の区分だけを記録する。
export type GenerationFailureEvent =
  | { kind: 'gemini_call'; reason: GeminiCallFailureReason; status?: number }
  | { kind: 'unexpected_client_error'; errorName: string }
  | { kind: 'invalid_output'; detail: string }

export interface GenerateTripDeps {
  client: GeminiJsonClient
  createId?: () => string
  report?: (event: GenerationFailureEvent) => void
}

const GEMINI_FAILURE_MESSAGES: Record<GeminiCallFailureReason, string> = {
  not_configured: 'サーバーの旅程生成の設定が完了していないため、旅程を生成できません。',
  api_error:
    'AIによる旅程生成サービスに接続できませんでした。時間をおいて、もう一度お試しください。',
  blocked: 'AIが入力内容を処理できませんでした。希望条件を見直して、もう一度お試しください。',
  incomplete: 'AIの旅程生成が途中で終了しました。時間をおいて、もう一度お試しください。',
  empty_response: 'AIから旅程が返されませんでした。時間をおいて、もう一度お試しください。',
}

const externalFailure = (message: string): ProposalFailure => ({
  status: 'external_service_error',
  message,
})

const invalidOutputFailure = (detail: string): ProposalFailure => ({
  status: 'no_candidates',
  message: `AIの生成結果が旅程の条件を満たさなかったため、候補を作れませんでした（${detail}）。もう一度お試しください。`,
})

// Geminiに旅程の下書きを作らせ、共通データモデルのTripに変換して「提案」として返す。
// 承認・保存・確定はしない。Places/Routesによる照合も行わず、根拠（evidence）は空のまま返す。
export async function generateTrip(
  request: GenerateTripRequest,
  deps: GenerateTripDeps,
): Promise<GenerateTripResponse> {
  const { client, createId = () => crypto.randomUUID(), report } = deps
  const { systemInstruction, prompt } = buildTripPrompt(request)

  let text: string
  try {
    // 課金対象のAPI呼び出しは1回だけ行い、失敗時の自動再試行はしない。
    text = await client.generateJson({
      systemInstruction,
      prompt,
      responseJsonSchema: buildDraftResponseJsonSchema(),
    })
  } catch (error) {
    if (error instanceof GeminiCallError) {
      report?.({ kind: 'gemini_call', reason: error.reason, status: error.status })
      return externalFailure(GEMINI_FAILURE_MESSAGES[error.reason])
    }
    report?.({
      kind: 'unexpected_client_error',
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return externalFailure(GEMINI_FAILURE_MESSAGES.api_error)
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    report?.({ kind: 'invalid_output', detail: 'JSONとして解釈できない' })
    return invalidOutputFailure('出力を解釈できませんでした')
  }

  const draft = GeneratedTripDraftSchema.safeParse(json)
  if (!draft.success) {
    const paths = [...new Set(draft.error.issues.map((issue) => issue.path.join('.') || '(root)'))]
    report?.({ kind: 'invalid_output', detail: `下書きの形式が不正: ${paths.join(', ')}` })
    return invalidOutputFailure('出力の形式が不正です')
  }

  if (draft.data.failure) {
    // AIが作れないと申告した場合。AIの回答であることが分かるようにして返す。
    return {
      status: draft.data.failure.status,
      message: `AIの回答: ${draft.data.failure.reason}`,
    }
  }

  const assembled = assembleTrip(request, draft.data, createId)
  if (!assembled.ok) {
    report?.({ kind: 'invalid_output', detail: assembled.reason })
    return invalidOutputFailure(assembled.reason)
  }
  return { status: 'proposed', trip: assembled.trip }
}
