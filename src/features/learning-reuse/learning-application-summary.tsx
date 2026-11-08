import type { ApprovedLearning, Trip } from '@/domain'

interface LearningApplicationSummaryProps {
  trip: Trip
  // 現在取得できた承認済みの学び。保存済みの旅程を開いた場合や、学びが後で撤回された場合は、
  // 適用記録に対応する学びが含まれないことがある。
  learnings: readonly ApprovedLearning[]
}

// Tripに残るのは、生成時にAIが申告して契約で検証された「適用先・説明」の記録。
// 学びが旅程差分を引き起こしたという因果関係や、制約成立を保証する表示ではない。
// 学びの内容が取得できなくても、記録は捨てずに表示する（記録が無いと誤って伝えない）。
export function LearningApplicationSummary({ trip, learnings }: LearningApplicationSummaryProps) {
  const byId = new Map(learnings.map((learning) => [learning.id, learning]))
  const stopNames = new Map(trip.stops.map((stop) => [stop.id, stop.name]))
  const records = trip.learningApplications.map((application) => ({
    learningId: application.learningId,
    // 取得できない場合はnull。空文字や別の文で補わない。
    content: byId.get(application.learningId)?.content ?? null,
    explanation: application.explanation,
    targets: application.targetStopIds.map(
      (id) => stopNames.get(id) ?? `この旅程で確認できない予定（${id}）`,
    ),
  }))

  return (
    <section aria-label="今回の旅程への学びの適用記録" className="space-y-2">
      <h2 className="text-lg font-semibold">選んだ学びはどう使われた？</h2>
      {records.length === 0 ? (
        <p className="text-sm">
          この旅程には、選んだ学びの適用記録がありません。
          選んだ学びが必ず予定を変えるとは限りません。
        </p>
      ) : (
        <ul className="space-y-3">
          {records.map((item, index) => (
            <li
              key={`${item.learningId}-${index}`}
              className="rounded-lg border border-current/20 p-3"
            >
              <p className="text-xs text-gt-muted">学びID：{item.learningId}</p>
              {item.content === null ? (
                <p className="mt-1 text-sm">
                  <span className="font-semibold">現在の内容：</span>
                  内容を取得できません（撤回または変更された可能性があります）
                </p>
              ) : (
                <p className="mt-1 text-sm">
                  <span className="font-semibold">現在の内容：</span>
                  {item.content}
                </p>
              )}
              <p className="mt-1 text-sm">対象：{item.targets.join('、')}</p>
              <p className="mt-1 text-sm">
                <span className="font-semibold">AIによる説明（未検証）：</span>
                {item.explanation}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gt-muted">
        上記は旅程生成時の適用記録です。
        学びの内容は現在保存されている内容で、生成した時点の内容とは限りません。
        説明はAIが書いた文で、内容の正しさは検証していません。
        別の条件で作った旅程との実測比較ではなく、旅程の違いが学びだけによるものだとは断定できません。
      </p>
    </section>
  )
}
