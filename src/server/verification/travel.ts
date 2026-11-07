// 前の予定の終了から次の予定の開始までに、移動が間に合うかの決定論的な判定。
// 移動時間は、Routesの結果（呼び出し側が取得）。結果が無い・取得できないときは、間に合うとも
// 間に合わないとも言わず、「確認できない」にする。Geminiの推定時間で補わない。

export const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

export const formatMinutes = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

export interface GapInput {
  previous: { plannedStartTime: string; durationMinutes: number }
  next: { plannedStartTime: string }
}

// 前の予定の終了から、次の予定の開始までの時間（分）。負なら、すでに重なっている。
export function availableMinutes({ previous, next }: GapInput): number {
  return (
    toMinutes(next.plannedStartTime) -
    (toMinutes(previous.plannedStartTime) + previous.durationMinutes)
  )
}

// 予定が、時刻順に並び、重なっていないか。重なっていれば、移動を調べるまでもなく成立しない。
export function hasTimeConflict(
  stops: readonly { plannedStartTime: string; durationMinutes: number }[],
): boolean {
  return stops.some(
    (stop, index) => index > 0 && availableMinutes({ previous: stops[index - 1], next: stop }) < 0,
  )
}

export type TravelFit =
  { status: 'fits'; slackMinutes: number } | { status: 'too_long'; slackMinutes: number }

// 余裕（分）＝使える時間 − 移動時間。0以上なら間に合う（ちょうども可）。
export function evaluateTravel(available: number, travelMinutes: number): TravelFit {
  const slackMinutes = available - travelMinutes
  return slackMinutes >= 0 ? { status: 'fits', slackMinutes } : { status: 'too_long', slackMinutes }
}
