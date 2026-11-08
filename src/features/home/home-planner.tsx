'use client'

import { TripPlanner } from '@/features/trip-planner/trip-planner'
import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'
import { VerifiableTrip } from '@/features/trip-verification/verifiable-trip'
import type { VerifyTrip } from '@/features/trip-verification/use-trip-verification'

// トップ画面：旅行条件の入力と、生成された旅程の路線図表示、根拠の確認（照合）。
// 生成直後の旅程は未照合（根拠は空）。利用者が「根拠を確認する」を押したときだけ、照合APIを呼ぶ。
// 生成された旅程の種別・価格・移動区間は未取得のため、付加情報は渡さない。
// generate・verifyはテスト用の差し替え口。省略時は実際のAPIを呼ぶ。
export function HomePlanner({
  generate,
  verify,
}: {
  generate?: GenerateTrip
  verify?: VerifyTrip
}) {
  return (
    <TripPlanner
      generate={generate}
      renderTrip={(trip) => <VerifiableTrip key={trip.id} trip={trip} verify={verify} />}
    />
  )
}
