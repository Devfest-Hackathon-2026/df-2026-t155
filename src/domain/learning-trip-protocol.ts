import { z } from 'zod'

export const LEARNING_TRIP_HEADER = 'X-GroundTrip-Learning-Trip'
export const LEARNING_TRIP_PROTOCOL = '1'
export const LEARNING_COUNT_HEADER = 'X-GroundTrip-Learning-Count'
export const PLACE_SAVE_PROOF_HEADER = 'X-GroundTrip-Place-Save-Proof'
export const LEARNING_TRIP_ID_PREFIX = 'learning-trip-'
export const LEARNING_TRIP_ID_PATTERN =
  /^learning-trip-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const PlaceSaveProofSchema = z.string().regex(/^p1\.[1-9][0-9]{12}\.[A-Za-z0-9_-]{43}$/)
export const LearningSaveProofSchema = z
  .string()
  .regex(/^v1\.[1-9][0-9]{12}(\.[A-Za-z0-9_-]{43}){2}$/)

export const learningSaveExpiresAt = (proof: string) => Number(proof.split('.')[1])
