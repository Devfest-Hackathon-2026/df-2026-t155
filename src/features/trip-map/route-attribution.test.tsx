// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { sampleTrip } from '@/domain/samples'
import { TripRouteView } from './trip-route-view'

afterEach(cleanup)

it('路線図ではGoogle由来の根拠のみに帰属を付ける', () => {
  const trip = structuredClone(sampleTrip)
  trip.stops[0].evidence[0].source = { kind: 'places', label: 'Google Places' }
  render(<TripRouteView trip={trip} />)
  const googleStop = screen.getByRole('button', { name: /朝の庭園/ })
  const simulatedStop = screen.getByRole('button', { name: /昼食店A/ })
  expect(within(googleStop).getByText('Google Maps')).toBeTruthy()
  expect(within(simulatedStop).queryByText('Google Maps')).toBeNull()
})
