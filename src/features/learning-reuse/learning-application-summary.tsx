import type { ApprovedLearning, Trip } from '@/domain'

interface LearningApplicationSummaryProps {
  trip: Trip
  // 生成リクエスト時に選んだ版の表示内容。一覧を読み直しても差し替えない。
  learnings: readonly ApprovedLearning[]
}

// 生成時の入力と、AIが出力した適用先・説明を並べる。説明の正確さや学びの効果は未検証。
export function LearningApplicationSummary({ trip, learnings }: LearningApplicationSummaryProps) {
  if (learnings.length === 0 && trip.learningApplications.length === 0) return null

  const byId = new Map(learnings.map((learning) => [learning.id, learning]))
  const stopNames = new Map(trip.stops.map((stop) => [stop.id, stop.name]))
  const recordedIds = new Set(trip.learningApplications.map(({ learningId }) => learningId))
  const unreported = learnings.filter(({ id }) => !recordedIds.has(id))

  return (
    <section aria-label="生成時の学びの適用記録" className="space-y-2">
      <h3 className="text-lg font-semibold">生成時の学びの適用記録</h3>
      {trip.learningApplications.length > 0 && (
        <ul className="space-y-3">
          {trip.learningApplications.map(
            ({ learningId, learningVersion, targetStopIds, explanation }) => {
              const targets = targetStopIds.map(
                (id) => stopNames.get(id) ?? `この旅程で確認できない予定（${id}）`,
              )
              return (
                <li key={learningId} className="gt-card">
                  <p className="break-words text-sm">
                    <span>
                      {byId.get(learningId)?.content ??
                        `選択時の内容を確認できません（${learningId}）`}
                    </span>
                    {learningVersion !== undefined && ` · 版 ${learningVersion}`}
                  </p>
                  <p className="mt-1 break-words text-sm">
                    {trip.version === 0 ? '生成時の対象' : '対象の予定（現在の名称）'}：
                    {targets.join('、')}
                  </p>
                  <p className="mt-1 break-words text-sm">
                    <span className="font-semibold">AIによる説明（未検証）：</span>
                    {explanation}
                  </p>
                </li>
              )
            },
          )}
        </ul>
      )}
      {unreported.length > 0 && (
        <div className="gt-card text-sm">
          <p className="font-semibold">
            生成条件に渡した学びのうち、AIから反映先の報告がなかったもの
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {unreported.map(({ id, content }) => (
              <li key={id} className="break-words">
                {content}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-gt-muted">
        同じ条件でも生成結果は変わるため、学びが予定を変えたかは確認できません。
      </p>
    </section>
  )
}
