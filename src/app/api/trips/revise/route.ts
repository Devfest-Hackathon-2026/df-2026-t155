import { createLazyVertexGeminiClient } from '../../../../server/gemini/client'
import { createLazyMapsClient } from '../../../../server/maps'
import { handleReviseTripRequest, isTripRevisionEnabled } from '../../../../server/revision/handler'
import { reviseTrip, type RevisionFailureEvent } from '../../../../server/revision/revise-trip'

// Vertex AIのSDKとMapsのADC認証は、Node.jsで動かす（Edgeでは使わない）。
export const runtime = 'nodejs'

// 接続の準備は最初のリクエストまで遅らせる。環境変数が未設定でもビルドは失敗しない。
const client = createLazyVertexGeminiClient(process.env)
const maps = createLazyMapsClient(process.env)

const logFailure = (event: RevisionFailureEvent) => {
  console.error('[trip-revision] 候補の作成に失敗', event)
}

export async function POST(request: Request): Promise<Response> {
  return handleReviseTripRequest(request, {
    isEnabled: () => isTripRevisionEnabled(process.env),
    revise: (tripRequest) => reviseTrip(tripRequest, { client, maps, report: logFailure }),
  })
}
