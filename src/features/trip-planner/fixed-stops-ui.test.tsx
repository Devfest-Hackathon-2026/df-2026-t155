// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import type { GenerationResult } from './api-client'
import { TripPlanner } from './trip-planner'
import type { GenerateTrip } from './use-trip-generation'

afterEach(() => {
  cleanup()
})

const success: GenerationResult = { ok: true, trip: sampleTrip }
const field = (label: RegExp | string) => screen.getByLabelText(label)
const submitButton = () => screen.getByRole('button', { name: /旅程を作成する|生成中/ })
const addButton = () => screen.getByRole('button', { name: '固定予定を追加' })

const fillBase = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(field(/旅行先/), '京都市東山エリア')
  fireEvent.change(field(/日付/), { target: { value: '2026-11-14' } })
}

// 追加した固定予定1件目を入力する。
const fillFixed = async (
  user: ReturnType<typeof userEvent.setup>,
  { name = '展示（サンプル）', time = '14:00', duration = '90' } = {},
) => {
  await user.type(field('予定の名前'), name)
  fireEvent.change(field('開始時刻'), { target: { value: time } })
  await user.type(field('滞在時間（分）'), duration)
}

describe('TripPlanner: 固定予定の入力', () => {
  it('初期表示：固定予定は0件で、固定は予約・購入を意味しないことと、申告として扱うことを示す', () => {
    render(<TripPlanner generate={vi.fn()} />)

    expect(screen.getByText('0 / 4件')).toBeTruthy()
    expect(screen.getByText(/固定は、予約・購入を意味しません/)).toBeTruthy()
    expect(screen.getByText(/あなたの申告として扱い/)).toBeTruthy()
    expect(screen.queryByText('固定予定 1')).toBeNull()
  })

  it('「固定予定を追加」で入力欄が増え、名前の入力欄へフォーカスが移る', async () => {
    const user = userEvent.setup()
    render(<TripPlanner generate={vi.fn()} />)

    await user.click(addButton())

    expect(screen.getByText('固定予定 1')).toBeTruthy()
    expect(screen.getByText('1 / 4件')).toBeTruthy()
    expect(document.activeElement).toBe(field('予定の名前'))
    expect(screen.getByRole('status', { name: '固定予定の案内' }).textContent).toContain(
      '追加しました',
    )
  })

  it('入力した固定予定を、fixedStops（isFixed: true）として生成に渡す', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue(success)
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)
    await fillBase(user)
    await user.click(addButton())
    await fillFixed(user)

    await user.click(submitButton())

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0].fixedStops).toEqual([
      {
        id: 'fixed-1',
        name: '展示（サンプル）',
        placeId: null,
        plannedStartTime: '14:00',
        durationMinutes: 90,
        isFixed: true,
        evidence: [],
      },
    ])
  })

  it('固定予定に不備があるときは、不備の欄を示して移動し、生成を呼ばない', async () => {
    const generate = vi.fn<GenerateTrip>()
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)
    await fillBase(user)
    await user.click(addButton())
    await user.type(field('予定の名前'), '展示')

    await user.click(submitButton())

    expect(screen.getByText('入力エラー：開始時刻を入力してください')).toBeTruthy()
    expect(field('開始時刻').getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(field('開始時刻'))
    expect(generate).not.toHaveBeenCalled()
  })

  it('旅行先と固定予定の両方に不備があるときは、画面上で先にある旅行先へ移動する', async () => {
    const user = userEvent.setup()
    render(<TripPlanner generate={vi.fn<GenerateTrip>()} />)
    await user.click(addButton())

    await user.click(submitButton())

    expect(document.activeElement).toBe(field(/旅行先/))
    expect(screen.getByText('入力エラー：予定の名前を入力してください')).toBeTruthy()
  })

  it('入力し直すと、その項目の案内だけが消える', async () => {
    const user = userEvent.setup()
    render(<TripPlanner generate={vi.fn<GenerateTrip>()} />)
    await user.click(addButton())
    await user.click(submitButton())
    expect(screen.getByText('入力エラー：予定の名前を入力してください')).toBeTruthy()
    expect(screen.getByText('入力エラー：開始時刻を入力してください')).toBeTruthy()

    await user.type(field('予定の名前'), '展示')

    expect(screen.queryByText('入力エラー：予定の名前を入力してください')).toBeNull()
    expect(screen.getByText('入力エラー：開始時刻を入力してください')).toBeTruthy()
  })

  it('時刻が重なる固定予定は、重なった側の開始時刻に案内する', async () => {
    const generate = vi.fn<GenerateTrip>()
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)
    await fillBase(user)
    await user.click(addButton())
    await fillFixed(user, { name: '展示', time: '14:00', duration: '90' })
    await user.click(addButton())
    const names = screen.getAllByLabelText('予定の名前')
    await user.type(names[1], '重なる予定')
    fireEvent.change(screen.getAllByLabelText('開始時刻')[1], { target: { value: '15:00' } })
    await user.type(screen.getAllByLabelText('滞在時間（分）')[1], '30')

    await user.click(submitButton())

    expect(screen.getByText('入力エラー：他の固定予定と、時間が重なっています')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getAllByLabelText('開始時刻')[1])
    expect(generate).not.toHaveBeenCalled()
  })

  it('4件を超えて追加しようとすると、案内して、増やさない', async () => {
    const user = userEvent.setup()
    render(<TripPlanner generate={vi.fn<GenerateTrip>()} />)
    for (let count = 0; count < 4; count += 1) await user.click(addButton())

    await user.click(addButton())

    expect(screen.getAllByLabelText('予定の名前')).toHaveLength(4)
    expect(screen.getByText('4 / 4件（これ以上は追加できません）')).toBeTruthy()
    expect(screen.getByRole('status', { name: '固定予定の案内' }).textContent).toContain('最大4件')
  })

  it('削除すると、その行が消え、追加ボタンへフォーカスが移る', async () => {
    const user = userEvent.setup()
    render(<TripPlanner generate={vi.fn<GenerateTrip>()} />)
    await user.click(addButton())
    await user.click(addButton())

    await user.click(screen.getByRole('button', { name: '固定予定 1 を削除' }))

    expect(screen.getAllByLabelText('予定の名前')).toHaveLength(1)
    expect(document.activeElement).toBe(addButton())
    expect(screen.getByRole('status', { name: '固定予定の案内' }).textContent).toContain(
      '削除しました',
    )
  })

  it('削除した行の入力は、送らない（残った行だけが、fixed-1から並ぶ）', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue(success)
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)
    await fillBase(user)
    await user.click(addButton())
    await user.click(addButton())
    await user.type(screen.getAllByLabelText('予定の名前')[0], '消す予定')
    await user.type(screen.getAllByLabelText('予定の名前')[1], '残す予定')
    fireEvent.change(screen.getAllByLabelText('開始時刻')[1], { target: { value: '14:00' } })
    await user.type(screen.getAllByLabelText('滞在時間（分）')[1], '60')
    await user.click(screen.getByRole('button', { name: '固定予定 1 を削除' }))

    await user.click(submitButton())

    expect(generate.mock.calls[0][0].fixedStops.map((stop) => [stop.id, stop.name])).toEqual([
      ['fixed-1', '残す予定'],
    ])
  })

  it('生成に失敗しても、固定予定の入力は保持される', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue({
      ok: false,
      failure: { kind: 'external_service_error', message: '生成できませんでした' },
    })
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)
    await fillBase(user)
    await user.click(addButton())
    await fillFixed(user)

    await user.click(submitButton())
    await screen.findByRole('alert')

    expect((field('予定の名前') as HTMLInputElement).value).toBe('展示（サンプル）')
    expect((field('滞在時間（分）') as HTMLInputElement).value).toBe('90')
  })
})
