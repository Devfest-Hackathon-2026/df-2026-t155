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
    preferences: '歴史的な建築や街並みを楽しみたい\nゆっくり歩きたい',
  })
  const next = screen.getByRole('button', { name: '旅の条件へ進む' })
  await user.click(next)
  expect(onCreate).toHaveBeenLastCalledWith({})
  await user.clear(screen.getByLabelText('行き先'))
  await user.type(screen.getByLabelText('行き先'), '京都市')
  await user.click(next)
  expect(onCreate).toHaveBeenLastCalledWith({ region: '京都市' })
  expect(screen.getByRole('button', { name: /城と歴史/ }).getAttribute('aria-pressed')).toBe('true')
  await user.click(screen.getByRole('button', { name: 'テーマを外す' }))
  await user.click(next)
  expect(onCreate).toHaveBeenLastCalledWith({ preferences: 'ゆっくり歩きたい' })
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
  ['名古屋城', '城と歴史', '名古屋市', '歴史的な建築や街並みを楽しみたい'],
  [
    '熱田エリア',
    '神社と緑',
    '名古屋市熱田区',
    '緑のある場所や歴史・文化を感じる場所をゆっくり歩きたい',
  ],
  ['栄エリア', '街と水辺', '名古屋市中区', '街並みや水辺の景色を楽しみたい'],
  ['大阪城', '城と街歩き', '大阪市', '歴史を感じる場所を訪ねながら街歩きを楽しみたい'],
  ['東京タワー', '名所めぐり', '東京都', '街を代表する建築や名所をめぐりたい'],
])(
  '%sの写真テーマと行き先を独立して下書きに反映する',
  async (title, theme, region, preferences) => {
    const onCreate = vi.fn()
    const user = userEvent.setup()
    render(
      <DiscoveryHome mode="home" onOpenHome={vi.fn()} onOpenTrips={vi.fn()} onCreate={onCreate} />,
    )

    const photo = screen.getByRole('button', { name: `${title}の写真をテーマに選ぶ（${theme}）` })
    const destination = screen.getByLabelText<HTMLInputElement>('行き先')
    const next = screen.getByRole('button', { name: '旅の条件へ進む' })
    await user.click(photo)
    expect(onCreate).not.toHaveBeenCalled()
    expect(destination.value).toBe(region)
    await user.click(next)
    expect(onCreate).toHaveBeenLastCalledWith({ region, preferences })

    await user.clear(destination)
    await user.type(destination, '京都市')
    await user.click(next)
    expect(onCreate).toHaveBeenLastCalledWith({ region: '京都市' })

    await user.click(screen.getByRole('button', { name: 'テーマを外す' }))
    await user.click(next)
    expect(onCreate).toHaveBeenLastCalledWith({ preferences: '' })
    await user.click(photo)
    expect(destination.value).toBe('京都市')
    await user.click(next)
    expect(onCreate).toHaveBeenLastCalledWith({ preferences })

    await user.click(screen.getByRole('button', { name: `${region}を行き先に使う` }))
    expect(destination.value).toBe(region)
    await user.click(screen.getByRole('button', { name: '写真の行き先を解除' }))
    expect(destination.value).toBe('京都市')
    expect(photo.getAttribute('aria-pressed')).toBe('true')
  },
)

it.each([
  { source: '自動設定', manual: '', explicit: false, expected: '大阪市' },
  { source: '手入力', manual: '名古屋市', explicit: false, expected: '名古屋市' },
  { source: '明示採用', manual: '京都市', explicit: true, expected: '名古屋市' },
])(
  '$source の行き先で名古屋城から大阪城へテーマを切り替える',
  async ({ manual, explicit, expected }) => {
    const onCreate = vi.fn()
    const user = userEvent.setup()
    render(
      <DiscoveryHome mode="home" onOpenHome={vi.fn()} onOpenTrips={vi.fn()} onCreate={onCreate} />,
    )

    const destination = screen.getByLabelText<HTMLInputElement>('行き先')
    const next = screen.getByRole('button', { name: '旅の条件へ進む' })
    const osaka = screen.getByRole('button', { name: /大阪城の写真をテーマに選ぶ/ })
    if (manual) await user.type(destination, manual)
    await user.click(screen.getByRole('button', { name: /名古屋城の写真をテーマに選ぶ/ }))
    if (explicit) await user.click(screen.getByRole('button', { name: '名古屋市を行き先に使う' }))
    expect(destination.value).toBe('名古屋市')

    await user.click(osaka)
    expect(destination.value).toBe(expected)
    await user.click(next)
    expect(onCreate).toHaveBeenLastCalledWith({
      region: expected,
      preferences: '歴史を感じる場所を訪ねながら街歩きを楽しみたい',
    })

    if (explicit) {
      await user.click(screen.getByRole('button', { name: '写真の行き先を解除' }))
      expect(destination.value).toBe(manual)
      expect(osaka.getAttribute('aria-pressed')).toBe('true')
      await user.click(next)
      expect(onCreate).toHaveBeenLastCalledWith({ region: manual })
    }
  },
)

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
