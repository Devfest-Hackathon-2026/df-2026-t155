import { describe, expect, it } from 'vitest'

import { TimeZoneSchema } from './primitives'

describe('TimeZoneSchema', () => {
  it.each(['Asia/Tokyo', 'UTC', 'Etc/UTC', 'Etc/GMT', 'Etc/GMT+9', 'Etc/GMT-9'])(
    '有効なIANAタイムゾーン識別子を受け入れる: %s',
    (timeZone) => {
      expect(TimeZoneSchema.parse(timeZone)).toBe(timeZone)
    },
  )

  it.each(['+09:00', '-05:30', '+0900', '+09', '+00:00', '−09:00', 'Unknown/Zone', ''])(
    '固定オフセットと無効な識別子を拒否する: %s',
    (timeZone) => {
      expect(TimeZoneSchema.safeParse(timeZone).success).toBe(false)
    },
  )
})
