import { isCostlyApiEnabled } from '@/server/costly-api'
import { issueRevisionProposalTokens } from '@/server/persistence/revision-provenance'
import { FirestoreTripStore } from '@/server/persistence/trips'

import { COSTS } from '../../../../server/cost-control/costs'
import { meteredGemini, meteredMaps } from '../../../../server/cost-control/providers'
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
  if (event.kind === 'candidate_counts') {
    console.info('[trip-revision] 候補の集計', event)
    return
  }
  console.error(
    '[trip-revision] 候補の作成に失敗',
    event.kind === 'gemini_call' ? event : { kind: event.kind },
  )
}

export async function POST(request: Request): Promise<Response> {
  // 保存を有効にした環境だけ、本人報告の状態を確認・記録し、署名付きの候補を返す。
  // その読み書きは、候補の生成と同じ操作（予約）に含め、書き込みは書き込み権で確定する。
  const persistence = isCostlyApiEnabled(process.env.PERSISTENCE_ENABLED)
  return handleReviseTripRequest(request, {
    isEnabled: () => isTripRevisionEnabled(process.env),
    cost: persistence ? COSTS.reviseWithReports : COSTS.revise,
    revise: async (tripRequest, operation, actor) => {
      const report = persistence
        ? await new FirestoreTripStore().prepareRevisionGeneration(
            actor,
            tripRequest,
            operation.write,
            operation.assertActive,
          )
        : undefined
      if (report?.blocked && !report.reported) {
        return {
          status: 'insufficient_information',
          message: '未解消の本人報告があります。報告の状態を確認してください。',
        }
      }
      const result = await reviseTrip(tripRequest, {
        client: meteredGemini(operation, client),
        maps: meteredMaps(operation, maps),
        report: logFailure,
      })
      return report
        ? issueRevisionProposalTokens(actor, tripRequest, result, report.reportVersion)
        : result
    },
  })
}
