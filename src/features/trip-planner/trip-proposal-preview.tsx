import type { Trip } from '@/domain'

// 生成された旅程の暫定表示。本格的な旅程一覧・固定予定の操作は#8のUIが担当するため、
// ここでは「何が提案されたか」を確認できる最小限の一覧にとどめる。
// 承認・保存・修正などの操作は、未実装のため表示しない。
export function TripProposalPreview({ trip }: { trip: Trip }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        これはAIの提案です。施設の情報や移動時間はまだ照合していません。承認・保存もされていません。
      </p>
      <p className="text-sm">
        {trip.date}・{trip.region}
      </p>
      <ol className="space-y-2">
        {trip.stops.map((stop) => (
          <li key={stop.id} className="rounded border border-current/30 p-3">
            <p className="font-medium">{stop.name}</p>
            <p className="text-sm">
              {stop.plannedStartTime}から{stop.durationMinutes}分
              {stop.isFixed ? '（固定予定）' : ''}
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}
