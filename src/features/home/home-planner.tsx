'use client'

import { TripRouteView } from '@/features/trip-map/trip-route-view'
import { TripPlanner } from '@/features/trip-planner/trip-planner'
import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'

// トップ画面：旅行条件の入力と、生成された旅程の路線図表示。
// 生成された旅程の種別・価格・移動区間は未取得のため、付加情報は渡さない（未照合・未確認として表示される）。
// generateはテスト用の差し替え口。省略時は実際のAPIを呼ぶ。
export function HomePlanner({ generate }: { generate?: GenerateTrip }) {
  return (
    <TripPlanner
      generate={generate}
      renderTrip={(trip) => <TripRouteView key={trip.id} trip={trip} />}
    />
  )
}
