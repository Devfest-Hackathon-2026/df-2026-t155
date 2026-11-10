// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { DiscoveryHome } from './discovery-home'

afterEach(cleanup)

it('選んだテーマと希望を下書きで渡し、選択だけでは旅程を始めない', async () => {
  const onCreate = vi.fn()
  const user = userEvent.setup()
  render(
    <DiscoveryHome mode="home" onOpenHome={vi.fn()} onOpenTrips={vi.fn()} onCreate={onCreate} />,
  )

  await user.click(screen.getByRole('button', { name: /城と歴史/ }))
  expect(onCreate).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('旅の希望（任意）'), 'ゆっくり歩きたい')
  await user.click(screen.getByRole('button', { name: '旅の条件へ進む' }))

  expect(onCreate).toHaveBeenCalledWith({
    region: '名古屋市',
    preferences: '名古屋の歴史や街並みを楽しみたい\nゆっくり歩きたい',
  })
  const next = screen.getByRole('button', { name: '旅の条件へ進む' })
  await user.click(next)
  expect(onCreate).toHaveBeenLastCalledWith({})
  await user.clear(screen.getByLabelText('行き先'))
  await user.type(screen.getByLabelText('行き先'), '奈良市')
  await user.click(next)
  expect(onCreate).toHaveBeenLastCalledWith({ region: '奈良市' })
})

it('認証状態に関係なく空の地域でも条件入力へ進める', async () => {
  const onCreate = vi.fn()
  const user = userEvent.setup()
  render(
    <DiscoveryHome mode="home" onOpenHome={vi.fn()} onOpenTrips={vi.fn()} onCreate={onCreate} />,
  )

  const continueButton = screen.getByRole('button', { name: '旅の条件へ進む' })
  expect((continueButton as HTMLButtonElement).disabled).toBe(false)
  await user.click(continueButton)
  expect(onCreate).toHaveBeenCalledWith({})
})

it('写真の絞り込みに一致しなくても、行き先と希望を旅程条件に渡す', async () => {
  const onCreate = vi.fn()
  const user = userEvent.setup()
  render(
    <DiscoveryHome mode="home" onOpenHome={vi.fn()} onOpenTrips={vi.fn()} onCreate={onCreate} />,
  )

  await user.type(screen.getByLabelText('行き先'), '奈良市')
  await user.type(screen.getByLabelText('旅の希望（任意）'), 'ゆっくり歩きたい')
  const search = screen.getByLabelText('写真テーマを絞り込む')
  await user.type(search, '熱田')
  expect(screen.getByRole('button', { name: /神社と緑/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /城と歴史/ })).toBeNull()
  await user.clear(search)
  await user.type(search, '奈良')
  expect(screen.getByRole('status').textContent).toContain('一致する写真テーマはありません')

  await user.click(screen.getByRole('button', { name: '旅の条件へ進む' }))
  expect(onCreate).toHaveBeenCalledWith({ region: '奈良市', preferences: 'ゆっくり歩きたい' })
})
