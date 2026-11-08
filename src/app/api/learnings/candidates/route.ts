import { meteredGemini } from '../../../../server/cost-control/providers'
import { createLazyVertexGeminiClient } from '../../../../server/gemini/client'
import {
  generateLearningCandidates,
  type CandidatesFailureEvent,
} from '../../../../server/learnings/generate-candidates'
import {
  handleLearningCandidatesRequest,
  isLearningCandidatesEnabled,
} from '../../../../server/learnings/handler'

// Vertex AIのSDKはNode.jsで動かす（Edgeでは使わない）。
export const runtime = 'nodejs'

// 接続の準備は最初のリクエストまで遅らせる。環境変数が未設定でもビルドは失敗しない。
const client = createLazyVertexGeminiClient(process.env)

const logFailure = (event: CandidatesFailureEvent) => {
  console.error(
    '[learning-candidates] 生成に失敗',
    event.kind === 'gemini_call' ? event : { kind: event.kind },
  )
}

export async function POST(request: Request): Promise<Response> {
  return handleLearningCandidatesRequest(request, {
    isEnabled: () => isLearningCandidatesEnabled(process.env),
    generate: (input, operation) =>
      generateLearningCandidates(input, {
        client: meteredGemini(operation, client),
        report: logFailure,
      }),
  })
}
