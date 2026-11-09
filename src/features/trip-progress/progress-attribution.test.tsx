// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { sampleTrip } from '@/domain/samples'
import { TripProgressView } from './trip-progress-view'

afterEach(cleanup)

it('旅行中はGoogle由来の状態に帰属を付け、模擬情報には付けない', () => {
  const trip = structuredClone(sampleTrip)
  trip.stops[0].evidence[0].source = { kind: 'places', label: 'Google Places' }
  render(<TripProgressView trip={trip} />)
  expect(
    within(screen.getByRole('region', { name: 'いまの予定' })).getByText('Google Maps'),
  ).toBeTruthy()
  expect(
    within(screen.getByRole('region', { name: '次の予定' })).queryByText('Google Maps'),
  ).toBeNull()
})
