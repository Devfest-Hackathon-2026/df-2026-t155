import { LEARNING_LIMIT, REVISION_LIMIT, TRIP_LIMIT } from '../persistence/limits'
import type { OperationCost } from './policy'

// 業務コールバックは1試行。SDK内部のRPC再送と請求量には別の不確実性があるため、従来の5倍予約を維持する。
const TRANSACTION_RESERVATION_MULTIPLIER = 5
const transaction = (reads: number, writes: number): OperationCost => ({
  reads: reads * TRANSACTION_RESERVATION_MULTIPLIER,
  writes: writes * TRANSACTION_RESERVATION_MULTIPLIER,
})

export const COSTS = {
  generate: { gemini: 1 },
  verify: { places: 4, routes: 3 },
  revise: { gemini: 1, places: 6, routes: 16 },
  learningCandidates: { gemini: 1 },
  listTrips: { reads: TRIP_LIMIT + 1 },
  getTrip: { reads: 1 },
  createTrip: transaction(2 + TRIP_LIMIT, 2),
  updateTrip: transaction(1, 1),
  listRevisions: { reads: 1 + REVISION_LIMIT + 1 },
  getRevision: { reads: 2 },
  saveRevision: transaction(3 + REVISION_LIMIT, 2),
  listLearnings: { reads: LEARNING_LIMIT + 1 },
  getLearning: { reads: 1 },
  approveLearning: transaction(3 + LEARNING_LIMIT, 2),
  revokeLearning: transaction(1, 1),
} satisfies Record<string, OperationCost>
