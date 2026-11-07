import { z } from 'zod'

import { RevisionSchema, TripSchema } from '../../domain'

export const MAX_FEEDBACK_LENGTH = 1000

// 振り返りの入力。旅程・変更の履歴（部分修正）・本人の感想。
export const LearningReviewInputSchema = z
  .strictObject({
    trip: TripSchema,
    revisions: z.array(RevisionSchema).max(20),
    feedback: z.string().trim().max(MAX_FEEDBACK_LENGTH),
  })
  .superRefine((input, ctx) => {
    input.revisions.forEach((revision, index) => {
      if (revision.tripId !== input.trip.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['revisions', index, 'tripId'],
          message: '別の旅程の変更履歴が含まれています',
        })
      }
    })
  })

export type LearningReviewInput = z.infer<typeof LearningReviewInputSchema>

// 材料の判定は、画面と共通の純粋ロジック（src/lib/learnings/material.ts）を使う。
export {
  approvedRevisions,
  hasMaterial,
  isSimulated,
  usableRevisions,
} from '../../lib/learnings/material'
