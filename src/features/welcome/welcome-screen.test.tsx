// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))

import { WelcomeScreen } from './welcome-screen'

beforeEach(() => {
  replace.mockReset()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('continues once even when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage blocked')
  })
  const user = userEvent.setup()
  render(<WelcomeScreen />)

  const start = screen.getByRole('button', { name: '旅をはじめる' })
  await user.dblClick(start)

  expect(replace).toHaveBeenCalledTimes(1)
  expect(replace).toHaveBeenCalledWith('/')
})
