// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import DemoEndedPage from '@/app/demo-ended/page'

import { DemoExitAction } from './demo-exit-action'

const { usePathname, getDemoSessionStatus, endDemoSession } = vi.hoisted(() => ({
  usePathname: vi.fn(),
  getDemoSessionStatus: vi.fn(),
  endDemoSession: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname }))
vi.mock('@/lib/auth/client', () => ({ endDemoSession }))
vi.mock('@/lib/firebase/client', () => ({ getDemoSessionStatus }))

const name = 'デモを終了する'

beforeEach(() => {
  vi.resetAllMocks()
  usePathname.mockReturnValue('/')
  getDemoSessionStatus.mockReturnValue('active')
})
afterEach(cleanup)

it.each(['inactive', 'unavailable'])(
  '通常利用と目印を読めない場合（%s）は終了ボタンを出さない',
  (status) => {
    getDemoSessionStatus.mockReturnValue(status)
    render(<DemoExitAction />)
    expect(screen.queryByRole('button', { name })).toBeNull()
    expect(endDemoSession).not.toHaveBeenCalled()
  },
)

it('デモの目印があってもアクセス券の交換画面では終了ボタンを出さない', () => {
  usePathname.mockReturnValue('/access')
  render(<DemoExitAction />)
  expect(screen.queryByRole('button', { name })).toBeNull()
  expect(endDemoSession).not.toHaveBeenCalled()
})

it('押したときだけ終了し、処理中の連打を抑止して、失敗後は再試行できる', async () => {
  const attempt = Promise.withResolvers<void>()
  endDemoSession.mockReturnValueOnce(attempt.promise).mockRejectedValueOnce(new Error())
  render(<DemoExitAction />)
  const button = screen.getByRole('button', { name })
  expect(endDemoSession).not.toHaveBeenCalled()
  button.focus()
  fireEvent.click(button)
  fireEvent.click(button)

  expect(endDemoSession).toHaveBeenCalledOnce()
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(button)
  expect(screen.getByRole('status').textContent).toBe('デモを終了しています。')

  await act(async () => attempt.reject(new Error()))
  expect(screen.getByRole('alert').textContent).toContain('もう一度押してください')
  expect(button.getAttribute('aria-disabled')).toBe('false')
  await act(async () => fireEvent.click(button))
  expect(endDemoSession).toHaveBeenCalledTimes(2)
})

it('履歴復元時は終了済みのデモの操作を表示しない', () => {
  render(<DemoExitAction />)
  expect(screen.getByRole('button', { name })).toBeTruthy()
  getDemoSessionStatus.mockReturnValue('inactive')
  act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  expect(screen.queryByRole('button', { name })).toBeNull()
  expect(endDemoSession).not.toHaveBeenCalled()
})

it('操作を始めた後でタブの目印が読めなくなっても再試行の案内を表示する', async () => {
  endDemoSession.mockImplementationOnce(async () => {
    getDemoSessionStatus.mockReturnValue('unavailable')
    throw new Error()
  })
  render(<DemoExitAction />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name })))
  expect(screen.getByRole('button', { name }).getAttribute('aria-disabled')).toBe('false')
  expect(screen.getByRole('alert').textContent).toContain('もう一度押してください')
})

it('終了画面から通常の入口に進める', () => {
  getDemoSessionStatus.mockReturnValue('inactive')
  render(<DemoEndedPage />)
  expect(screen.getByRole('heading', { name: 'デモを終了しました' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '通常の利用へ' }).getAttribute('href')).toBe('/')
  expect(endDemoSession).not.toHaveBeenCalled()
})

it('デモ利用中に終了画面を直接開いても終了済みと表示しない', () => {
  render(<DemoEndedPage />)
  expect(screen.queryByRole('heading', { name: 'デモを終了しました' })).toBeNull()
  expect(screen.queryByRole('link', { name: '通常の利用へ' })).toBeNull()
  expect(endDemoSession).not.toHaveBeenCalled()
})
