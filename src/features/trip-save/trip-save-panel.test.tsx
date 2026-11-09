// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import { TripSavePanel } from './trip-save-panel'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const props = {
  trip: sampleTrip,
  scope: { uid: 'test-actor' },
  onSaved: vi.fn(),
  onCheckSaved: vi.fn(),
}

it('証跡を発行できなかった場合は保存を無効にし、回復と再生成の影響を表示する', () => {
  render(<TripSavePanel {...props} learningSaveUnavailable="signing_unavailable" />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /旅程を保存する/ }).disabled).toBe(
    true,
  )
  expect(screen.getByText(/証跡を発行できませんでした/)).toBeTruthy()
  expect(screen.getByText(/提案が変わることがあり、生成のAPI利用枠/)).toBeTruthy()
})

it('期限の5分前と期限切れを、保存操作なしで反映する', () => {
  vi.useFakeTimers()
  const expiresAt = Date.now() + 360_000
  const proof = `v1.${expiresAt}.${'A'.repeat(43)}.${'A'.repeat(43)}`
  render(<TripSavePanel {...props} learningSaveProof={proof} />)
  const button = screen.getByRole<HTMLButtonElement>('button', { name: /旅程を保存する/ })
  expect(button.disabled).toBe(false)
  act(() => vi.advanceTimersByTime(60_001))
  expect(screen.getByText(/まもなく期限切れ/)).toBeTruthy()
  expect(button.disabled).toBe(false)
  act(() => vi.advanceTimersByTime(300_000))
  expect(button.disabled).toBe(true)
  expect(screen.getByText(/保存用証跡の期限が切れました/)).toBeTruthy()
})
