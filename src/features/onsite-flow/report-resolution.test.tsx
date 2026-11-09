// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ReportResolution } from './report-resolution'

afterEach(cleanup)

it('resolves a blocked report only after explicit confirmation using both versions', async () => {
  const load = vi.fn().mockResolvedValue({ tripVersion: 4, reportVersion: 2, blocked: true })
  const resolve = vi.fn().mockResolvedValue({ tripVersion: 4, reportVersion: 3, blocked: false })
  const done = vi.fn()
  render(
    <ReportResolution
      tripId="trip"
      stopId="stop"
      tripVersion={4}
      control={{ load, resolve }}
      onResolved={done}
    />,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '本人報告の状態を確認する' }))
  expect(resolve).not.toHaveBeenCalled()
  await user.click(await screen.findByRole('button', { name: '本人報告の保留を解消する' }))
  expect(resolve).toHaveBeenCalledWith('trip', 'stop', 4, 2, expect.any(AbortSignal))
  expect(done).toHaveBeenCalledOnce()
})

it('does not offer resolution against a different trip version', async () => {
  const load = vi.fn().mockResolvedValue({ tripVersion: 5, reportVersion: 2, blocked: true })
  const resolve = vi.fn()
  render(
    <ReportResolution
      tripId="trip"
      stopId="stop"
      tripVersion={4}
      control={{ load, resolve }}
      onResolved={vi.fn()}
    />,
  )
  await userEvent.click(screen.getByRole('button', { name: '本人報告の状態を確認する' }))
  expect(await screen.findByText(/旅程が更新されました/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '本人報告の保留を解消する' })).toBeNull()
})

it('discards a delayed report read when the target changes', async () => {
  let finish!: (value: { tripVersion: number; reportVersion: number; blocked: boolean }) => void
  const load = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const control = { load, resolve: vi.fn() }
  const props = { tripId: 'trip', tripVersion: 4, control, onResolved: vi.fn() }
  const { rerender } = render(<ReportResolution {...props} stopId="a" />)
  await userEvent.click(screen.getByRole('button', { name: '本人報告の状態を確認する' }))
  rerender(<ReportResolution {...props} stopId="b" />)
  await act(async () => {
    finish({ tripVersion: 4, reportVersion: 2, blocked: true })
  })
  expect(screen.queryByRole('button', { name: '本人報告の保留を解消する' })).toBeNull()
})
