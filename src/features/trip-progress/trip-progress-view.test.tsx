// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Evidence, Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'

import { TripProgressView } from './trip-progress-view'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// sampleTripの予定：朝の庭園（固定・10:00）、昼食店A（固定でない・12:00）、14時の予約展示（固定・14:00）。
const travelEvidence = (
  status: Evidence['status'],
  sourceKind: Evidence['source']['kind'] = 'routes',
): Evidence => ({
  id: `travel-${status}`,
  subject: 'travel_time',
  claim: '前の予定から徒歩で移動できる',
  applicability: '2026-11-08 Asia/Tokyo',
  source: { kind: sourceKind, label: '経路の出典' },
  checkedAt: '2026-11-08T09:00:00+09:00',
  status,
  explanation: '説明',
})

// 昼食店A（2番目）に、移動時間の根拠を付けた旅程。
const tripWithLunchTravel = (items: Evidence[]): Trip => tripWithEvidence('stop-lunch', items)

// 指定した予定の根拠を、差し替えた旅程。keepは、元の根拠（sampleTripでは模擬データ）を残すか。
const tripWithEvidence = (stopId: string, items: Evidence[], keep = true): Trip => ({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) =>
    stop.id === stopId ? { ...stop, evidence: keep ? [...stop.evidence, ...items] : items } : stop,
  ),
})

const evidenceOf = (
  id: string,
  subject: Evidence['subject'],
  status: Evidence['status'],
  sourceKind: Evidence['source']['kind'],
): Evidence => ({
  id,
  subject,
  claim: '確認した内容',
  applicability: '2026-11-08 Asia/Tokyo',
  source: { kind: sourceKind, label: '出典' },
  checkedAt: '2026-11-08T09:00:00+09:00',
  status,
  explanation: '説明',
})

// 実測・照合を思わせる文言。模擬データの表示には、決して出さない。
const realLookingWords = /情報源と整合|間に合う見込み|確認できた|営業時間内/

const SIM_NOTE = '実際の施設・営業時間・移動を確認した結果ではありません'
const evidenceList = () => within(currentCard()).getByRole('list', { name: '根拠の状態' })
const demoMark = (item: HTMLElement) => item.querySelector('.border-dashed')
const checkMark = (item: HTMLElement) => item.querySelector('svg path[d^="M5 12.5"]')

const user = () => userEvent.setup()
const forwardButton = () => screen.getByRole('button', { name: '次の予定へ進む' })
const backButton = () => screen.getByRole('button', { name: 'ひとつ前に戻す' })
const status = () => screen.getByRole('status')
const currentCard = () => screen.getByRole('region', { name: 'いまの予定' })
const nextCard = () => screen.getByRole('region', { name: '次の予定' })
const routeItems = () =>
  within(screen.getByRole('list', { name: '旅程の進行' })).getAllByRole('listitem')

describe('初期表示', () => {
  it('いまの予定は最初の予定。次の予定の開始時刻と名前を示す', () => {
    render(<TripProgressView trip={sampleTrip} />)
    expect(within(currentCard()).getByText('朝の庭園（架空）')).toBeTruthy()
    expect(within(currentCard()).getByText(/10:00〜11:00・滞在60分/)).toBeTruthy()
    expect(within(nextCard()).getByText('昼食店A（架空）')).toBeTruthy()
    expect(within(nextCard()).getByText('12:00から')).toBeTruthy()
  })

  it('位置情報を使っていないこと、保存しないことを明記する。現在時刻は表示しない', () => {
    const { container } = render(<TripProgressView trip={sampleTrip} />)
    expect(
      screen.getByText(/位置情報は使っていません。進行状況は、ボタンで更新します。/),
    ).toBeTruthy()
    expect(screen.getByText(/保存されません/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/現在時刻|現在地|GPS/)
  })

  it('常設のライブリージョンがあり、最初は空', () => {
    render(<TripProgressView trip={sampleTrip} />)
    expect(status().textContent?.trim()).toBe('')
  })

  it('予定が空の旅程では、「表示できる予定がありません」と案内する', () => {
    render(<TripProgressView trip={{ ...sampleTrip, stops: [] }} />)
    expect(screen.getByText('表示できる予定がありません。')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('initialIndexで、途中の予定から始められる。範囲外は範囲内に収める', () => {
    const { unmount } = render(<TripProgressView trip={sampleTrip} initialIndex={2} />)
    expect(within(currentCard()).getByText('14時の予約展示（架空）')).toBeTruthy()
    expect(within(nextCard()).getByText('最後の予定です')).toBeTruthy()
    unmount()

    render(<TripProgressView trip={sampleTrip} initialIndex={99} />)
    expect(within(currentCard()).getByText('14時の予約展示（架空）')).toBeTruthy()
    cleanup()

    render(<TripProgressView trip={sampleTrip} initialIndex={-1} />)
    expect(within(currentCard()).getByText('朝の庭園（架空）')).toBeTruthy()
  })
})

describe('進む・戻る', () => {
  it('進むと、いまの予定と次の予定が1つ先へ移り、結果をライブリージョンで伝える', async () => {
    render(<TripProgressView trip={sampleTrip} />)
    await user().click(forwardButton())
    expect(within(currentCard()).getByText('昼食店A（架空）')).toBeTruthy()
    expect(within(nextCard()).getByText('14時の予約展示（架空）')).toBeTruthy()
    expect(status().textContent).toContain('いまの予定：昼食店A（架空）（12:00）に進みました')
  })

  it('進んだあとも、フォーカスは押したボタンに残る（カード見出しへ移さない）', async () => {
    render(<TripProgressView trip={sampleTrip} />)
    await user().click(forwardButton())
    expect(document.activeElement).toBe(forwardButton())
    await user().click(backButton())
    expect(document.activeElement).toBe(backButton())
  })

  it('戻すと1つ前へ戻り、結果を伝える', async () => {
    render(<TripProgressView trip={sampleTrip} initialIndex={2} />)
    await user().click(backButton())
    expect(within(currentCard()).getByText('昼食店A（架空）')).toBeTruthy()
    expect(status().textContent).toContain('いまの予定：昼食店A（架空）（12:00）に戻しました')
  })

  it('最後の予定では、進行ボタンが振り返りに変わり、本人が押したときだけ開く', async () => {
    const onFinish = vi.fn()
    render(<TripProgressView trip={sampleTrip} initialIndex={1} finishAction={{ onFinish }} />)
    const button = forwardButton()
    await user().click(button)
    expect(screen.queryByRole('button', { name: '次の予定へ進む' })).toBeNull()
    const finish = screen.getByRole('button', { name: '旅行を終えて振り返る' })
    expect(finish).toBe(button)
    expect(document.activeElement).toBe(finish)
    expect(onFinish).not.toHaveBeenCalled()
    expect(within(currentCard()).getByText('14時の予約展示（架空）')).toBeTruthy()
    expect(within(nextCard()).getByText('最後の予定です')).toBeTruthy()
    await user().click(finish)
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  it('最初の予定では、戻すボタンは押せるが戻らず、理由を案内する', async () => {
    render(<TripProgressView trip={sampleTrip} />)
    const button = backButton()
    expect((button as HTMLButtonElement).disabled).toBe(false)
    await user().click(button)
    expect(within(currentCard()).getByText('朝の庭園（架空）')).toBeTruthy()
    expect(status().textContent).toContain('最初の予定です')
  })

  it('境界を何度押しても越えない。同じ案内が続いても、読み上げ直されるよう通知の中身の要素が作り直される', async () => {
    render(<TripProgressView trip={sampleTrip} />)
    const region = status()
    await user().click(backButton())
    const first = region.firstElementChild
    expect(first?.textContent).toContain('最初の予定です')
    await user().click(backButton())
    const second = region.firstElementChild
    expect(second?.textContent).toBe(first?.textContent)
    expect(second).not.toBe(first)
    // 常設のライブリージョン自体は作り直さない。
    expect(status()).toBe(region)
    expect(within(currentCard()).getByText('朝の庭園（架空）')).toBeTruthy()
    await user().click(forwardButton())
    await user().click(forwardButton())
    expect(within(currentCard()).getByText('14時の予約展示（架空）')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '次の予定へ進む' })).toBeNull()
    expect(screen.queryByRole('button', { name: '旅行を終えて振り返る' })).toBeNull()
  })

  it('進行ボタンに44px以上の最小高さを指定する', () => {
    render(<TripProgressView trip={sampleTrip} onReplan={() => undefined} />)
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toMatch(/min-h-\[(46|52)px\]/)
    }
  })
})

describe('縦の路線：状態を色だけに頼らず示す', () => {
  const labels = ['訪問済み', 'いまここ', 'これから'] as const
  const labelsOf = (item: HTMLElement) => labels.filter((label) => within(item).queryByText(label))

  it('訪問済み・いまここ・これからの文字が、各予定に1つずつ付く', async () => {
    render(<TripProgressView trip={sampleTrip} />)
    expect(routeItems().map(labelsOf)).toEqual([['いまここ'], ['これから'], ['これから']])
    await user().click(forwardButton())
    expect(routeItems().map(labelsOf)).toEqual([['訪問済み'], ['いまここ'], ['これから']])
    await user().click(forwardButton())
    expect(routeItems().map(labelsOf)).toEqual([['訪問済み'], ['訪問済み'], ['いまここ']])
  })

  it('いまの予定だけが aria-current="step" になる', async () => {
    render(<TripProgressView trip={sampleTrip} />)
    await user().click(forwardButton())
    expect(routeItems().map((item) => item.getAttribute('aria-current'))).toEqual([
      null,
      'step',
      null,
    ])
  })

  it('固定予定は進行状態が変わっても駅番号と鍵を別々に表示する', async () => {
    render(<TripProgressView trip={sampleTrip} initialIndex={1} />)
    const [visited, current, upcoming] = routeItems()
    const stationNumber = (row: HTMLElement) => row.querySelector('[data-station-number]')
    const fixedMark = (row: HTMLElement) => row.querySelector('[data-fixed-mark]')

    expect(stationNumber(visited)?.textContent).toBe('1')
    expect(stationNumber(current)?.textContent).toBe('2')
    expect(stationNumber(upcoming)?.textContent).toBe('3')
    expect(stationNumber(upcoming)?.nextElementSibling).toBe(fixedMark(upcoming))
    expect(fixedMark(visited)?.querySelector('svg')).not.toBeNull()
    expect(fixedMark(current)).toBeNull()

    await userEvent.setup().click(screen.getByRole('button', { name: '次の予定へ進む' }))
    expect(stationNumber(upcoming)?.textContent).toBe('3')
    expect(stationNumber(upcoming)?.nextElementSibling).toBe(fixedMark(upcoming))
    expect(checkMark(current)).not.toBeNull()
  })
})

describe('固定予定の表示', () => {
  it('固定の予定には「固定予定」の文字を付け、固定でない予定には付けない', () => {
    render(<TripProgressView trip={sampleTrip} />)
    // 朝の庭園（固定）・昼食店A（固定でない）・予約展示（固定）
    expect(routeItems().map((item) => !!within(item).queryByText('固定予定'))).toEqual([
      true,
      false,
      true,
    ])
  })

  it('いまの予定・次の予定でも、固定なら「固定予定」と表示する', async () => {
    render(<TripProgressView trip={sampleTrip} />)
    expect(within(currentCard()).getByText('固定予定')).toBeTruthy()
    expect(within(nextCard()).queryByText('固定予定')).toBeNull()
    await user().click(forwardButton())
    expect(within(currentCard()).queryByText('固定予定')).toBeNull()
    expect(within(nextCard()).getByText('固定予定')).toBeTruthy()
  })

  it('固定は予約・購入を意味する表示にしない', () => {
    const { container } = render(<TripProgressView trip={sampleTrip} />)
    expect(container.textContent).not.toMatch(/予約済み|購入済み|発券/)
  })
})

describe('根拠の状態', () => {
  it('いまの予定の根拠を、項目ごとの文字で示す。根拠が無ければ「未照合」', async () => {
    render(<TripProgressView trip={sampleTrip} />)
    // sampleTripの根拠は、すべて模擬データ。実測の「情報源と整合」「矛盾あり」とは書かない。
    expect(within(currentCard()).getByText('施設の存在：デモ用の想定')).toBeTruthy()
    await user().click(forwardButton())
    expect(within(currentCard()).getByText('営業時間：デモ用の想定（食い違いあり）')).toBeTruthy()
    await user().click(forwardButton())
    expect(within(currentCard()).getByText('営業時間：デモ用の想定（確認できない）')).toBeTruthy()

    const noEvidence: Trip = {
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop) => ({ ...stop, evidence: [] })),
    }
    cleanup()
    render(<TripProgressView trip={noEvidence} />)
    expect(within(currentCard()).getByText(/根拠：未照合/)).toBeTruthy()
    expect(currentCard().textContent).not.toContain('デモ用の想定')
  })

  it('実際の根拠（places・routes）は、従来どおりの見出しと印で示し、デモ用の表示を付けない', () => {
    const trip = tripWithEvidence(
      'stop-morning',
      [
        evidenceOf('real-hours', 'opening_hours', 'consistent', 'places'),
        evidenceOf('real-travel', 'travel_time', 'conflicting', 'routes'),
      ],
      false,
    )
    render(<TripProgressView trip={trip} />)
    const hours = within(evidenceList()).getByText('営業時間：情報源と整合')
    expect(checkMark(hours.closest('li') as HTMLElement)).not.toBeNull()
    expect(within(evidenceList()).getByText('移動時間：矛盾あり')).toBeTruthy()
    expect(demoMark(evidenceList())).toBeNull()
    expect(currentCard().textContent).not.toContain('デモ用の想定')
    expect(currentCard().textContent).not.toContain(SIM_NOTE)
  })

  it('模擬データには、実測を思わせる文言を使わず、補足と、チェックではない「デモ」の印を付ける', () => {
    render(<TripProgressView trip={sampleTrip} />)
    expect(currentCard().textContent).not.toMatch(realLookingWords)
    expect(currentCard().textContent).toContain(SIM_NOTE)
    // 緑のチェックではなく、破線の枠＋「デモ」の文字で区別する（色だけに頼らない）。
    const item = within(evidenceList()).getByText('施設の存在：デモ用の想定').closest('li')
    expect(checkMark(item as HTMLElement)).toBeNull()
    expect(demoMark(item as HTMLElement)?.textContent).toBe('デモ')
  })

  it('実際の根拠と模擬が混在するとき、実際の分は従来どおり、模擬の分だけがデモ用になる', () => {
    // 朝の庭園には、元の模擬の根拠（施設の存在・整合）がある。そこへ実際の根拠と、別の模擬を足す。
    const trip = tripWithEvidence('stop-morning', [
      evidenceOf('real-place', 'place_identity', 'consistent', 'places'),
      evidenceOf('real-hours', 'opening_hours', 'consistent', 'places'),
      evidenceOf('sim-hours', 'opening_hours', 'consistent', 'simulation'),
    ])
    render(<TripProgressView trip={trip} />)
    const items = within(evidenceList()).getAllByRole('listitem')
    const summary = items.map((item) => ({
      text: item.querySelector('.min-w-0')?.textContent,
      demo: demoMark(item) !== null,
      check: checkMark(item) !== null,
    }))
    expect(summary).toEqual([
      { text: '施設の存在：情報源と整合', demo: false, check: true },
      { text: '施設の存在：デモ用の想定', demo: true, check: false },
      { text: '営業時間：情報源と整合', demo: false, check: true },
      { text: '営業時間：デモ用の想定', demo: true, check: false },
    ])
  })

  it('模擬の「整合」が、実際の矛盾を隠したり、実際の整合に数えられたりしない', () => {
    const trip = tripWithEvidence(
      'stop-morning',
      [
        evidenceOf('real-hours', 'opening_hours', 'conflicting', 'places'),
        evidenceOf('sim-hours', 'opening_hours', 'consistent', 'simulation'),
      ],
      false,
    )
    render(<TripProgressView trip={trip} />)
    expect(within(evidenceList()).getByText('営業時間：矛盾あり')).toBeTruthy()
    expect(within(evidenceList()).getByText('営業時間：デモ用の想定')).toBeTruthy()
    expect(within(evidenceList()).queryByText('営業時間：情報源と整合')).toBeNull()
  })
})

describe('次の予定までの移動の根拠', () => {
  const textOfNext = () => nextCard().textContent ?? ''

  it('根拠が無ければ「移動時間は未確認」', () => {
    render(<TripProgressView trip={sampleTrip} />)
    expect(within(nextCard()).getByText('移動時間は未確認')).toBeTruthy()
    expect(textOfNext()).not.toContain('間に合う')
    expect(textOfNext()).not.toContain('デモ用の想定')
  })

  it.each([
    ['consistent', '移動の根拠：情報源と整合'],
    ['conflicting', '移動の根拠：矛盾あり'],
    ['unverifiable', '移動時間を確認できない'],
  ] as const)('実際の根拠が %s のとき「%s」。デモ用の表示は付かない', (evidenceStatus, text) => {
    render(<TripProgressView trip={tripWithLunchTravel([travelEvidence(evidenceStatus)])} />)
    expect(within(nextCard()).getByText(text)).toBeTruthy()
    expect(textOfNext()).not.toContain('デモ用の想定')
    expect(textOfNext()).not.toContain(SIM_NOTE)
  })

  it.each([
    ['consistent', 'デモ用の想定'],
    ['conflicting', 'デモ用の想定（食い違いあり）'],
    ['unverifiable', 'デモ用の想定（確認できない）'],
  ] as const)(
    '模擬が %s のときは、実測ではなく「%s」。「移動時間は未確認」も併せて示す',
    (evidenceStatus, text) => {
      render(
        <TripProgressView
          trip={tripWithLunchTravel([travelEvidence(evidenceStatus, 'simulation')])}
        />,
      )
      expect(within(nextCard()).getByText(text)).toBeTruthy()
      expect(within(nextCard()).getByText('移動時間は未確認')).toBeTruthy()
      expect(textOfNext()).not.toMatch(realLookingWords)
      // 補足は1回だけ。見出しがデモ用なので、別の「情報源：模擬データ」は併記しない。
      expect(textOfNext().split(SIM_NOTE)).toHaveLength(2)
      expect(textOfNext()).not.toContain('情報源：模擬データ')
    },
  )

  it('実際の根拠と模擬が混在するとき、実際の分は従来どおり、模擬は別にデモ用で示す', () => {
    render(
      <TripProgressView
        trip={tripWithLunchTravel([
          travelEvidence('conflicting', 'routes'),
          { ...travelEvidence('consistent', 'simulation'), id: 'travel-demo' },
        ])}
      />,
    )
    expect(within(nextCard()).getByText('移動の根拠：矛盾あり')).toBeTruthy()
    expect(within(nextCard()).getByText('デモ用の想定')).toBeTruthy()
    expect(within(nextCard()).queryByText('移動時間は未確認')).toBeNull()
    expect(textOfNext()).not.toContain('間に合う見込み')
  })

  it('実際の整合と模擬の矛盾が混在するとき、模擬は数えず、実際の整合はそのまま示す', () => {
    render(
      <TripProgressView
        trip={tripWithLunchTravel([
          travelEvidence('consistent', 'routes'),
          { ...travelEvidence('conflicting', 'simulation'), id: 'travel-demo' },
        ])}
      />,
    )
    expect(within(nextCard()).getByText('移動の根拠：情報源と整合')).toBeTruthy()
    expect(within(nextCard()).getByText('デモ用の想定（食い違いあり）')).toBeTruthy()
  })

  it('予定上の間隔を、現在時刻に頼らず予定の時刻から示す', () => {
    render(<TripProgressView trip={sampleTrip} />)
    expect(textOfNext()).toContain('予定上の間隔：11:00の終了から60分')
  })

  it('予定が重なっていれば、その旨を示す', () => {
    const overlapping: Trip = {
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop) =>
        stop.id === 'stop-morning' ? { ...stop, durationMinutes: 150 } : stop,
      ),
    }
    render(<TripProgressView trip={overlapping} />)
    expect(textOfNext()).toContain('予定が重なっています')
  })

  it('予定が重なり、実際の移動根拠が整合のとき、「間に合う」と断定せず、重なりを示す', () => {
    const withTravel = tripWithLunchTravel([travelEvidence('consistent')])
    const overlapping: Trip = {
      ...withTravel,
      stops: withTravel.stops.map((stop) =>
        stop.id === 'stop-morning' ? { ...stop, durationMinutes: 150 } : stop,
      ),
    }
    render(<TripProgressView trip={overlapping} />)
    expect(textOfNext()).toContain('予定が重なっています')
    expect(textOfNext()).toContain('移動の根拠：情報源と整合')
    expect(textOfNext()).not.toContain('間に合う')
  })
})

describe('模擬データ（sampleTrip）を、照合済みに見せない', () => {
  it('いまの予定・次の予定・路線のどこにも、実測・照合を思わせる文言が出ない', async () => {
    const { container } = render(<TripProgressView trip={sampleTrip} />)
    for (let step = 0; step < 3; step += 1) {
      expect(container.textContent).not.toMatch(realLookingWords)
      expect(currentCard().textContent).toContain('デモ用の想定')
      if (step < 2) await user().click(forwardButton())
    }
  })
})

describe('再計画の入口', () => {
  it('onReplanが無ければ、変更ボタンを表示しない', () => {
    render(<TripProgressView trip={sampleTrip} initialIndex={1} />)
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
  })

  it('onReplanがあれば表示し、いまの予定のIDで呼ぶ', async () => {
    const onReplan = vi.fn()
    render(<TripProgressView trip={sampleTrip} initialIndex={1} onReplan={onReplan} />)
    await user().click(screen.getByRole('button', { name: '予定が変わった？この予定だけ変更する' }))
    expect(onReplan).toHaveBeenCalledTimes(1)
    expect(onReplan).toHaveBeenCalledWith('stop-lunch')
  })

  it('固定予定は変更の対象にしない。ボタンの代わりに理由を示す', () => {
    const onReplan = vi.fn()
    render(<TripProgressView trip={sampleTrip} initialIndex={0} onReplan={onReplan} />)
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
    expect(within(currentCard()).getByText(/固定を解除するまで/)).toBeTruthy()
    expect(onReplan).not.toHaveBeenCalled()
  })

  it('進行を変えても、onReplanは進行の操作では呼ばれない', async () => {
    const onReplan = vi.fn()
    render(<TripProgressView trip={sampleTrip} onReplan={onReplan} />)
    await user().click(forwardButton())
    await user().click(backButton())
    expect(onReplan).not.toHaveBeenCalled()
  })
})

describe('旅程が変わったとき', () => {
  it('trip.idが変わると、進行状態と案内をリセットする', async () => {
    const { rerender } = render(<TripProgressView trip={sampleTrip} />)
    await user().click(forwardButton())
    await user().click(forwardButton())
    expect(within(currentCard()).getByText('14時の予約展示（架空）')).toBeTruthy()

    rerender(<TripProgressView trip={{ ...sampleTrip, id: 'trip-other' }} />)
    expect(within(currentCard()).getByText('朝の庭園（架空）')).toBeTruthy()
    expect(status().textContent?.trim()).toBe('')
  })

  it('同じ旅程の更新（版の更新）では、進行状態を保つ', async () => {
    const { rerender } = render(<TripProgressView trip={sampleTrip} />)
    await user().click(forwardButton())
    rerender(<TripProgressView trip={{ ...sampleTrip, version: sampleTrip.version + 1 }} />)
    expect(within(currentCard()).getByText('昼食店A（架空）')).toBeTruthy()
  })
})

describe('位置情報・現在時刻を使わない', () => {
  it('位置情報のAPIを呼ばない', async () => {
    const geolocation = {
      getCurrentPosition: vi.fn(),
      watchPosition: vi.fn(),
      clearWatch: vi.fn(),
    }
    Object.defineProperty(navigator, 'geolocation', { value: geolocation, configurable: true })
    try {
      render(<TripProgressView trip={sampleTrip} onReplan={() => undefined} />)
      await user().click(forwardButton())
      await user().click(backButton())
      expect(geolocation.getCurrentPosition).not.toHaveBeenCalled()
      expect(geolocation.watchPosition).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(navigator, 'geolocation')
    }
  })

  it('実装のソースが、Date・geolocation・タイマーを使っていない', () => {
    for (const file of ['trip-progress-view.tsx', 'progress-model.ts', 'progress-parts.tsx']) {
      const source = readFileSync(join(process.cwd(), 'src/features/trip-progress', file), 'utf-8')
      expect(source, file).not.toMatch(
        /\bDate\b|geolocation|setInterval|setTimeout|performance\.now/,
      )
    }
  })

  it('時間が経っても、操作しなければ進行状態は変わらない', () => {
    vi.useFakeTimers()
    try {
      render(<TripProgressView trip={sampleTrip} />)
      vi.setSystemTime(new Date('2026-11-08T13:30:00+09:00'))
      vi.advanceTimersByTime(3 * 60 * 60 * 1000)
      expect(within(currentCard()).getByText('朝の庭園（架空）')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
