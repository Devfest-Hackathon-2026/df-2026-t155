import { z } from 'zod'

import { MapsCallError } from './errors'
import { postJson, type MapsTransportDeps } from './transport'

// Routes API の経路計算（computeRoutes）のアダプター。Place ID同士の移動時間を返す。
// 公共交通（TRANSIT）は対象外：日本のGoogle Transitパートナーは、公式FAQでRoutes APIの
// サポート対象から除かれ、実測でも4回とも空応答だった。呼び出さず、照合側が「確認できない」にする。
// 保存の条件：保存してよいのはPlace IDだけ。所要時間・距離は、処理中に使い、保存しない。

export const ROUTES_COMPUTE_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'

// 請求・遅延を抑えるため、所要時間と距離だけを要求する。
const FIELD_MASK = 'routes.duration,routes.distanceMeters'

// 日帰り旅程の移動として、現実的な上限（7日分の秒数）。これを超える値は、不正な応答として扱う。
export const MAX_ROUTE_SECONDS = 7 * 24 * 60 * 60

// 距離も、地球上の経路として現実的な上限（2万km）を超える値は、不正として扱う。
export const MAX_ROUTE_DISTANCE_METERS = 20_000_000

export const SUPPORTED_TRAVEL_MODES = ['WALK', 'DRIVE'] as const
export type TravelMode = (typeof SUPPORTED_TRAVEL_MODES)[number]

const RawResponseSchema = z.object({
  routes: z
    .array(
      z.object({
        // "123s" の形式（秒）。
        duration: z.string().regex(/^\d+(\.\d+)?s$/),
        distanceMeters: z.int().nonnegative().max(MAX_ROUTE_DISTANCE_METERS).optional(),
      }),
    )
    .optional(),
})

export interface RouteOptions {
  originPlaceId: string
  destinationPlaceId: string
  mode: TravelMode
}

// 経路なし（HTTP 200で空）と、呼び出しの失敗（MapsCallErrorを投げる）を区別する。
// 空応答はHTTPエラーにならない。「経路なし」を「移動時間0」や「間に合う」と解釈しないこと。
export type RouteResult =
  | { status: 'found'; durationSeconds: number; minutes: number; distanceMeters?: number }
  | { status: 'no_route' }

export async function computeRoute(
  deps: MapsTransportDeps,
  options: RouteOptions,
): Promise<RouteResult> {
  const { originPlaceId, destinationPlaceId, mode } = options
  if (!(SUPPORTED_TRAVEL_MODES as readonly string[]).includes(mode)) {
    throw new MapsCallError('unsupported_mode', '指定された移動手段は対象外です')
  }
  if (!originPlaceId.trim() || !destinationPlaceId.trim()) {
    throw new MapsCallError('invalid_request', 'Routesの出発地・目的地の指定が正しくありません')
  }

  const json = await postJson(deps, {
    url: ROUTES_COMPUTE_URL,
    fieldMask: FIELD_MASK,
    body: {
      origin: { placeId: originPlaceId },
      destination: { placeId: destinationPlaceId },
      travelMode: mode,
      languageCode: 'ja-JP',
    },
  })

  const parsed = RawResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new MapsCallError('invalid_response', 'Routesの応答の形式が想定と異なります')
  }
  const route = parsed.data.routes?.[0]
  if (!route) return { status: 'no_route' }

  const durationSeconds = Math.ceil(Number.parseFloat(route.duration))
  // 桁数の多い文字列は、数値に変換するとInfinityになる。有限で、現実的な範囲の値だけを受け入れる。
  if (!Number.isFinite(durationSeconds) || durationSeconds > MAX_ROUTE_SECONDS) {
    throw new MapsCallError('invalid_response', 'Routesの応答の値が想定の範囲外です')
  }
  return {
    status: 'found',
    durationSeconds,
    // 時間の余裕の比較は安全側（長め）に倒すため、切り上げる。
    minutes: Math.ceil(durationSeconds / 60),
    distanceMeters: route.distanceMeters,
  }
}
