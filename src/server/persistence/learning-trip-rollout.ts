import 'server-only'

import type { Trip } from '@/domain'
import { LEARNING_TRIP_HEADER, LEARNING_TRIP_PROTOCOL } from '@/domain/learning-trip-protocol'

import { PersistenceError } from './errors'

export const isLearningTripSaveEnabled = () => process.env.LEARNING_TRIP_SAVE_ENABLED === 'true'

export const acceptsLearningTripProtocol = (request: Request) =>
  request.headers.get(LEARNING_TRIP_HEADER) === LEARNING_TRIP_PROTOCOL

export function requireLearningTripReader(acceptsProtocol: boolean, trips: readonly Trip[]) {
  if (
    !acceptsProtocol &&
    trips.some((trip) =>
      trip.learningApplications.some(({ learningVersion }) => learningVersion !== undefined),
    )
  ) {
    throw new PersistenceError('learning_trip_upgrade_required')
  }
}
