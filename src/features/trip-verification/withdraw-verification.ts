import type { Evidence, Stop, Trip } from '@/domain'
import { evidenceTarget } from '@/features/trip-map/evidence-scope'
import { isGoogleSource } from '@/features/trip-map/model'

// 旅程の内容が変わったとき、「現在の予定に対して有効な根拠」だけを残す（純粋ロジック）。
//
// 前提：変更前の旅程（before）に付いている根拠は、変更前の旅程に対して有効だった。
// 変更後の旅程（after）の根拠のうち、照合（Places・Routes）に由来するものを、次のとおり扱う。
// - 変更で新しく付いた根拠（部分修正の候補の根拠など）：変更後の予定に対して取った根拠なので、残す。
// - 変更前から引き継がれた根拠：その根拠が述べている範囲が、変更前と同一のときだけ残す。
//   - 施設の存在・営業時間：その予定の名称・種別・開始・滞在（と、旅程の日付・地域・タイムゾーン）とPlace IDが同一。
//   - 前の予定 → この予定の移動：この予定と前の予定が、どちらも同一（ID・内容・Place ID）で、前の予定が隣のまま。
//   - この予定 → 次の予定の移動：この予定と次の予定が、どちらも同一で、次の予定が隣のまま。
//   - 何についての根拠か特定できないもの：この予定と前後の予定のすべてが同一。
//   同一と確かめられないものは、取り下げる（未確認に戻す。肯定的な判定を維持しない）。
// - Place ID：変更前から引き継がれたものは、その予定の内容が同一のときだけ残す。新しく付いたものは残す。
// - 公式情報・本人の報告・模擬データ由来の根拠：照合の結果ではないので、そのまま残す。
//
// 変更前の「照合前の状態」へは戻さない。再照合の結果が「確認できない」だったものを、古い「整合」で
// 上書きしないため。根拠の配列が丸ごと一致するかどうかだけで有効性を決めない。
// 予定の名称・時刻・固定は、afterのまま変えない。

export interface WithdrawalResult {
  trip: Trip
  // 根拠またはPlace IDを、実際に取り下げたか。
  withdrawn: boolean
}

// 照合の結果に影響する、予定自身の内容。
const sameContent = (a: Stop, b: Stop): boolean =>
  a.name === b.name &&
  (a.kind ?? null) === (b.kind ?? null) &&
  a.plannedStartTime === b.plannedStartTime &&
  a.durationMinutes === b.durationMinutes

// 移動の区間の端として同一か（Routesは、両端のPlace IDで測っている）。
const sameEndpoint = (a: Stop, b: Stop): boolean => sameContent(a, b) && a.placeId === b.placeId

// 根拠が同一かを、全項目で比べる（引き継がれた根拠と、新しく付いた根拠の見分けに使う）。
const evidenceKey = (item: Evidence): string =>
  JSON.stringify([
    item.id,
    item.subject,
    item.claim,
    item.applicability,
    item.source.kind,
    item.source.label,
    item.source.url ?? null,
    item.checkedAt,
    item.status,
    item.explanation,
  ])

export function withdrawStaleVerification(before: Trip, after: Trip): WithdrawalResult {
  const sameTrip =
    before.date === after.date &&
    before.region === after.region &&
    before.timeZone === after.timeZone
  let withdrawn = false

  const stops = after.stops.map((stop, index) => {
    const beforeIndex = before.stops.findIndex((item) => item.id === stop.id)
    const old = before.stops[beforeIndex]
    // 変更前に無かった予定：引き継ぐ根拠が無い。付いている根拠は、変更で新しく付いたもの。
    if (!old) return stop

    const selfContent = sameTrip && sameContent(old, stop)
    const selfEndpoint = sameTrip && sameEndpoint(old, stop)

    // 隣の予定が、変更前と同一の端か。両方とも無い（端の予定のまま）なら absent。
    const neighbor = (offset: -1 | 1): 'absent' | 'same' | 'changed' => {
      const now = after.stops[index + offset]
      const was = before.stops[beforeIndex + offset]
      if (!now && !was) return 'absent'
      return now && was && now.id === was.id && sameTrip && sameEndpoint(was, now)
        ? 'same'
        : 'changed'
    }
    const previous = neighbor(-1)
    const next = neighbor(1)

    const carried = new Set(old.evidence.map(evidenceKey))
    const evidence = stop.evidence.filter((item) => {
      if (!isGoogleSource(item.source.kind)) return true
      if (!carried.has(evidenceKey(item))) return true
      switch (evidenceTarget(stop, item)) {
        case 'stop':
          // Placesの施設同定・営業時間はPlace IDの対象施設に紐づく。対象が変われば古い根拠を失効する。
          return selfContent && old.placeId === stop.placeId
        case 'from_previous':
          return selfEndpoint && previous === 'same'
        case 'to_next':
          return selfEndpoint && next === 'same'
        case 'unknown':
          return selfEndpoint && previous !== 'changed' && next !== 'changed'
      }
    })

    // 引き継がれたPlace IDは、予定の内容が同一のときだけ残す。新しく付いたPlace IDは、上書きしない。
    const placeId =
      stop.placeId !== null && stop.placeId === old.placeId && !selfContent ? null : stop.placeId

    if (evidence.length === stop.evidence.length && placeId === stop.placeId) return stop
    withdrawn = true
    return { ...stop, evidence, placeId }
  })

  return withdrawn ? { trip: { ...after, stops }, withdrawn } : { trip: after, withdrawn }
}
