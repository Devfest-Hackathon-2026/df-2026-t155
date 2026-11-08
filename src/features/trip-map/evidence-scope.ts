import type { Evidence, Stop } from '@/domain'

// 根拠が「何について」述べているかの判定（純粋ロジック）。
// 路線図の移動区間のラベルと、詳細シートの「前の地点から」が、同じ判定に従うための1か所。
//
// 契約（Evidence）には、移動の根拠が「どの区間か」を表す項目が無い。サーバーは、移動の根拠のidを
//   `evidence-{予定のid}-travel`      … 前の予定 → この予定（verify-trip.ts／revise-trip.ts）
//   `evidence-{予定のid}-travel-next` … この予定 → 次の予定（revise-trip.ts。部分修正の候補だけ）
// として作る。この命名規約を、ここだけで読む。規約に合わない移動の根拠は、区間を特定できないもの
// （unknown）として扱い、「情報源と整合」などの判定には使わない（推測で区間に割り当てない）。
// 規約と、サーバーが実際に作る根拠の一致は、契約のテスト（evidence-scope.test.ts）で確かめている。

export type EvidenceTarget =
  // その予定そのもの（施設の存在・営業時間）
  | 'stop'
  // 前の予定 → この予定の移動
  | 'from_previous'
  // この予定 → 次の予定の移動
  | 'to_next'
  // 何についての根拠か、特定できない
  | 'unknown'

export function evidenceTarget(stop: Pick<Stop, 'id'>, evidence: Evidence): EvidenceTarget {
  switch (evidence.subject) {
    case 'place_identity':
    case 'opening_hours':
      return 'stop'
    case 'travel_time':
      if (evidence.id === `evidence-${stop.id}-travel`) return 'from_previous'
      if (evidence.id === `evidence-${stop.id}-travel-next`) return 'to_next'
      return 'unknown'
    default:
      return 'unknown'
  }
}

export interface SegmentEvidenceItem {
  evidence: Evidence
  // 根拠が付いている予定。destination＝区間の終点側（次の予定）、origin＝区間の起点側（前の予定）。
  owner: 'origin' | 'destination'
}

// 区間（stops[destinationIndex - 1] → stops[destinationIndex]）についての、Routes由来の根拠。
// - 終点側の予定に付いた「前の予定 → この予定」の根拠
// - 起点側の予定に付いた「この予定 → 次の予定」の根拠
// のうち、方向が合うものだけを返す。逆向きの根拠（B→CをA→Bとして扱う等）や、区間を特定できない根拠は含めない。
// 区間の両端が現在の旅程と一致するかは、旅程が変わるたびに withdraw-verification で確かめ、一致しない根拠は
// 旅程から取り除く。したがって、旅程に残っている根拠は、現在の両端についてのもの。
export function segmentEvidence(
  stops: readonly Stop[],
  destinationIndex: number,
): SegmentEvidenceItem[] {
  const origin = stops[destinationIndex - 1]
  const destination = stops[destinationIndex]
  if (!origin || !destination) return []
  return [
    ...destination.evidence
      .filter(
        (item) =>
          item.source.kind === 'routes' && evidenceTarget(destination, item) === 'from_previous',
      )
      .map((evidence) => ({ evidence, owner: 'destination' as const })),
    ...origin.evidence
      .filter((item) => item.source.kind === 'routes' && evidenceTarget(origin, item) === 'to_next')
      .map((evidence) => ({ evidence, owner: 'origin' as const })),
  ]
}
