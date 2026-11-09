import { LEARNING_LIMIT, REVISION_LIMIT, TRIP_LIMIT } from '../persistence/limits'
import type { OperationCost } from './policy'

// 業務コールバックは1試行。SDK内部のRPC再送と請求量には別の不確実性があるため、従来の5倍予約を維持する。
const TRANSACTION_RESERVATION_MULTIPLIER = 5
const transaction = (reads: number, writes: number): OperationCost => ({
  reads: reads * TRANSACTION_RESERVATION_MULTIPLIER,
  writes: writes * TRANSACTION_RESERVATION_MULTIPLIER,
})

// 部分修正の候補生成。Gemini 1回、Places `3+N`、Routes `2+2N`（車を含めて最大）、候補 `N ≤ 3`。
const revise = { gemini: 1, places: 6, routes: 16 } satisfies OperationCost

// 本人報告の状態の読取（Trip 1件と、旧文書の復元に使う候補の最大 `REVISION_LIMIT + 1` 件）。
const REVISION_REPORT_READS = 2 + REVISION_LIMIT

export const createTripCost = (learningCount: number): OperationCost =>
  transaction(2 + TRIP_LIMIT + learningCount, 2)

export const COSTS = {
  generate: { gemini: 1 },
  // 選んだ学びを保存済みの現行版と照合する分（一覧の読み取り）を加える。
  generateWithLearnings: { gemini: 1, reads: LEARNING_LIMIT + 1 },
  verify: { places: 4, routes: 3 },
  revise,
  // 保存を有効にしたときの生成。生成の前に本人報告をTripへ記録することがあり、その取引は書き込み権で確定する。
  // 有料の予約（paid）と保存の予約（storage）を1つの操作で同時に取るため、どちらの枠も消費する。
  reviseWithReports: { ...revise, ...transaction(REVISION_REPORT_READS, 1) },
  learningCandidates: { gemini: 1 },
  listTrips: { reads: TRIP_LIMIT + 1 },
  getTrip: { reads: 1 },
  updateTrip: transaction(1, 1),
  listRevisions: { reads: 1 + REVISION_LIMIT + 1 },
  getRevision: { reads: 2 },
  // 親Trip・既存候補・本人報告の復元（最大 `REVISION_LIMIT + 1` 件）・保存枠（カウンター、または最大 `REVISION_LIMIT` 件）の読取。
  // 書き込みは候補・保存枠カウンター・Tripの本人報告状態。
  saveRevision: transaction(3 + REVISION_LIMIT + REVISION_LIMIT + 1, 3),
  getRevisionReport: { reads: REVISION_REPORT_READS },
  resolveRevisionReport: transaction(REVISION_REPORT_READS, 1),
  // 確定前の再検証（Places 4・Routes 4）と確定を1つの操作で予約する。読取14・書込10は暫定の保守枠
  // （初回2、再読取10、結果照会2。書込はTrip・候補の各1の5倍）。docs/API_ABUSE_PROTECTION.md 参照。
  // 有料と保存を同時に取るため、どちらの枠も消費する。
  applyRevision: { reads: 14, writes: 10, places: 4, routes: 4 },
  listLearnings: { reads: LEARNING_LIMIT + 1 },
  getLearning: { reads: 1 },
  approveLearning: transaction(3 + LEARNING_LIMIT, 2),
  revokeLearning: transaction(1, 1),
} satisfies Record<string, OperationCost>
