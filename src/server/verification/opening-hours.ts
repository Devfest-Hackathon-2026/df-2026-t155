import type { OpeningPeriod } from '../maps'
import { formatMinutes, toMinutes } from './travel'

// 通常営業時間（Placesの`regularOpeningHours`）と、予定の滞在時間帯を照合する。
// 判定できるのは「通常営業時間の範囲内か」だけ。臨時休業・特別営業・混雑・予約の可否は判定できない。
// 曜日は、Placesの定義（0=日曜）。日付は、旅程のタイムゾーンで見た暦日として扱う。

const DAY = 24 * 60
const WEEK = 7 * DAY
const WEEKDAY_NAMES = [
  '日曜日',
  '月曜日',
  '火曜日',
  '水曜日',
  '木曜日',
  '金曜日',
  '土曜日',
] as const

export function weekdayIndex(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number)
  // Date.UTCは、0〜99年を1900年代として解釈するため、年は別に設定する。
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCDay()
}

export const weekdayName = (isoDate: string): string => WEEKDAY_NAMES[weekdayIndex(isoDate)]

const weekMinute = (point: { day: number; hour: number; minute: number }): number =>
  point.day * DAY + point.hour * 60 + point.minute

export type OpeningHoursCheck =
  | { status: 'consistent'; explanation: string }
  | { status: 'conflicting'; explanation: string }
  | { status: 'unverifiable'; explanation: string }

const CAVEAT = '臨時休業・特別営業は確認できません。'

export function checkOpeningHours(
  periods: readonly OpeningPeriod[],
  isoDate: string,
  startTime: string,
  durationMinutes: number,
): OpeningHoursCheck {
  // 空配列は、欠落とは別だが、営業とも休みとも解釈できない。「確認できない」とする（休みと決めつけない）。
  if (periods.length === 0) {
    return {
      status: 'unverifiable',
      explanation: '営業時間の情報が空のため、営業の有無を確認できません。',
    }
  }
  // 24時間営業の正規の表現は、日曜0:00開店・閉店なしの、ちょうど1件だけ。
  // 他の区間と並ぶ「閉店なし」や、日曜0:00以外の「閉店なし」は、24時間営業とは解釈できない。
  if (periods.length === 1 && !periods[0].close && weekMinute(periods[0].open) === 0) {
    return { status: 'consistent', explanation: `24時間営業として登録されています。${CAVEAT}` }
  }

  // 営業の区間を、週の先頭（日曜0:00）からの分で表す。日付をまたぐ営業は、閉店が開店より小さくなるため1週間足す。
  const intervals: [number, number][] = []
  // 閉店の情報が無く、解釈できなかった区間がある（データが不完全）。
  let incomplete = false
  for (const period of periods) {
    const open = weekMinute(period.open)
    if (!period.close) {
      incomplete = true
      continue
    }
    let close = weekMinute(period.close)
    // 開店と閉店が同じ曜日・時刻の区間は、丸1週間の営業とも、営業時間0とも解釈できない（不完全なデータ）。
    if (close === open) {
      incomplete = true
      continue
    }
    // 閉店が開店より小さいときだけ、週をまたぐ営業（日曜0:00をまたぐ）として、1週間足す。
    if (close < open) close += WEEK
    intervals.push([open - WEEK, close - WEEK], [open, close])
  }
  if (intervals.length === 0) {
    return {
      status: 'unverifiable',
      explanation: '営業時間のデータを解釈できないため、確認できません。',
    }
  }

  const dayStart = weekdayIndex(isoDate) * DAY
  const start = dayStart + toMinutes(startTime)
  const end = start + durationMinutes
  const stayLabel = `${startTime}〜${formatMinutes(toMinutes(startTime) + durationMinutes)}`

  // 滞在開始から切れ目なく確認できた時刻までを伸ばす。週初の滞在には前週の区間も使う。
  intervals.sort(([a], [b]) => a - b)
  let coveredUntil = start
  for (const [open, close] of intervals) {
    if (open > coveredUntil) break
    coveredUntil = Math.max(coveredUntil, close)
  }
  if (coveredUntil >= end) {
    return {
      status: 'consistent',
      explanation: `滞在時間帯（${stayLabel}）は、${weekdayName(isoDate)}の通常営業時間の範囲内です。${CAVEAT}`,
    }
  }

  // 解釈できない区間があるのに、確認できた区間の範囲外だけを理由に、営業時間外とは断定できない。
  if (incomplete) {
    return {
      status: 'unverifiable',
      explanation:
        '営業時間のデータの一部を解釈できないため、営業時間外とも、営業中とも断定できず、確認できません。',
    }
  }

  // その曜日に営業の区間が一切ないか（定休日の可能性）、あるが滞在時間帯と合わないか。
  const touchesDay = intervals.some(([open, close]) => open < dayStart + DAY && close > dayStart)
  return touchesDay
    ? {
        status: 'conflicting',
        explanation: `滞在時間帯（${stayLabel}）は、${weekdayName(isoDate)}の通常営業時間の範囲外です。`,
      }
    : {
        status: 'conflicting',
        explanation: `${weekdayName(isoDate)}の通常営業時間の記載がありません（定休日の可能性）。`,
      }
}
