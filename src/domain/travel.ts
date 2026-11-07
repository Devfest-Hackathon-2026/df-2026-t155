import { z } from 'zod'

import { IdSchema, TextSchema, TimestampSchema } from './primitives'

// Stop間の移動区間。Tripには含めず、独立した契約として扱う（永続保存の対象にも、現時点ではしない）。
// 「判明済み」と「未確認」を判別共用体で区別し、取得失敗・未対応を移動時間0や確認済みに変換しない。
// 実測していない時刻・所要時間を、AI（Gemini）で補完しない。
// 値の鮮度は`checkedAt`で示し、承認の根拠にするときは、適用直前にサーバー側で再検証する。
// 注意：`checkedAt`は照合した時刻を示すだけで、値の真正性や、現在も有効であることは保証しない。
// 出典`simulation`は模擬情報であり、実測・検証済みを意味しない。
//
// 検証の入口は`TravelSegmentSchema`に統一する。判明済み・未確認の個別スキーマは、手段と理由の整合などの
// 横断的な制約を持たないため、公開しない（個別の型は、公開してよい）。

// 判明済みの区間の手段。GroundTripのMVPでは、公共交通を照会の対象外とするため、判明済みにはできない。
export const KnownTravelModeSchema = z.enum(['walk', 'drive'])

// 未確認の区間の手段（意図した手段。公共交通は、未対応であることを示すために指定できる）。
export const TravelModeSchema = z.enum(['walk', 'drive', 'transit'])

export const TravelSegmentUnknownReasonSchema = z.enum([
  'not_queried', // まだ照会していない
  'transit_unsupported', // 公共交通は、GroundTripのMVPでは照会の対象外
  'no_route', // 照会したが、経路が見つからなかった
  'api_error', // 照会したが、API・接続が失敗した
])

// 実際に照会を試みた理由（この場合だけ、照合時刻を持つ）。
const ATTEMPTED_REASONS: readonly z.infer<typeof TravelSegmentUnknownReasonSchema>[] = [
  'no_route',
  'api_error',
]

const SegmentEndsSchema = {
  fromStopId: IdSchema,
  toStopId: IdSchema,
}

const KnownTravelSegmentSchema = z.strictObject({
  ...SegmentEndsSchema,
  status: z.literal('known'),
  mode: KnownTravelModeSchema,
  durationMinutes: z.int().nonnegative(),
  distanceMeters: z.int().nonnegative().optional(),
  // 出典と照合時刻は、判明済みでは必須。模擬情報は実測と区別する。
  source: z.strictObject({ kind: z.enum(['routes', 'simulation']), label: TextSchema }),
  checkedAt: TimestampSchema,
  explanation: TextSchema,
})

const UnknownTravelSegmentSchema = z.strictObject({
  ...SegmentEndsSchema,
  status: z.literal('unknown'),
  mode: TravelModeSchema,
  reason: TravelSegmentUnknownReasonSchema,
  // 実際に照会を試みた場合（経路なし・API失敗）だけ持つ。未照会・未対応では持たない。
  checkedAt: TimestampSchema.optional(),
  explanation: TextSchema,
})

export const TravelSegmentSchema = z
  .discriminatedUnion('status', [KnownTravelSegmentSchema, UnknownTravelSegmentSchema])
  .superRefine((segment, ctx) => {
    if (segment.fromStopId === segment.toStopId) {
      ctx.addIssue({
        code: 'custom',
        path: ['toStopId'],
        message: '出発と到着は別のStopにしてください',
      })
    }
    if (segment.status !== 'unknown') return
    const attempted = ATTEMPTED_REASONS.includes(segment.reason)
    if (attempted && segment.checkedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkedAt'],
        message: '照会を試みた場合は、照合時刻が必要です',
      })
    }
    if (!attempted && segment.checkedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkedAt'],
        message: '照会していない区間に、照合時刻は付けられません',
      })
    }
    // 手段が公共交通であることと、理由が「公共交通は照会対象外」であることは、必ず対応させる（双方向）。
    const transitMode = segment.mode === 'transit'
    const transitReason = segment.reason === 'transit_unsupported'
    if (transitReason && !transitMode) {
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: '公共交通の照会対象外は、手段をtransitにしてください',
      })
    }
    if (transitMode && !transitReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: '公共交通は照会対象外のため、理由はtransit_unsupportedにしてください',
      })
    }
  })

export type TravelMode = z.infer<typeof TravelModeSchema>
export type TravelSegment = z.infer<typeof TravelSegmentSchema>
export type KnownTravelSegment = z.infer<typeof KnownTravelSegmentSchema>
export type UnknownTravelSegment = z.infer<typeof UnknownTravelSegmentSchema>
