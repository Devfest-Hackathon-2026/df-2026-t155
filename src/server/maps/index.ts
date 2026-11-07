import { createAdcMapsAuth, loadMapsConfig, type MapsAuth } from './auth'
import { computeRoute, type RouteOptions, type RouteResult } from './routes'
import { searchPlaces, type PlaceSearchResult, type SearchTextOptions } from './places'

export { MapsCallError, type MapsFailureReason } from './errors'
export type {
  OpeningHours,
  OpeningPeriod,
  PlaceCandidate,
  PlaceSearchResult,
  SearchTextOptions,
} from './places'
export type { RouteOptions, RouteResult, TravelMode } from './routes'

export interface MapsClient {
  searchPlaces(options: SearchTextOptions): Promise<PlaceSearchResult>
  computeRoute(options: RouteOptions): Promise<RouteResult>
}

export interface MapsClientDeps {
  auth: MapsAuth
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export function createMapsClient(deps: MapsClientDeps): MapsClient {
  return {
    searchPlaces: (options) => searchPlaces(deps, options),
    computeRoute: (options) => computeRoute(deps, options),
  }
}

// サーバーの環境変数とADCから作る。設定や認証の準備は、最初の呼び出しまで遅らせ、
// 環境変数が未設定でもビルドやモジュール読み込みは失敗しない（呼び出し時にMapsCallErrorになる）。
export function createLazyMapsClient(env: Record<string, string | undefined>): MapsClient {
  let client: MapsClient | undefined
  const get = () =>
    (client ??= createMapsClient({ auth: createAdcMapsAuth(loadMapsConfig(env).project) }))
  return {
    async searchPlaces(options) {
      return get().searchPlaces(options)
    },
    async computeRoute(options) {
      return get().computeRoute(options)
    },
  }
}
