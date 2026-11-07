// 表示用の整形。与えられた値を文字列にするだけで、現在時刻やロケールの設定には依存しない。

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

// ISO 8601の日時（オフセット付き）を「2026年11月8日 11:30（UTC+09:00）」の形にする。
// 時刻は変換せず、与えられた文字列の値をそのまま使う。解釈できない文字列は、そのまま返す。
export function formatCheckedAt(timestamp: string): string {
  const match = TIMESTAMP_PATTERN.exec(timestamp)
  if (!match) return timestamp
  const [, year, month, day, hour, minute, offset] = match
  const zone = offset === 'Z' ? 'UTC' : `UTC${offset}`
  return `${year}年${Number(month)}月${Number(day)}日 ${hour}:${minute}（${zone}）`
}

// 分を「◯分」「◯時間」「◯時間◯分」にする（「約」は付けない）。
export function formatSpan(minutes: number): string {
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`
}

// 所要時間の表示。0分には「約」を付けない。
export function formatApproxDuration(minutes: number): string {
  return minutes === 0 ? '0分' : `約${formatSpan(minutes)}`
}
