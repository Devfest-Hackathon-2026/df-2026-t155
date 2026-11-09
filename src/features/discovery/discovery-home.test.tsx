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
    <DiscoveryHome
      mode="home"
      onOpenHome={vi.fn()}
      onOpenTrips={vi.fn()}
      onOpenRecords={vi.fn()}
      onCreate={onCreate}
    />,
  )

  await user.click(screen.getByRole('button', { name: /城と歴史/ }))
  expect(onCreate).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('旅の希望（任意）'), 'ゆっくり歩きたい')
  await user.click(screen.getByRole('button', { name: '旅の条件へ進む' }))

  expect(onCreate).toHaveBeenCalledWith({
    region: '名古屋市',
    preferences: '名古屋の歴史や街並みを楽しみたい\nゆっくり歩きたい',
  })
})

it('認証状態に関係なく空の地域でも条件入力へ進める', async () => {
  const onCreate = vi.fn()
  const user = userEvent.setup()
  render(
    <DiscoveryHome
      mode="home"
      onOpenHome={vi.fn()}
      onOpenTrips={vi.fn()}
      onOpenRecords={vi.fn()}
      onCreate={onCreate}
    />,
  )

  const continueButton = screen.getByRole('button', { name: '旅の条件へ進む' })
  expect((continueButton as HTMLButtonElement).disabled).toBe(false)
  await user.click(continueButton)
  expect(onCreate).toHaveBeenCalledWith({ region: '', preferences: '' })
})

it('検索は静的な写真テーマだけを絞り込み、保存旅程と記録の入口を通知する', async () => {
  const onOpenTrips = vi.fn()
  const onOpenRecords = vi.fn()
  const user = userEvent.setup()
  render(
    <DiscoveryHome
      mode="home"
      onOpenHome={vi.fn()}
      onOpenTrips={onOpenTrips}
      onOpenRecords={onOpenRecords}
      onCreate={vi.fn()}
    />,
  )

  await user.type(screen.getByLabelText('行き先やテーマを探す'), '熱田')
  expect(screen.getByRole('button', { name: /神社と緑/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /城と歴史/ })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'しおり' }))
  expect(onOpenTrips).toHaveBeenCalledOnce()
  await user.click(screen.getByRole('button', { name: '記録' }))
  expect(onOpenRecords).toHaveBeenCalledOnce()
})
