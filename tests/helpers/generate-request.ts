import { sampleGenerateTripRequest } from '@/domain/samples'
import type { LearningSelection } from '@/server/persistence/contracts'
import type { GenerateTripHttpRequest } from '@/server/trip-generation/http-request'

// POST /api/trips/generate に送る本文（HTTPの契約）。承認済みの学びの本文は含めず、選択（id と version）だけを持つ。
const { date, region, timeZone, preferences, fixedStops } = sampleGenerateTripRequest

export const sampleGenerateTripBody = (
  learningSelections: LearningSelection[] = [],
): GenerateTripHttpRequest => ({
  date,
  region,
  timeZone,
  preferences,
  fixedStops,
  learningSelections,
})
