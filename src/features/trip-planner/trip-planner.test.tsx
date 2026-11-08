// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const field = (label: RegExp) => screen.getByLabelText(label)
const submitButton = () => screen.getByRole('button', { name: /旅程を作成する|生成中/ })

// 旅行先・日付・希望条件を入力する（日付はブラウザの日付入力の値として設定する）。
const fillValid = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(field(/旅行先/), '京都市東山エリア')
  fireEvent.change(field(/日付/), { target: { value: '2026-11-14' } })
  await user.type(field(/希望条件/), 'ゆっくり歩きたい{Enter}抹茶を食べたい')
}

describe('TripPlanner: 初期表示', () => {
  it('旅行先・日付・希望条件の入力欄と作成ボタンがあり、未実装の操作は表示しない', () => {
    render(<TripPlanner generate={vi.fn()} />)

    expect(field(/旅行先/)).toBeTruthy()
    expect(field(/日付/)).toBeTruthy()
    expect(field(/希望条件/)).toBeTruthy()
    expect(submitButton().textContent).toBe('旅程を作成する')
    // 承認・保存などはこのIssueの対象外のため、操作として見せない。
    expect(screen.queryByRole('button', { name: /承認|保存|確定/ })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('TripPlanner: 入力不備', () => {
  it('空のまま作成を押すと、不備を案内して最初の項目へ移動し、生成は呼ばない', async () => {
    const generate = vi.fn<GenerateTrip>()
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)

    await user.click(submitButton())

    expect(screen.getByText('入力エラー：旅行先を入力してください')).toBeTruthy()
    expect(screen.getByText('入力エラー：日付を選んでください')).toBeTruthy()
    expect(field(/旅行先/).getAttribute('aria-invalid')).toBe('true')
    expect(field(/希望条件/).getAttribute('aria-invalid')).toBe('false')
    expect(document.activeElement).toBe(field(/旅行先/))
    expect(generate).not.toHaveBeenCalled()
  })

  it('旅行先だけ入力済みなら、日付へ移動する', async () => {
    const user = userEvent.setup()
    render(<TripPlanner generate={vi.fn<GenerateTrip>()} />)

    await user.type(field(/旅行先/), '京都')
    await user.click(submitButton())

    expect(screen.queryByText(/旅行先を入力してください/)).toBeNull()
    expect(document.activeElement).toBe(field(/日付/))
  })

  it('該当項目を入力し直すと、その項目の案内だけが消える', async () => {
    const user = userEvent.setup()
    render(<TripPlanner generate={vi.fn<GenerateTrip>()} />)

    await user.click(submitButton())
    await user.type(field(/旅行先/), '京')

    expect(screen.queryByText(/旅行先を入力してください/)).toBeNull()
    expect(screen.getByText('入力エラー：日付を選んでください')).toBeTruthy()
  })
})

describe('TripPlanner: 生成の成功', () => {
  it('入力を共通契約のリクエストにして生成を呼び、結果を提案として表示する', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue(success)
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)

    await fillValid(user)
    await user.click(submitButton())

    const heading = await screen.findByRole('heading', { name: '旅程の提案' })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0]).toEqual({
      date: '2026-11-14',
      region: '京都市東山エリア',
      timeZone: 'Asia/Tokyo',
      preferences: ['ゆっくり歩きたい', '抹茶を食べたい'],
      fixedStops: [],
      learnings: [],
    })
    // 結果の見出しへフォーカスが移る。
    expect(document.activeElement).toBe(heading)
    const result = within(screen.getByRole('region', { name: '旅程の提案' }))
    for (const stop of sampleTrip.stops) {
      expect(result.getByText(stop.name)).toBeTruthy()
    }
    expect(result.getByText(/AIの提案です/)).toBeTruthy()
    expect(result.getByText(/まだ照合していません/)).toBeTruthy()
  })

  it('結果の表示は差し替えられ、生成されたTripをそのまま渡す（#8の旅程一覧UIの差し込み口）', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue(success)
    const renderTrip = vi.fn((trip: { id: string }) => <p>一覧UI:{trip.id}</p>)
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} renderTrip={renderTrip} />)

    await fillValid(user)
    await user.click(submitButton())

    expect(await screen.findByText(`一覧UI:${sampleTrip.id}`)).toBeTruthy()
    expect(renderTrip).toHaveBeenCalledWith(sampleTrip)
  })
})

describe('TripPlanner: 生成中', () => {
  it('生成中は状態を示し、入力とボタンを操作できず、二重に生成を呼ばない', async () => {
    let finish: (result: GenerationResult) => void = () => undefined
    const generate = vi.fn<GenerateTrip>().mockReturnValue(
      new Promise<GenerationResult>((resolve) => {
        finish = resolve
      }),
    )
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)

    await fillValid(user)
    await user.click(submitButton())

    expect(await screen.findByText('旅程を生成しています。しばらくお待ちください。')).toBeTruthy()
    expect(submitButton().textContent).toBe('生成中…')
    // fieldsetのdisabledは子の.disabledプロパティではなく、:disabledに反映される（実ブラウザも同じ）。
    expect(submitButton().matches(':disabled')).toBe(true)
    expect(field(/旅行先/).matches(':disabled')).toBe(true)

    // フォームを直接送信されても、二重に呼ばない。
    fireEvent.submit(screen.getByRole('button', { name: '生成中…' }).closest('form')!)
    await user.click(submitButton())
    expect(generate).toHaveBeenCalledTimes(1)

    finish(success)
    expect(await screen.findByRole('heading', { name: '旅程の提案' })).toBeTruthy()
    expect(screen.queryByText('旅程を生成しています。しばらくお待ちください。')).toBeNull()
  })
})

describe('TripPlanner: 生成の失敗', () => {
  it.each([
    ['no_candidates', '条件に合う旅程を作れませんでした'],
    ['insufficient_information', '旅程を作るための情報が足りません'],
    ['external_service_error', 'AIによる旅程の生成に失敗しました'],
    ['interrupted', '通信が中断されました'],
    ['invalid_request', '入力内容を受け付けられませんでした'],
    ['service_unavailable', '旅程の生成は現在利用できません'],
    ['payload_too_large', '入力内容が大きすぎます'],
    ['unauthorized', '認証、招待、またはアプリの検証が通りませんでした'],
    ['rate_limited', '利用の回数が上限に達しました'],
    ['auth_required', '認証情報を取得できず、旅程の生成を送信しませんでした'],
    [
      'app_check_unavailable',
      'アプリの検証（App Check）を用意できず、旅程の生成を送信しませんでした',
    ],
    ['unexpected', '予期しないエラーが発生しました'],
  ] as const)(
    '%s は種類に応じた案内を出し、入力内容を保持したまま再試行できる',
    async (kind, title) => {
      const generate = vi
        .fn<GenerateTrip>()
        .mockResolvedValueOnce({ ok: false, failure: { kind, message: '詳細の説明' } })
        .mockResolvedValueOnce(success)
      const user = userEvent.setup()
      render(<TripPlanner generate={generate} />)

      await fillValid(user)
      await user.click(submitButton())

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain(`エラー：${title}`)
      expect(alert.textContent).toContain('詳細：詳細の説明')
      // 入力内容は失敗後も残り、再度の入力が不要。
      expect((field(/旅行先/) as HTMLInputElement).value).toBe('京都市東山エリア')
      expect((field(/日付/) as HTMLInputElement).value).toBe('2026-11-14')
      expect((field(/希望条件/) as HTMLTextAreaElement).value).toBe(
        'ゆっくり歩きたい\n抹茶を食べたい',
      )
      expect(screen.queryByRole('heading', { name: '旅程の提案' })).toBeNull()

      // そのまま再試行すると、失敗表示は消えて結果が出る。
      await user.click(submitButton())
      expect(await screen.findByRole('heading', { name: '旅程の提案' })).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(generate).toHaveBeenCalledTimes(2)
      expect(generate.mock.calls[1][0]).toEqual(generate.mock.calls[0][0])
    },
  )

  it('生成関数が例外を投げても、操作不能にならず想定外として案内する', async () => {
    const generate = vi.fn<GenerateTrip>().mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)

    await fillValid(user)
    await user.click(submitButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('予期しないエラーが発生しました')
    expect(alert.textContent).not.toContain('boom')
    expect(submitButton().matches(':disabled')).toBe(false)
  })

  it('再生成を始めると、前の条件の結果は消える', async () => {
    let finish: (result: GenerationResult) => void = () => undefined
    const generate = vi
      .fn<GenerateTrip>()
      .mockResolvedValueOnce(success)
      .mockReturnValueOnce(
        new Promise<GenerationResult>((resolve) => {
          finish = resolve
        }),
      )
    const user = userEvent.setup()
    render(<TripPlanner generate={generate} />)

    await fillValid(user)
    await user.click(submitButton())
    expect(await screen.findByRole('heading', { name: '旅程の提案' })).toBeTruthy()

    await user.click(submitButton())
    await waitFor(() => expect(screen.queryByRole('heading', { name: '旅程の提案' })).toBeNull())
    finish({ ok: false, failure: { kind: 'no_candidates', message: 'なし' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('TripPlanner: 画面を離れたとき', () => {
  it('生成中に画面を離れると通信を中止し、結果は反映しない', async () => {
    let signal: AbortSignal | undefined
    let finish: (result: GenerationResult) => void = () => undefined
    const generate = vi.fn<GenerateTrip>().mockImplementation((_request, options) => {
      signal = options?.signal
      return new Promise<GenerationResult>((resolve) => {
        finish = resolve
      })
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const user = userEvent.setup()
    const { unmount } = render(<TripPlanner generate={generate} />)

    await fillValid(user)
    await user.click(submitButton())
    await screen.findByText('旅程を生成しています。しばらくお待ちください。')
    unmount()

    expect(signal?.aborted).toBe(true)
    finish(success)
    await Promise.resolve()
    // 破棄済みの画面への更新による警告が出ていない。
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
