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

it.each([
  {
    city: '大阪城',
    theme: '大阪の城と街歩き',
    region: '大阪市',
    preference: '大阪の街を歩いて歴史を楽しみたい',
  },
  {
    city: '東京タワー',
    theme: '東京の名所めぐり',
    region: '東京都',
    preference: '東京の名所をめぐりたい',
  },
])(
  '写真テーマから追加都市を旅の下書きに反映する %#',
  async ({ city, theme, region, preference }) => {
    const onCreate = vi.fn()
    const user = userEvent.setup()
    render(
      <DiscoveryHome mode="home" onOpenHome={vi.fn()} onOpenTrips={vi.fn()} onCreate={onCreate} />,
    )

    await user.click(screen.getByRole('button', { name: new RegExp(theme) }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByLabelText<HTMLInputElement>('行き先').value).toBe(region)
    expect(screen.getByText(`写真から選んだテーマ：${theme}`)).toBeTruthy()
    expect(screen.getByRole('button', { name: new RegExp(`${city}.*${theme}`) })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '旅の条件へ進む' }))
    expect(onCreate).toHaveBeenCalledWith({ region, preferences: preference })
  },
)

it('写真テーマを選んでも手入力した行き先は維持する', async () => {
  const onCreate = vi.fn()
  const user = userEvent.setup()
  render(
    <DiscoveryHome mode="home" onOpenHome={vi.fn()} onOpenTrips={vi.fn()} onCreate={onCreate} />,
  )

  await user.type(screen.getByLabelText('行き先'), '横浜市')
  await user.click(screen.getByRole('button', { name: /大阪の城と街歩き/ }))

  expect(screen.getByLabelText<HTMLInputElement>('行き先').value).toBe('横浜市')
  expect(onCreate).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '旅の条件へ進む' }))
  expect(onCreate).toHaveBeenCalledWith({
    region: '横浜市',
    preferences: '大阪の街を歩いて歴史を楽しみたい',
  })
})

it('写真テーマの説明と検索例に追加した都市を案内する', () => {
  render(
    <DiscoveryHome mode="home" onOpenHome={vi.fn()} onOpenTrips={vi.fn()} onCreate={vi.fn()} />,
  )

  expect(screen.getByText(/愛知・名古屋を中心に、大阪・東京/)).toBeTruthy()
  expect(screen.getByLabelText<HTMLInputElement>('写真テーマを絞り込む').placeholder).toContain(
    '大阪城',
  )
  expect(screen.getByLabelText<HTMLInputElement>('写真テーマを絞り込む').placeholder).toContain(
    '東京タワー',
  )
})
