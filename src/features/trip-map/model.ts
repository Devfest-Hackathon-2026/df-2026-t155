import type { Evidence, EvidenceStatus, Stop, Trip } from '@/domain'

// 旅程の路線図UIが使う、画面表示用のモデルと純粋ロジック。
// 共通契約（Trip・Stop・Evidence）の型は重複して定義せず、契約に無い情報だけをここで補う。

// 駅の種別。契約のStopには種別が無いため、データ取得側が任意で付与する（無ければ観光扱いの駅）。
export type StopKind = 'sight' | 'meal' | 'reserved' | 'station'

export const stopKindLabels: Record<StopKind, string> = {
  sight: '観光',
  meal: '食事',
  // 予約が必要な予定という「種別」であり、予約済みという「状態」ではない（予約状況は照合していない）。
  reserved: '要予約',
  station: '駅',
}

// 前の地点からの移動区間。契約にはまだ移動区間のモデルが無い。
// Routes連携（#7）で取得できるまで、または取得できないとき（公共交通など）は「未確認」にする。
// 存在しない移動時間をAIに補完させない。
export type TravelSegment =
  | { status: 'known'; minutes: number; mode: 'walk' | 'drive' }
  | { status: 'unknown'; reason?: string }

export interface RouteStopMeta {
  kind?: StopKind
  // 価格の目安（表示用）。取得できていなければ指定しない。
  price?: string
  segmentFromPrevious?: TravelSegment
}

// Stop IDごとの付加情報。
export type RouteMeta = Record<string, RouteStopMeta>

export const evidenceSubjectLabels: Record<Evidence['subject'], string> = {
  place_identity: '施設の存在',
  opening_hours: '営業時間',
  travel_time: '移動時間',
  other: 'その他',
}

export const evidenceSourceLabels: Record<Evidence['source']['kind'], string> = {
  places: 'Google Places',
  routes: 'Google Routes',
  official: '公式情報',
  user_report: '本人の現地報告',
  simulation: '模擬データ',
}

const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

export const formatMinutes = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

// 予定の終了時刻（滞在は当日内に収まる契約）。
export function endTime(stop: Pick<Stop, 'plannedStartTime' | 'durationMinutes'>): string {
  return formatMinutes(toMinutes(stop.plannedStartTime) + stop.durationMinutes)
}

const severity: Record<EvidenceStatus, number> = { conflicting: 3, unverifiable: 2, consistent: 1 }

// 一覧で最初に見せる根拠。重大な矛盾・未確認を、情報源と整合の陰に隠さない。
export function worstEvidence(evidence: readonly Evidence[]): Evidence | null {
  let worst: Evidence | null = null
  for (const item of evidence) {
    if (!worst || severity[item.status] > severity[worst.status]) worst = item
  }
  return worst
}

// 固定状態だけを切り替えた新しいTripを返す（元は変更しない）。存在しないIDならnull。
// 固定は場所・時刻・滞在を含むStop全体の固定で、他の予定や内容は一切変えない。
// 【画面の先行実装用】保存や認可は#10。サーバー側の状態遷移が別途必要。
export function setStopFixed(trip: Trip, stopId: string, fixed: boolean): Trip | null {
  const target = trip.stops.find((stop) => stop.id === stopId)
  if (!target) return null
  if (target.isFixed === fixed) return trip
  return {
    ...trip,
    version: trip.version + 1,
    stops: trip.stops.map((stop) => (stop.id === stopId ? { ...stop, isFixed: fixed } : stop)),
  }
}
