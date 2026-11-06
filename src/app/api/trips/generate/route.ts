import { createLazyVertexGeminiClient } from '../../../../server/gemini/client'
import {
  generateTrip,
  type GenerationFailureEvent,
} from '../../../../server/trip-generation/generate-trip'
import {
  handleGenerateTripRequest,
  isTripGenerationEnabled,
} from '../../../../server/trip-generation/handler'

// Vertex AIのSDKはNode.jsで動かす（Edgeでは使わない）。
export const runtime = 'nodejs'

// 接続の準備は最初のリクエストまで遅らせる。環境変数が未設定でもビルドは失敗しない。
const client = createLazyVertexGeminiClient(process.env)

const logFailure = (event: GenerationFailureEvent) => {
  console.error('[trip-generation] 生成に失敗', event)
}

export async function POST(request: Request): Promise<Response> {
  return handleGenerateTripRequest(request, {
    isEnabled: () => isTripGenerationEnabled(process.env),
    generate: (tripRequest) => generateTrip(tripRequest, { client, report: logFailure }),
  })
}
