// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { replace, pathname, homeRender } = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: { value: '/' as string },
  homeRender: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ replace }),
}))

vi.mock('@/features/home/session-home-planner', () => ({
  SessionHomePlanner: () => {
    homeRender()
    return <div>保護された旅づくりホーム</div>
  },
}))

import Home from './page'

beforeEach(() => {
  replace.mockReset()
  homeRender.mockReset()
  pathname.value = '/'
  window.localStorage.clear()
})

afterEach(cleanup)

it('first visit opens Welcome before mounting the protected home', () => {
  render(<Home />)

  expect(replace).toHaveBeenCalledWith('/welcome')
  expect(screen.queryByText('保護された旅づくりホーム')).toBeNull()
  expect(homeRender).not.toHaveBeenCalled()
})

it('returns to the protected home after Welcome was completed', async () => {
  window.localStorage.setItem('groundtrip:welcome-completed:v1', 'true')

  render(<Home />)

  expect(await screen.findByText('保護された旅づくりホーム')).toBeTruthy()
  await waitFor(() => expect(replace).not.toHaveBeenCalled())
  expect(homeRender).toHaveBeenCalledTimes(1)
})
