import { LearningReview } from '@/features/learning-review/learning-review'
import { sampleTrip } from '@/domain/samples'

// 振り返り画面の確認用ページ。旅程はサンプル（架空）で、実際の旅程の保存・読み込みは未接続。
// 学びの候補の作成APIは、LEARNING_CANDIDATES_ENABLED=true のときだけ動く。
export default function ReflectionPage() {
  return (
    <>
      <h1 className="mb-2 text-xl font-semibold">振り返りの確認ページ</h1>
      <p role="note" className="mb-6 text-sm">
        確認用のページです。旅程はサンプル（架空）で、実際の旅行の記録ではありません。
      </p>
      <LearningReview trip={sampleTrip} />
    </>
  )
}
