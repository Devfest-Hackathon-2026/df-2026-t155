import { TripSchema, type Trip } from '@/domain'

// Evidence is transient; all persisted fields, including fixed status and place IDs, must match.
function snapshot(trip: Trip): string {
  const parsed = TripSchema.parse(trip)
  return JSON.stringify({
    ...parsed,
    stops: parsed.stops.map((stop) => ({ ...stop, evidence: [] })),
  })
}

export function sameSavedTrip(current: Trip, saved: Trip): boolean {
  try {
    return snapshot(current) === snapshot(saved)
  } catch {
    return false
  }
}
