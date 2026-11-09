import { expect, it } from 'vitest'
import { sampleTrip } from '@/domain/samples'
import { sameSavedTrip } from './saved-snapshot'

it('ignores transient evidence but rejects changed fixed stops and place IDs', () => {
  const saved = {
    ...sampleTrip,
    stops: sampleTrip.stops.map((stop) => ({ ...stop, evidence: [] })),
  }
  expect(sameSavedTrip(sampleTrip, saved)).toBe(true)
  expect(
    sameSavedTrip(
      {
        ...sampleTrip,
        stops: sampleTrip.stops.map((stop, index) =>
          index === 1 ? { ...stop, isFixed: !stop.isFixed } : stop,
        ),
      },
      saved,
    ),
  ).toBe(false)
  expect(
    sameSavedTrip(
      {
        ...sampleTrip,
        stops: sampleTrip.stops.map((stop, index) =>
          index === 1 ? { ...stop, placeId: 'changed' } : stop,
        ),
      },
      saved,
    ),
  ).toBe(false)
})
