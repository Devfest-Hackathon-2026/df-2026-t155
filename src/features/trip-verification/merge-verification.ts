import type { Trip } from '@/domain'
import { isGoogleSource } from '@/features/trip-map/model'

// 旅程の「内容」の比較と、照合の根拠の取り込み（純粋ロジック）。
// 固定のフラグは、施設の存在・営業時間・移動の根拠に影響しない（固定は承認・予約とも独立した、画面上の状態）。
// そのため、固定だけが違う旅程どうしでは、照合結果を取り下げたり、確認を中止したりしない。

// キーの並び順に依存しない比較のため、キーをソートして再帰的に並べ直す。
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    )
  }
  return value
}

// 固定の切り替えで変わる項目（各予定の固定フラグ、旅程の版）を除いた文字列。
// withVerification=false なら、照合が付ける項目（Place ID・根拠）も除く。
function comparable(trip: Trip, withVerification: boolean): string {
  return JSON.stringify(
    sortKeys({
      ...trip,
      version: 0,
      stops: trip.stops.map((stop) => ({
        ...stop,
        isFixed: false,
        ...(withVerification ? {} : { placeId: null, evidence: [] }),
      })),
    }),
  )
}

// 旅程の指紋：照合の対象になる内容（名称・時刻・滞在・種別・順序など）。
// 固定・版・Place ID・根拠は含めない。照合の前後で変わってよい項目だからである。
export const itineraryFingerprint = (trip: Trip): string => comparable(trip, false)

// 変更後の旅程が、変更前と「固定のフラグ（と、それに伴う版）だけ」違うか。
// Place ID・根拠も比べるので、根拠が差し替わった変更は「固定だけ」とは見なさない。
export const isFixedOnlyChange = (before: Trip, after: Trip): boolean =>
  comparable(before, true) === comparable(after, true)

// 現在の旅程に、照合結果の根拠（Place IDと、Places・Routes由来の証拠）を取り込む。固定や版は現在のものを残す。
// 照合中に利用者が切り替えた固定を、結果の到着で巻き戻さないための合成。予定はIDで対応させる。
// - Places・Routes由来の根拠とPlace IDは、今回の照合結果で置き換える（前回の結果は残さない。今回、同定できなかった
//   予定のPlace IDは、nullになる）。
// - 公式情報・本人の報告・模擬データ由来の根拠は、照合の結果ではないので、現在のものを残す（サーバーはこれらを
//   知らず、返さない）。応答に混ざった、Places・Routes以外の根拠は、取り込まない。
export function combineEvidence(current: Trip, verified: Trip): Trip {
  const checked = new Map(verified.stops.map((stop) => [stop.id, stop]))
  return {
    ...current,
    stops: current.stops.map((stop) => {
      const found = checked.get(stop.id)
      if (!found) return stop
      const fresh = found.evidence.filter((item) => isGoogleSource(item.source.kind))
      const freshIds = new Set(fresh.map((item) => item.id))
      const kept = stop.evidence.filter(
        (item) => !isGoogleSource(item.source.kind) && !freshIds.has(item.id),
      )
      return { ...stop, placeId: found.placeId, evidence: [...kept, ...fresh] }
    }),
  }
}

// 照合の結果を、確認中に変わったかもしれない現在の旅程へ取り込む。
// 送った旅程・現在の旅程・結果の内容が同じ（固定と根拠以外が同一）ときだけ、合成した旅程を返す。
// 内容が違えば null（古い照合結果を、変わった旅程に重ねない）。
export function mergeVerification(sent: Trip, current: Trip, result: Trip): Trip | null {
  const fingerprint = itineraryFingerprint(sent)
  if (
    fingerprint !== itineraryFingerprint(current) ||
    fingerprint !== itineraryFingerprint(result)
  ) {
    return null
  }
  return combineEvidence(current, result)
}
