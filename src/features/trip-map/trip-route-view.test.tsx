// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TripSchema } from '@/domain'
import { sampleTrip } from '@/domain/samples'

import { RouteFailure, RouteLoading } from './route-states'
import { sampleRouteMeta } from './sample'
import { TripRouteView } from './trip-route-view'

afterEach(() => {
  cleanup()
})

const renderView = (props: Partial<React.ComponentProps<typeof TripRouteView>> = {}) =>
  render(<TripRouteView trip={sampleTrip} meta={sampleRouteMeta} {...props} />)

const stopButton = (name: RegExp) => screen.getByRole('button', { name })
const sheet = () => screen.getByRole('dialog')
const routeText = () => screen.getByRole('list', { name: '旅程の路線図' }).textContent ?? ''

describe('旅程の路線図: 表示', () => {
  it('地点を順番に、予定時刻・終了時刻・滞在時間とともに表示する', () => {
    renderView()
    const items = within(screen.getByRole('list', { name: '旅程の路線図' })).getAllByRole(
      'listitem',
    )

    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('朝の庭園（架空）')
    expect(items[0].textContent).toContain('10:00〜11:00')
    expect(items[0].textContent).toContain('60分')
    expect(items[1].textContent).toContain('12:00〜13:15')
    expect(items[1].textContent).toContain('75分')
    expect(items[2].textContent).toContain('14:00〜15:00')
  })

  it('固定予定は、ラベルで固定と分かる（色や形だけに頼らない）', () => {
    renderView()
    const items = screen.getAllByRole('listitem')

    expect(items[0].textContent).toContain('固定予定')
    expect(items[2].textContent).toContain('固定予定')
    expect(items[1].textContent).not.toContain('固定予定')
    expect(stopButton(/朝の庭園.*固定予定/)).toBeTruthy()
  })

  it('固定された観光地は、チケットにせず、「予約」とも表示しない', () => {
    renderView()
    const items = screen.getAllByRole('listitem')

    expect(items[0].textContent).toContain('固定')
    expect(items[0].textContent).not.toContain('予約')
    expect(items[2].textContent).toContain('予約')
  })

  it('3つの根拠の状態を、記号だけでなくラベルで区別する', () => {
    renderView()
    const items = screen.getAllByRole('listitem')

    expect(items[0].textContent).toContain('施設の存在：情報源と整合')
    expect(items[1].textContent).toContain('営業時間：矛盾あり')
    expect(items[2].textContent).toContain('営業時間：確認できない')
  })

  it('根拠が空の旅程は「未照合」と表示し、「情報源と整合」とは扱わない', () => {
    const unverifiedTrip = TripSchema.parse({
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop) => ({ ...stop, evidence: [] })),
    })
    render(<TripRouteView trip={unverifiedTrip} />)

    expect(routeText().match(/未照合/g)).toHaveLength(3)
    expect(routeText()).not.toContain('情報源と整合')
    expect(routeText()).not.toContain('確認できない')
  })

  it('移動区間を表示し、取得できていない区間は「未確認」とする（補完しない）', () => {
    renderView()

    expect(routeText()).toContain('次の地点まで：徒歩10分')
    expect(routeText()).toContain('次の地点まで：移動時間は未確認')
  })

  it('付加情報が無くても表示できる（移動区間は未確認として扱う）', () => {
    render(<TripRouteView trip={sampleTrip} />)

    expect(screen.getAllByText('次の地点まで：移動時間は未確認')).toHaveLength(2)
  })

  it('モックデータは明示する。そうでなければ出さない', () => {
    const { unmount } = renderView({ mock: true })
    expect(screen.getByRole('note').textContent).toContain('モックデータ（架空）')
    unmount()
    renderView()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('路線図が実際の地図ではないことを示す', () => {
    renderView()

    expect(screen.getByText(/実際の地図ではありません/)).toBeTruthy()
  })
})

describe('旅程の路線図: 選択と詳細', () => {
  it('予定を選ぶと詳細が開き、見出しにフォーカスが移る', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/昼食店A/))

    const dialog = sheet()
    expect(within(dialog).getByRole('heading', { name: '昼食店A（架空）' })).toBeTruthy()
    expect(dialog.textContent).toContain('2番目')
    expect(dialog.textContent).toContain('12:00〜13:15（75分）')
    expect(document.activeElement).toBe(within(dialog).getByRole('heading'))
    expect(stopButton(/昼食店A/).getAttribute('aria-pressed')).toBe('true')
  })

  it('根拠の詳細（確認項目・情報源・照合日時・説明）をタップで確認できる', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByText('根拠を見る'))

    const detail = sheet().textContent ?? ''
    expect(detail).toContain('確認項目')
    expect(detail).toContain('情報源')
    expect(detail).toContain('模擬データ')
    expect(detail).toContain('照合日時')
    expect(detail).not.toContain('取得日時')
    expect(detail).toContain('2026/11/08')
    expect(detail).toContain('情報源との矛盾があります')
  })

  it('「情報源と整合」は現実の正しさの保証ではないと明記する', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/朝の庭園/))
    await user.click(within(sheet()).getByText('根拠を見る'))

    expect(sheet().textContent).toContain('現実の正しさや将来の営業を保証するものではありません')
  })

  it('価格が取得できていない予定は「未確認」と表示する', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/朝の庭園/))

    expect(within(sheet()).getByText('未確認')).toBeTruthy()
  })

  it('Escapeキーと閉じるボタンで閉じる', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/昼食店A/))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('別の予定を選ぶと、詳細が切り替わる', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/朝の庭園/))
    await user.click(stopButton(/昼食店A/))

    expect(within(sheet()).getByRole('heading').textContent).toBe('昼食店A（架空）')
  })
})

describe('旅程の路線図: 固定の操作', () => {
  it('固定でない予定を固定でき、固定の表示が付く。保存されていないことを示す', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    expect(stopButton(/昼食店A.*固定予定/)).toBeTruthy()
    expect(
      within(sheet()).getByRole('button', { name: '固定を解除する' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('固定しました')
    expect(screen.getByRole('status').textContent).toContain('まだ保存されていません')
  })

  it('固定予定を解除できる。他の予定は変わらない', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/朝の庭園/))
    await user.click(within(sheet()).getByRole('button', { name: '固定を解除する' }))

    const items = screen.getAllByRole('listitem')
    expect(items[0].textContent).not.toContain('固定予定')
    expect(items[1].textContent).not.toContain('固定予定')
    expect(items[2].textContent).toContain('固定予定')
  })

  it('固定の操作で、渡された旅程そのものは書き換えない', async () => {
    const snapshot = JSON.stringify(sampleTrip)
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    expect(JSON.stringify(sampleTrip)).toBe(snapshot)
  })

  it('固定予定には、部分修正の対象にできないことを示す', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/14時の予約展示/))

    expect(sheet().textContent).toContain('固定予定です')
    expect(sheet().textContent).toContain('部分修正の対象にできません')
  })
})

describe('旅程の路線図: 修正対象の選択', () => {
  it('部分修正の入口が未提供なら、修正の操作は表示しない（未実装の操作を見せない）', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(stopButton(/昼食店A/))

    expect(within(sheet()).queryByRole('button', { name: /この予定だけ変更/ })).toBeNull()
  })

  it('固定でない予定では、選択した予定のIDで部分修正を始められる', async () => {
    const onStartRevision = vi.fn()
    const user = userEvent.setup()
    renderView({ onStartRevision })
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定だけ変更' }))

    expect(onStartRevision).toHaveBeenCalledTimes(1)
    expect(onStartRevision).toHaveBeenCalledWith('stop-lunch')
  })

  it('固定予定では、部分修正を始められない', async () => {
    const onStartRevision = vi.fn()
    const user = userEvent.setup()
    renderView({ onStartRevision })
    await user.click(stopButton(/14時の予約展示/))

    const button = within(sheet()).getByRole('button', { name: '固定中は変更できません' })
    expect(button.matches(':disabled')).toBe(true)
    fireEvent.click(button)
    expect(onStartRevision).not.toHaveBeenCalled()
  })

  it('固定した直後の予定は、部分修正の対象から外れる', async () => {
    const onStartRevision = vi.fn()
    const user = userEvent.setup()
    renderView({ onStartRevision })
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    const button = within(sheet()).getByRole('button', { name: '固定中は変更できません' })
    expect(button.matches(':disabled')).toBe(true)
  })
})

describe('旅程一覧の状態表示', () => {
  it('生成中の表示', () => {
    render(<RouteLoading />)

    expect(screen.getByText('旅程を生成しています。しばらくお待ちください。')).toBeTruthy()
  })

  it('失敗・情報不足の表示は、原因と次の行動を伝え、保証できないことは言わない', () => {
    render(
      <RouteFailure
        title="旅程を作るための情報が足りません"
        action="旅行先をより具体的にしてください。"
        message="AIの回答: 地域を特定できません"
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('エラー：旅程を作るための情報が足りません')
    expect(alert.textContent).toContain('旅行先をより具体的にしてください。')
    expect(alert.textContent).toContain('詳細：AIの回答: 地域を特定できません')
    // 元の旅程が保持されているとは、呼び出し側が明示しない限り、言わない。
    expect(alert.textContent).not.toContain('元の旅程')
    expect(alert.textContent).not.toContain('変更されていません')
  })

  it('保持されているものがあれば、呼び出し側が渡した説明だけを表示する', () => {
    render(<RouteFailure title="失敗" message="詳細" note="入力内容は保持されています。" />)

    expect(screen.getByRole('alert').textContent).toContain('入力内容は保持されています。')
  })
})
