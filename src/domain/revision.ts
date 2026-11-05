import { z } from 'zod'

import { StopSchema } from './models'
import { ApprovalSchema, IdSchema, TextSchema } from './primitives'

export const RevisionContextSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('planning') }),
  z.strictObject({
    phase: z.literal('on_site'),
    report: z.strictObject({
      kind: z.enum(['actual', 'simulated']),
      description: TextSchema,
    }),
  }),
])

// Places等による根拠の照合とは別の、決定論的な制約検証結果。
export const ConstraintCheckSchema = z.strictObject({
  status: z.enum(['not_checked', 'satisfied', 'violated', 'unknown']),
  explanation: TextSchema,
})

export const RevisionSchema = z
  .strictObject({
    id: IdSchema,
    tripId: IdSchema,
    baseTripVersion: z.int().nonnegative(),
    targetStopId: IdSchema,
    reason: TextSchema,
    context: RevisionContextSchema,
    // 元旅程全体を持たず、対象1件の前後だけを候補として保持する。
    diff: z.strictObject({ before: StopSchema, after: StopSchema }),
    impactSummary: TextSchema,
    constraintCheck: ConstraintCheckSchema,
    approval: ApprovalSchema,
  })
  .superRefine((revision, ctx) => {
    if (
      revision.diff.before.id !== revision.targetStopId ||
      revision.diff.after.id !== revision.targetStopId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['diff'],
        message: '修正前後のStop IDを維持してください',
      })
    }
    if (revision.diff.before.isFixed || revision.diff.after.isFixed) {
      ctx.addIssue({
        code: 'custom',
        path: ['diff'],
        message: '固定予定は部分修正の対象にできません',
      })
    }
    if (
      revision.approval.status === 'approved' &&
      revision.constraintCheck.status !== 'satisfied'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message: '制約を満たすと検証されていない候補は承認できません',
      })
    }
  })

export type RevisionContext = z.infer<typeof RevisionContextSchema>
export type ConstraintCheck = z.infer<typeof ConstraintCheckSchema>
export type Revision = z.infer<typeof RevisionSchema>
