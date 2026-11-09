// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sampleTrip } from '@/domain/samples'
import { captureSessionScope } from '@/lib/auth/session-scope'
import { fakeAuth } from '../../../tests/helpers/fake-auth-client'
import { SavedTripChooser } from './saved-trip-chooser'

vi.mock('@/lib/auth/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/client')>('@/lib/auth/client')
  const { fakeAuth: fake } = await import('../../../tests/helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  fakeAuth.reset()
  fakeAuth.signInAs('user-a')
})
afterEach(cleanup)

it('loads saved trips only on user request and chooses the selected trip', async () => {
  const load = vi.fn().mockResolvedValue({
    trips: [sampleTrip],
    listInfo: { returned: 1, skippedInvalid: 0, truncated: false },
  })
  const choose = vi.fn()
  const scope = await captureSessionScope()
  render(<SavedTripChooser scope={scope} load={load} onChoose={choose} />)
  expect(load).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }))
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(sampleTrip.region) }))
  expect(choose).toHaveBeenCalledWith(sampleTrip)
})

it('does not load without an authenticated scope', async () => {
  const load = vi.fn()
  render(<SavedTripChooser scope={null} load={load} onChoose={vi.fn()} />)
  expect(
    screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }).hasAttribute('disabled'),
  ).toBe(true)
  expect(load).not.toHaveBeenCalled()
})

it('discards a response from the old scope even after returning to the same uid', async () => {
  const oldScope = await captureSessionScope()
  const stale = deferred<{
    trips: Array<typeof sampleTrip>
    listInfo: { returned: number; skippedInvalid: number; truncated: boolean }
  }>()
  const load = vi.fn().mockReturnValue(stale.promise)
  const choose = vi.fn()
  const view = render(<SavedTripChooser scope={oldScope} load={load} onChoose={choose} />)
  await userEvent.click(screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }))
  act(() => fakeAuth.signInAs('user-b'))
  const scopeB = await captureSessionScope()
  view.rerender(<SavedTripChooser scope={scopeB} load={load} onChoose={choose} />)
  act(() => fakeAuth.signInAs('user-a'))
  const returnedToA = await captureSessionScope()
  view.rerender(<SavedTripChooser scope={returnedToA} load={load} onChoose={choose} />)
  await act(async () => {
    stale.resolve({
      trips: [sampleTrip],
      listInfo: { returned: 1, skippedInvalid: 0, truncated: false },
    })
    await stale.promise
  })
  expect(screen.queryByRole('button', { name: new RegExp(sampleTrip.region) })).toBeNull()
  expect(choose).not.toHaveBeenCalled()
})

it('describes skipped and truncated saved trips separately', async () => {
  const scope = await captureSessionScope()
  const load = vi.fn().mockResolvedValue({
    trips: [sampleTrip],
    listInfo: { returned: 1, skippedInvalid: 2, truncated: true },
  })
  render(<SavedTripChooser scope={scope} load={load} onChoose={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }))
  expect(await screen.findByText(/読み込めなかった保存旅程が2件あります/)).toBeTruthy()
  expect(screen.getByText(/表示件数に上限があります/)).toBeTruthy()
})

it('shows distinct empty and request failure states', async () => {
  const scope = await captureSessionScope()
  const load = vi
    .fn()
    .mockResolvedValueOnce({
      trips: [],
      listInfo: { returned: 0, skippedInvalid: 0, truncated: false },
    })
    .mockRejectedValueOnce(new Error('offline'))
  render(<SavedTripChooser scope={scope} load={load} onChoose={vi.fn()} />)
  const open = screen.getByRole('button', { name: '保存した旅程で旅行を続ける' })
  await userEvent.click(open)
  expect(await screen.findByText('保存した旅程はありません。')).toBeTruthy()
  await userEvent.click(open)
  expect(await screen.findByText(/時間をおいて再度お試しください/)).toBeTruthy()
})

it('hides an old selection after the scope changes', async () => {
  const oldScope = await captureSessionScope()
  const load = vi.fn().mockResolvedValue({
    trips: [sampleTrip],
    listInfo: { returned: 1, skippedInvalid: 0, truncated: false },
  })
  const choose = vi.fn()
  const view = render(<SavedTripChooser scope={oldScope} load={load} onChoose={choose} />)
  await userEvent.click(screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }))
  const tripButton = await screen.findByRole('button', { name: new RegExp(sampleTrip.region) })
  act(() => fakeAuth.signInAs('user-b'))
  const nextScope = await captureSessionScope()
  view.rerender(<SavedTripChooser scope={nextScope} load={load} onChoose={choose} />)
  expect(screen.queryByRole('button', { name: new RegExp(sampleTrip.region) })).toBeNull()
  await userEvent.click(tripButton)
  expect(choose).not.toHaveBeenCalled()
})
