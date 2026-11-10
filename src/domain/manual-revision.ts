import { z } from 'zod'

import { TextSchema } from './primitives'
import { TripRecordIdSchema } from './trip-write-limits'

export const MANUAL_CONFIRMATION_MAX = 1000

export const ManualConfirmationSchema = z.strictObject({
  source: TextSchema.max(MANUAL_CONFIRMATION_MAX),
  checked: TextSchema.max(MANUAL_CONFIRMATION_MAX),
  remaining: TextSchema.max(MANUAL_CONFIRMATION_MAX).optional(),
})

export const MANUAL_UNVERIFIED =
  '施設の特定・訪問時の営業・前後の移動は、適用時に外部サービスで照合していません。'

export const ManualRevisionGrantSchema = z.strictObject({
  id: TripRecordIdSchema.regex(/^manual-[a-zA-Z0-9-]+$/),
  token: z
    .string()
    .max(20_000)
    .regex(/^m[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/),
})

export const ManualApplyBodySchema = z.strictObject({
  expectedVersion: z.int().nonnegative(),
  token: ManualRevisionGrantSchema.shape.token,
  confirmation: ManualConfirmationSchema,
  confirm: z.literal(true),
})

export const ManualRecoveryBodySchema = ManualApplyBodySchema.pick({ expectedVersion: true })

export type ManualRevisionGrant = z.infer<typeof ManualRevisionGrantSchema>
export type ManualApplyBody = z.infer<typeof ManualApplyBodySchema>

// 同じ操作IDのまま確認内容を差し替えられないよう、初回送信前にIDを確定する。
export async function manualOperationId(
  grant: ManualRevisionGrant,
  confirmation: ManualApplyBody['confirmation'],
) {
  const input = new TextEncoder().encode(
    JSON.stringify([grant.token, ManualConfirmationSchema.parse(confirmation)]),
  )
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return ManualRevisionGrantSchema.shape.id.parse(`${grant.id}-${digest}`)
}
