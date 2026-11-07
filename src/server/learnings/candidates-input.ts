import { z } from 'zod'

import { RevisionSchema, TripSchema, type Revision } from '../../domain'

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

// 学びの材料にできる変更履歴。本人が承認した変更だけ（未承認・却下は、実際には起きていない）。
export function approvedRevisions(revisions: readonly Revision[]): Revision[] {
  return revisions.filter((revision) => revision.approval.status === 'approved')
}

// 模擬報告（デモ用の想定）は、実際に起きた出来事ではない。学びの事実にしない。
export function isSimulated(revision: Revision): boolean {
  return revision.context.phase === 'on_site' && revision.context.report.kind === 'simulated'
}

// 学びの材料にできる変更履歴：本人が承認した、実際の報告に基づくものだけ。
// 模擬報告（デモ用の想定）は、実際に起きた出来事ではないため、材料にもプロンプトにも含めない。
// AIへの指示だけに頼らず、アプリケーション側で確実に除外する（材料判定とプロンプト生成で共通に使う）。
export function usableRevisions(revisions: readonly Revision[]): Revision[] {
  return approvedRevisions(revisions).filter((revision) => !isSimulated(revision))
}

// 材料があるか（感想か、学びの材料にできる変更のどちらか）。無ければAIを呼ばずに、情報不足とする。
export function hasMaterial(input: Pick<LearningReviewInput, 'revisions' | 'feedback'>): boolean {
  return input.feedback.length > 0 || usableRevisions(input.revisions).length > 0
}
