import { z } from 'zod'

export const IdSchema = z.string().trim().min(1)
export const TextSchema = z.string().trim().min(1)
export const DateSchema = z.iso.date()
export const TimestampSchema = z.iso.datetime({ offset: true })
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const TimeZoneSchema = TextSchema.refine((value) => {
  try {
    const timeZone = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone
    // Intlは固定オフセットも受け付けるため、正規化後の符号付き表記を除外する。
    return !/^[+-]/.test(timeZone)
  } catch {
    return false
  }
}, '有効なIANAタイムゾーンが必要です')

// 承認した本人の認可・編集後の再承認はアプリケーション層の責務。
export const ApprovalSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('approved'), decidedAt: TimestampSchema }),
  z.strictObject({ status: z.literal('rejected'), decidedAt: TimestampSchema }),
])

export type Approval = z.infer<typeof ApprovalSchema>
