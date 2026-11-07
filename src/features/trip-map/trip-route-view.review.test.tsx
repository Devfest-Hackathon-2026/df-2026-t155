// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TripSchema, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'

import { sampleRouteMeta } from './sample'
import { TripRouteView } from './trip-route-view'

afterEach(() => {
  cleanup()
})

const stopButton = (name: RegExp) => screen.getByRole('button', { name })
const sheet = () => screen.getByRole('dialog')
const items = () => screen.getAllByRole('listitem')

// 別の旅程（地点の名前とIDが異なる）。親が新しい旅程を渡す場面を作る。
const otherTrip: Trip = TripSchema.parse({
  ...sampleTrip,
  id: 'trip-other',
  learningApplications: [],
  stops: sampleTrip.stops.map((stop, index) => ({
    ...stop,
    id: `other-${index}`,
    name: `別の地点${index + 1}`,
    isFixed: false,
  })),
})

describe('Tripの同期（指摘1）', () => {
  it('親から新しいTripが渡されたら、表示が更新される', () => {
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    expect(items()[0].textContent).toContain('朝の庭園（架空）')

    rerender(<TripRouteView trip={otherTrip} />)

    expect(items()[0].textContent).toContain('別の地点1')
    expect(screen.queryByText('朝の庭園（架空）')).toBeNull()
  })

  it('固定の切り替えは、最新のTripを親へ渡す（版を1上げ、他は変えない）', async () => {
    const onTripChange = vi.fn()
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} onTripChange={onTripChange} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    expect(onTripChange).toHaveBeenCalledTimes(1)
    const next: Trip = onTripChange.mock.calls[0][0]
    expect(next.version).toBe(sampleTrip.version + 1)
    expect(next.stops[1].isFixed).toBe(true)
    expect(next.stops[0]).toEqual(sampleTrip.stops[0])
    expect(next.stops[2]).toEqual(sampleTrip.stops[2])
  })

  it('続けて操作しても、親へ渡すTripは、直前の変更を含む最新の状態', async () => {
    const onTripChange = vi.fn()
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} onTripChange={onTripChange} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(stopButton(/朝の庭園/))
    await user.click(within(sheet()).getByRole('button', { name: '固定を解除する' }))

    const latest: Trip = onTripChange.mock.calls[1][0]
    expect(latest.version).toBe(sampleTrip.version + 2)
    expect(latest.stops.map((stop) => stop.isFixed)).toEqual([false, true, true])
  })

  it('親が受け取ったTripを渡し直しても、表示は一貫し、版が重複して上がらない', async () => {
    const seen: Trip[] = []
    function Parent() {
      const [trip, setTrip] = useState(sampleTrip)
      return (
        <TripRouteView
          trip={trip}
          onTripChange={(next) => {
            seen.push(next)
            setTrip(next)
          }}
        />
      )
    }
    const user = userEvent.setup()
    render(<Parent />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    expect(seen).toHaveLength(1)
    expect(seen[0].version).toBe(sampleTrip.version + 1)
    expect(stopButton(/昼食店A.*固定予定/)).toBeTruthy()
  })

  it('親のTripが変わったら、ローカルの固定の変更は破棄し、通知も消す', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))
    expect(screen.getByRole('status').textContent).toContain('固定しました')

    // 同じ内容でも、新しい参照（新しい取得）が渡されたら、親の状態に合わせる。
    rerender(<TripRouteView trip={TripSchema.parse(structuredClone(sampleTrip))} />)

    expect(items()[1].textContent).not.toContain('固定予定')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('同じTripの参照で親が再描画されても、ローカルの変更は消えない', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    rerender(<TripRouteView trip={sampleTrip} mock />)

    expect(items()[1].textContent).toContain('固定予定')
  })

  it('選択中の予定が新しいTripに無ければ、詳細を閉じる。あれば維持する', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))

    rerender(<TripRouteView trip={TripSchema.parse(structuredClone(sampleTrip))} />)
    expect(sheet()).toBeTruthy()

    rerender(<TripRouteView trip={otherTrip} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('未取得の予定種別（指摘2）', () => {
  it('種別が取得できていない予定は、「観光」と決めつけず「予定」と表示する', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))

    expect(sheet().textContent).toContain('2番目・予定・')
    expect(sheet().textContent).not.toContain('観光')
  })

  it('種別が分かっている予定は、その種別を表示する', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} meta={sampleRouteMeta} />)
    await user.click(stopButton(/昼食店A/))

    expect(sheet().textContent).toContain('2番目・食事・')
  })
})

describe('詳細シートを閉じたあとのフォーカス（指摘3）', () => {
  it('Escapeキーで閉じると、選択していた予定のボタンへフォーカスが戻る', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    await user.keyboard('{Escape}')

    await waitFor(() => expect(document.activeElement).toBe(stopButton(/昼食店A/)))
  })

  it('閉じるボタンで閉じても、選択していた予定のボタンへ戻る', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/14時の予約展示/))
    await user.click(within(sheet()).getByRole('button', { name: '閉じる' }))

    await waitFor(() => expect(document.activeElement).toBe(stopButton(/14時の予約展示/)))
  })

  it('別の予定へ切り替えてから閉じた場合は、最後に選択した予定へ戻る', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/朝の庭園/))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(stopButton(/昼食店A/))
    await user.keyboard('{Escape}')

    await waitFor(() => expect(document.activeElement).toBe(stopButton(/昼食店A/)))
    expect(document.activeElement).not.toBe(stopButton(/朝の庭園/))
  })

  it('開いたときは、フォーカスが詳細の見出しへ移る（従来どおり）', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))

    expect(document.activeElement).toBe(within(sheet()).getByRole('heading'))
  })

  it('固定を切り替えても、フォーカスは詳細の中にとどまる（奪われない）', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    expect(sheet().contains(document.activeElement)).toBe(true)
  })
})

describe('未照合の表示のコントラスト（指摘5）', () => {
  it('固定した予定の「未照合」も、固定でない予定と同じ表示（背景を暗くしない）', () => {
    const unverified = TripSchema.parse({
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop) => ({ ...stop, evidence: [] })),
    })
    render(<TripRouteView trip={unverified} />)
    const fixedBadge = within(items()[0]).getByText('未照合')
    const normalBadge = within(items()[1]).getByText('未照合')

    expect(fixedBadge.className).toBe(normalBadge.className)
    expect(fixedBadge.className).toContain('text-gt-muted')
  })

  it('部分修正のボタンは、白い文字に十分なコントラストのある背景色を使う', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} onStartRevision={() => undefined} />)
    await user.click(stopButton(/昼食店A/))

    const button = within(sheet()).getByRole('button', { name: 'この予定だけ変更' })
    expect(button.className).toContain('bg-gt-ink')
    expect(button.className).not.toContain('bg-gt-line ')
  })
})

describe('一覧の読み上げ名と根拠の表示（推奨）', () => {
  it('予定のボタンの名前に、時刻・滞在時間・固定・根拠の代表状態が含まれる', () => {
    render(<TripRouteView trip={sampleTrip} />)

    expect(
      stopButton(
        /10:00から60分 朝の庭園（架空）（固定予定）、施設の存在：情報源と整合。詳細を開く/,
      ),
    ).toBeTruthy()
    expect(stopButton(/12:00から75分 昼食店A（架空）、営業時間：矛盾あり/)).toBeTruthy()
    expect(
      stopButton(/14:00から60分 14時の予約展示（架空）（固定予定）、営業時間：確認できない/),
    ).toBeTruthy()
  })

  it('根拠が空の予定は、読み上げでも「未照合」と分かる', () => {
    const unverified = TripSchema.parse({
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop) => ({ ...stop, evidence: [] })),
    })
    render(<TripRouteView trip={unverified} />)

    expect(stopButton(/朝の庭園.*未照合。詳細を開く/)).toBeTruthy()
  })

  it('根拠の日時は「照合日時」と表示する', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByText('根拠を見る'))

    expect(sheet().textContent).toContain('照合日時')
    expect(sheet().textContent).not.toContain('取得日時')
  })

  it('情報源のURLがあれば、新しいタブで開くリンクを出す。無ければ出さない', async () => {
    const withUrl = TripSchema.parse({
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop, index) =>
        index === 1
          ? {
              ...stop,
              evidence: stop.evidence.map((item) => ({
                ...item,
                source: { ...item.source, url: 'https://example.com/source' },
              })),
            }
          : stop,
      ),
    })
    const user = userEvent.setup()
    const { unmount } = render(<TripRouteView trip={withUrl} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByText('根拠を見る'))

    const link = within(sheet()).getByRole('link', { name: /情報源を開く/ })
    expect(link.getAttribute('href')).toBe('https://example.com/source')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    unmount()

    render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByText('根拠を見る'))
    expect(within(sheet()).queryByRole('link')).toBeNull()
  })
})

describe('予約に関する表示（#23の仕様：根拠のない「予約済み」表示は禁止）', () => {
  it('予約が必要な予定の種別は「要予約」と表示する（予約済みの状態に見せない）', () => {
    render(<TripRouteView trip={sampleTrip} meta={sampleRouteMeta} />)
    const ticket = items()[2]

    expect(ticket.textContent).toContain('要予約')
    // 種別のラベルとして「予約」だけを単独で出さない。
    expect(ticket.textContent).not.toMatch(/(^|[^要])予約(?!展示)/)
  })

  it('詳細でも種別は「要予約」で、予約の状態は反映されないことを明記する', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} meta={sampleRouteMeta} />)
    await user.click(stopButton(/14時の予約展示/))

    expect(sheet().textContent).toContain('3番目・要予約・')
    expect(sheet().textContent).toContain('予約の状態は反映されません')
  })

  it('固定しただけでは、予約済みの表示にならない', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={sampleTrip} meta={sampleRouteMeta} />)
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    expect(items()[1].textContent).toContain('固定予定')
    expect(items()[1].textContent).not.toContain('要予約')
  })
})

describe('固定と予定の種類の分離（#23・Cludewn案：固定は、ロックを重ねて示す）', () => {
  const variantOf = (li: HTMLElement) => within(li).getAllByRole('button')[0].dataset.variant

  const tripWith = (fixed: boolean[]) =>
    TripSchema.parse({
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop, index) => ({ ...stop, isFixed: fixed[index] })),
    })
  const meta = {
    'stop-morning': { kind: 'sight' as const },
    'stop-lunch': { kind: 'meal' as const },
    'stop-exhibition': { kind: 'reserved' as const },
  }

  it('固定した観光地は、黒いチケットではなく、通常の駅のまま、ロックの印と「固定予定」を重ねる', () => {
    render(<TripRouteView trip={tripWith([true, false, false])} meta={meta} />)
    const li = items()[0]

    expect(variantOf(li)).toBe('station')
    expect(li.textContent).toContain('固定予定')
    expect(li.querySelector('[data-fixed-mark]')).not.toBeNull()
    // 予定のカード自体を黒くしない（ロックの印だけが黒い）。
    expect(within(li).getAllByRole('button')[0].className).not.toContain('bg-gt-ink')
  })

  it('固定しても、駅はチケットにならない。固定を外しても、チケットは駅にならない（種類だけで決まる）', async () => {
    const user = userEvent.setup()
    render(<TripRouteView trip={tripWith([false, false, false])} meta={meta} />)
    expect(items().map(variantOf)).toEqual(['station', 'ticket', 'ticket'])

    await user.click(stopButton(/朝の庭園/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(stopButton(/昼食店A/))
    await user.click(within(sheet()).getByRole('button', { name: 'この予定を固定する' }))

    expect(items().map(variantOf)).toEqual(['station', 'ticket', 'ticket'])
    expect(items()[0].querySelector('[data-fixed-mark]')).not.toBeNull()
    expect(items()[1].querySelector('[data-fixed-mark]')).not.toBeNull()
  })

  it('食事のチケットも、固定したときはロックの印と「固定予定」を重ねる（種類と固定の組み合わせ）', () => {
    render(<TripRouteView trip={tripWith([false, true, false])} meta={meta} />)
    const li = items()[1]

    expect(variantOf(li)).toBe('ticket')
    expect(li.textContent).toContain('食事')
    expect(li.textContent).toContain('固定予定')
    expect(li.querySelector('[data-fixed-mark]')).not.toBeNull()
  })

  it('固定でない予定には、ロックの印も「固定予定」も付かない', () => {
    render(<TripRouteView trip={tripWith([false, false, false])} meta={meta} />)

    for (const li of items()) {
      expect(li.querySelector('[data-fixed-mark]')).toBeNull()
      expect(li.textContent).not.toContain('固定予定')
    }
  })

  it('駅の印の番号は、固定しても残る（旅の順番が分かる）', () => {
    render(<TripRouteView trip={tripWith([true, false, true])} meta={meta} />)

    expect(items()[0].textContent).toContain('1')
    expect(items()[2].textContent).toContain('3')
  })

  it('固定した予定を、種類が未指定でも「固定予定」と分かる（観光とは決めつけない）', () => {
    render(<TripRouteView trip={tripWith([true, false, false])} />)

    expect(variantOf(items()[0])).toBe('station')
    expect(items()[0].textContent).toContain('固定予定')
  })
})

describe('親のTripの更新で、選択中の予定が無くなったときのフォーカス（#20の再指摘）', () => {
  const routeList = () => screen.getByRole('list', { name: '旅程の路線図' })

  it('詳細を開いたまま、選択中の予定が無い新しいTripに更新されたら、フォーカスは一覧へ移る（bodyに落ちない）', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    expect(document.activeElement).toBe(within(sheet()).getByRole('heading'))

    rerender(<TripRouteView trip={otherTrip} />)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(routeList())
    expect(document.activeElement).not.toBe(document.body)
  })

  it('詳細の中のボタン（固定の切り替え）にフォーカスがある状態で更新されても、一覧へ移る', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    within(sheet()).getByRole('button', { name: 'この予定を固定する' }).focus()

    rerender(<TripRouteView trip={otherTrip} />)

    expect(document.activeElement).toBe(routeList())
  })

  it('一覧は、キー操作の順序（Tab）には入れず、フォーカスの退避先としてだけ使う', () => {
    render(<TripRouteView trip={sampleTrip} />)

    expect(routeList().getAttribute('tabindex')).toBe('-1')
  })

  it('利用者が、すでに別の場所（画面内の入力欄）へフォーカスを移していれば、奪わない', async () => {
    const user = userEvent.setup()
    function Page({ trip }: { trip: Trip }) {
      return (
        <>
          <input aria-label="別の入力欄" />
          <TripRouteView trip={trip} />
        </>
      )
    }
    const { rerender } = render(<Page trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    const input = screen.getByLabelText('別の入力欄')
    input.focus()

    rerender(<Page trip={otherTrip} />)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('選択中の予定が新しいTripにも残っていれば、詳細もフォーカスも、そのまま', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    const heading = within(sheet()).getByRole('heading')

    rerender(<TripRouteView trip={TripSchema.parse(structuredClone(sampleTrip))} />)

    expect(sheet()).toBeTruthy()
    expect(document.activeElement).toBe(heading)
  })

  it('詳細を開いていないときに、Tripが更新されても、フォーカスを動かさない', () => {
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    expect(document.activeElement).toBe(document.body)

    rerender(<TripRouteView trip={otherTrip} />)

    expect(document.activeElement).toBe(document.body)
  })

  it('一覧へ退避したあとも、通常どおり、予定を選び直して詳細を開ける', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripRouteView trip={sampleTrip} />)
    await user.click(stopButton(/昼食店A/))
    rerender(<TripRouteView trip={otherTrip} />)

    await user.click(stopButton(/別の地点2/))

    expect(within(sheet()).getByRole('heading').textContent).toBe('別の地点2')
  })
})
