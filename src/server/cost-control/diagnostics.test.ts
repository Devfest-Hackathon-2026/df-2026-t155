import { afterEach, expect, it, vi } from 'vitest'

import { reportCostControlFailure } from './diagnostics'

afterEach(() => vi.restoreAllMocks())

it('予約障害の固定分類だけを、同じ分類について毎分1回記録する', () => {
  let now = 100_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  reportCostControlFailure('reservation_contention')
  reportCostControlFailure('reservation_contention')
  reportCostControlFailure('store_unavailable')
  now += 60_000
  reportCostControlFailure('reservation_contention')

  expect(log.mock.calls).toEqual([
    ['cost_control_failure', { code: 'reservation_contention' }],
    ['cost_control_failure', { code: 'store_unavailable' }],
    ['cost_control_failure', { code: 'reservation_contention' }],
  ])
})
