import { createLazyMapsClient } from '../../../../server/maps'
import {
  handleVerifyTripRequest,
  isTripVerificationEnabled,
} from '../../../../server/verification/handler'
import { verifyTrip } from '../../../../server/verification/verify-trip'

// Maps APIの呼び出しはNode.jsで行う（ADC認証のため、Edgeでは使わない）。
export const runtime = 'nodejs'

// 接続の準備は最初のリクエストまで遅らせる。環境変数が未設定でもビルドは失敗しない。
const maps = createLazyMapsClient(process.env)

export async function POST(request: Request): Promise<Response> {
  return handleVerifyTripRequest(request, {
    isEnabled: () => isTripVerificationEnabled(process.env),
    verify: (trip) => verifyTrip(trip, { maps }),
  })
}
