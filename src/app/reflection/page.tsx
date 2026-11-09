import { sampleTrip } from '@/domain/samples'
import { LearningReview } from '@/features/learning-review/learning-review'
import { ReflectionFlow } from '@/features/reflection-flow/reflection-flow'

// /reflection は本人の保存済み旅程。/reflection?demo=1 だけは明示した架空デモ。
// tripIdは表示候補の指定であり、実データへのアクセス権限には使わない。
export default async function ReflectionPage({
  searchParams,
}: {
  searchParams: Promise<{ tripId?: string; demo?: string }>
}) {
  const { tripId, demo } = await searchParams
  if (demo === '1') {
    return (
      <>
        <h1 className="mb-2 text-xl font-semibold">振り返りの確認ページ</h1>
        <p role="note" className="mb-6 text-sm">
          デモ用の想定です。旅程・変更は架空で、実際の旅行の記録ではありません。
          この画面ではFirestoreへ保存せず、次の旅にも反映されません。
        </p>
        <LearningReview trip={sampleTrip} bindCandidatesToCurrentSession />
      </>
    )
  }
  return <ReflectionFlow initialTripId={tripId} />
}
