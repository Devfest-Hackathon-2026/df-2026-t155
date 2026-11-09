import { z } from 'zod'

import { IdSchema, TextSchema } from './primitives'

export const TRIP_SAVE_MAX_BYTES = 64 * 1024
export const TRIP_REGION_MAX = 120
export const TRIP_PREFERENCE_MAX = 200
export const TRIP_PREFERENCES_MAX = 16
export const TRIP_STOP_NAME_MAX = 200
export const LEARNING_EXPLANATION_MAX = 240

export const TripRecordIdSchema = IdSchema.max(256).refine((id) => id.isWellFormed())
const boundedText = (max: number) => TextSchema.max(max).refine((value) => value.isWellFormed())
export const TripRegionSchema = boundedText(TRIP_REGION_MAX)
export const TripPreferencesSchema = z
  .array(boundedText(TRIP_PREFERENCE_MAX))
  .max(TRIP_PREFERENCES_MAX)
export const TripStopNameSchema = boundedText(TRIP_STOP_NAME_MAX)

export const LearningExplanationSchema = boundedText(LEARNING_EXPLANATION_MAX)
