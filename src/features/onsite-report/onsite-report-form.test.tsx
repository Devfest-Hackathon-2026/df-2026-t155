// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RevisionContextSchema, TripSchema, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'

import { OnSiteReportForm, type OnSiteReportStatus } from './onsite-report-form'
import type { OnSiteReportSubmission } from './report-model'

afterEach(() => {
  cleanup()
})

// sampleTrip：朝の庭園（固定）／昼食店A（固定でない）／14時の予約展示（固定）
// twoOpenTrip：朝の庭園（固定）／昼食店A・14時の予約展示（固定でない）
const twoOpenTrip: Trip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) =>
    stop.id === 'stop-exhibition' ? { ...stop, isFixed: false } : stop,
  ),
})
const allFixedTrip: Trip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, isFixed: true })),
})

const IDLE: OnSiteReportStatus = { phase: 'idle' }

const renderForm = (
  props: {
    trip?: Trip
    status?: OnSiteReportStatus
    initialTargetStopId?: string
    onSubmit?: (submission: OnSiteReportSubmission) => void
  } = {},
) => {
  const onSubmit = props.onSubmit ?? vi.fn<(submission: OnSiteReportSubmission) => void>()
  const view = render(
    <OnSiteReportForm
      trip={props.trip ?? sampleTrip}
      status={props.status ?? IDLE}
      onSubmit={onSubmit}
      initialTargetStopId={props.initialTargetStopId}
    />,
  )
  return { onSubmit, ...view }
}

// 親の役割（送ったら処理中にする）を持つ確認用の親。
function Harness({
  trip = sampleTrip,
  onSubmit,
}: {
  trip?: Trip
  onSubmit: (submission: OnSiteReportSubmission) => void
}) {
  const [status, setStatus] = useState<OnSiteReportStatus>(IDLE)
  return (
    <>
      <OnSiteReportForm
        trip={trip}
        status={status}
        onSubmit={(submission) => {
          onSubmit(submission)
          setStatus({ phase: 'submitting' })
        }}
      />
      <button type="button" onClick={() => setStatus({ phase: 'failed', message: '通信に失敗' })}>
        親:失敗にする
      </button>
      <button type="button" onClick={() => setStatus(IDLE)}>
        親:待機に戻す
      </button>
    </>
  )
}

const radio = (name: RegExp) => screen.getByRole('radio', { name })
const queryRadio = (name: RegExp) => screen.queryByRole('radio', { name })
const sendButton = () =>
  screen.getByRole('button', {
    name: /^(報告する|実際の報告として送る|模擬報告として送る|送信しています)/,
  })
const statusRegion = () => screen.getByRole('status', { name: '入力と送信の状況' })
const kindStatusRegion = () => screen.getByRole('status', { name: '報告の種類についての注意' })
const note = () => screen.getByRole('textbox', { name: /補足/ })

describe('対象の予定', () => {
  it('固定予定は選択肢に出ず、固定予定として、選べない理由とともに示される', () => {
    renderForm({ trip: twoOpenTrip })

    expect(queryRadio(/朝の庭園/)).toBeNull()
    expect(radio(/昼食店A/)).toBeTruthy()
    expect(radio(/14時の予約展示/)).toBeTruthy()
    expect(screen.getAllByText(/固定予定は、修正の対象にできないため、選べません/).length).toBe(1)
    const fixedList = screen.getByText('固定予定（修正の対象にできません）').parentElement
    expect(fixedList).not.toBeNull()
    expect(within(fixedList as HTMLElement).getByText(/朝の庭園/)).toBeTruthy()
    expect(within(fixedList as HTMLElement).getByText('固定')).toBeTruthy()
  })

  it('対象が1件だけなら、最初から選択されている', () => {
    renderForm()
    expect((radio(/昼食店A/) as HTMLInputElement).checked).toBe(true)
  })

  it('対象が複数なら、未選択で始まる。initialTargetStopId は固定でない予定のときだけ効く', () => {
    const { unmount } = renderForm({ trip: twoOpenTrip })
    expect((radio(/昼食店A/) as HTMLInputElement).checked).toBe(false)
    expect((radio(/14時の予約展示/) as HTMLInputElement).checked).toBe(false)
    unmount()

    const { unmount: unmount2 } = renderForm({
      trip: twoOpenTrip,
      initialTargetStopId: 'stop-exhibition',
    })
    expect((radio(/14時の予約展示/) as HTMLInputElement).checked).toBe(true)
    unmount2()

    renderForm({ trip: twoOpenTrip, initialTargetStopId: 'stop-morning' })
    expect(screen.queryAllByRole('radio', { checked: true }).length).toBe(0)
  })

  it('すべて固定予定なら、報告できないことを示し、送ろうとすると案内する', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ trip: allFixedTrip })

    expect(screen.getByText('修正できる予定がありません。すべて固定予定です。')).toBeTruthy()
    await user.click(sendButton())
    expect(screen.getByText(/入力エラー：修正できる予定がありません/)).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('送信', () => {
  it('プリセットと報告の種類を選ぶだけで送れる（契約に適合した内容を渡す）', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.click(radio(/閉店・臨時休業/))
    await user.click(radio(/実際の報告/))
    await user.click(sendButton())

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submission = vi.mocked(onSubmit).mock.calls[0][0]
    expect(submission.targetStopId).toBe('stop-lunch')
    expect(submission.context).toEqual({
      phase: 'on_site',
      report: { kind: 'actual', description: '閉店・臨時休業だった' },
    })
    expect(RevisionContextSchema.safeParse(submission.context).success).toBe(true)
    expect(submission.reason).toContain('閉店・臨時休業だった')
  })

  it('模擬報告を選ぶと、kind は simulated で渡る（実際にならない）', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.click(radio(/混んでいて/))
    await user.click(radio(/デモ用の模擬報告/))
    await user.click(sendButton())

    const submission = vi.mocked(onSubmit).mock.calls[0][0]
    expect(submission.context.report.kind).toBe('simulated')
  })

  it('補足は内容に添えられ、空白だけの補足は無視される', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.click(radio(/遅れていて/))
    await user.click(radio(/実際の報告/))
    await user.type(note(), '   ')
    await user.click(sendButton())
    expect(vi.mocked(onSubmit).mock.calls[0][0].context.report.description).toBe(
      '遅れていて、次の予定に間に合わない',
    )

    await user.type(note(), ' 電車が30分遅れ ')
    await user.click(sendButton())
    expect(vi.mocked(onSubmit).mock.calls[1][0].context.report.description).toBe(
      '遅れていて、次の予定に間に合わない。補足：電車が30分遅れ',
    )
  })

  it('「その他」は補足が必須。補足を書けば送れる', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.click(radio(/その他/))
    await user.click(radio(/実際の報告/))
    expect(note().getAttribute('aria-required')).toBe('true')
    await user.click(sendButton())

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/「その他」を選んだときは、状況を書いてください/)).toBeTruthy()
    expect(document.activeElement).toBe(note())

    await user.type(note(), '道が通行止め')
    await user.click(sendButton())
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('送信ボタンは、何も入力していなくても無効にならない', () => {
    renderForm({ trip: twoOpenTrip })
    expect(sendButton().hasAttribute('disabled')).toBe(false)
    expect(sendButton().getAttribute('aria-disabled')).toBeNull()
  })
})

describe('不備の案内とフォーカス', () => {
  it('報告の種類が未選択のまま送ろうとすると、案内して種類の選択へ移動する（送らない）', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.click(radio(/閉店・臨時休業/))
    await user.click(sendButton())

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/入力エラー：報告の種類/)).toBeTruthy()
    expect(
      screen.getByRole('radiogroup', { name: /報告の種類/ }).getAttribute('aria-invalid'),
    ).toBe('true')
    expect(document.activeElement).toBe(radio(/実際の報告/))
  })

  it('既定では、実際にも模擬にも選ばれていない', () => {
    renderForm()
    expect((radio(/実際の報告/) as HTMLInputElement).checked).toBe(false)
    expect((radio(/デモ用の模擬報告/) as HTMLInputElement).checked).toBe(false)
  })

  it('不備が複数あるとき、最初の不備（画面の上から順）へ移動し、件数を知らせる', async () => {
    const user = userEvent.setup()
    renderForm({ trip: twoOpenTrip })

    await user.click(sendButton())

    expect(document.activeElement).toBe(radio(/昼食店A/))
    expect(screen.getByText(/入力エラー：どの予定の状況かを選んでください/)).toBeTruthy()
    expect(screen.getByText(/入力エラー：何が起きたかを選んでください/)).toBeTruthy()
    expect(screen.getByText(/入力エラー：報告の種類/)).toBeTruthy()
    expect(statusRegion().textContent).toContain('入力に不足があります（3件）')
  })

  it('その欄を入力し直すと、その欄の案内だけが消える', async () => {
    const user = userEvent.setup()
    renderForm({ trip: twoOpenTrip })
    await user.click(sendButton())

    await user.click(radio(/昼食店A/))
    expect(screen.queryByText(/入力エラー：どの予定の状況か/)).toBeNull()
    expect(screen.getByText(/入力エラー：何が起きたか/)).toBeTruthy()
    expect(screen.getByText(/入力エラー：報告の種類/)).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: /どの予定/ }).getAttribute('aria-invalid')).toBe(
      'false',
    )

    await user.click(radio(/閉店・臨時休業/))
    expect(screen.queryByText(/入力エラー：何が起きたか/)).toBeNull()
    expect(screen.getByText(/入力エラー：報告の種類/)).toBeTruthy()
    expect(statusRegion().textContent).toContain('（1件）')
  })

  it('「その他」から別のプリセットへ変えると、補足の必須の案内は消える', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(radio(/その他/))
    await user.click(radio(/実際の報告/))
    await user.click(sendButton())
    expect(screen.getByText(/「その他」を選んだときは/)).toBeTruthy()

    await user.click(radio(/閉店・臨時休業/))
    expect(screen.queryByText(/「その他」を選んだときは/)).toBeNull()
    expect(note().getAttribute('aria-required')).toBeNull()
  })
})

describe('模擬報告の注意書き', () => {
  const notice = /デモ用の想定です。実際の出来事ではなく、学びの材料にもしません/

  it('模擬報告を選んだときだけ出る（実際の報告・未選択では出ない）', async () => {
    const user = userEvent.setup()
    renderForm()
    expect(screen.queryByText(notice)).toBeNull()

    await user.click(radio(/デモ用の模擬報告/))
    expect(within(kindStatusRegion()).getByText(notice)).toBeTruthy()

    await user.click(radio(/実際の報告/))
    expect(screen.queryByText(notice)).toBeNull()
  })

  it('送信ボタンの表示でも、実際と模擬を区別する', async () => {
    const user = userEvent.setup()
    renderForm()
    expect(sendButton().textContent).toBe('報告する')
    await user.click(radio(/デモ用の模擬報告/))
    expect(sendButton().textContent).toBe('模擬報告として送る')
    await user.click(radio(/実際の報告/))
    expect(sendButton().textContent).toBe('実際の報告として送る')
  })
})

describe('処理中・失敗', () => {
  it('親が処理中にするまで待たずに、連続した送信を止める（ref による即時ロック）', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(submission: OnSiteReportSubmission) => void>()
    render(<Harness onSubmit={onSubmit} />)
    await user.click(radio(/閉店・臨時休業/))
    await user.click(radio(/実際の報告/))

    // 再描画の前に、2回続けて送信される状況（同じ更新の中）。
    const form = sendButton().closest('form') as HTMLFormElement
    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('処理中は、ボタンの表示が変わり、さらに押しても送らない。入力も変えられない', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(submission: OnSiteReportSubmission) => void>()
    render(<Harness onSubmit={onSubmit} />)
    await user.click(radio(/閉店・臨時休業/))
    await user.click(radio(/実際の報告/))
    await user.click(sendButton())

    expect(sendButton().textContent).toBe('送信しています…')
    expect(sendButton().getAttribute('aria-disabled')).toBe('true')
    expect(statusRegion().textContent).toContain('送信しています')

    await user.click(sendButton())
    await user.click(radio(/混んでいて/))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect((radio(/閉店・臨時休業/) as HTMLInputElement).checked).toBe(true)
    expect((radio(/混んでいて/) as HTMLInputElement).checked).toBe(false)
  })

  it('status が処理中のときは、最初から送らない', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ status: { phase: 'submitting' } })
    await user.click(radio(/閉店・臨時休業/))
    await user.click(radio(/実際の報告/))
    await user.click(sendButton())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('模擬報告の送信中は、模擬報告として送信していることを知らせる', async () => {
    const user = userEvent.setup()
    render(<Harness onSubmit={vi.fn()} />)
    await user.click(radio(/閉店・臨時休業/))
    await user.click(radio(/デモ用の模擬報告/))
    await user.click(sendButton())
    expect(statusRegion().textContent).toContain('模擬報告として送信しています')
  })

  it('失敗すると role=alert で知らせ、入力は残り、再送信できる', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(submission: OnSiteReportSubmission) => void>()
    render(<Harness onSubmit={onSubmit} />)
    await user.click(radio(/その他/))
    await user.click(radio(/デモ用の模擬報告/))
    await user.type(note(), '道が通行止め')
    await user.click(sendButton())
    expect(screen.queryByRole('alert')).toBeNull()

    await user.click(screen.getByRole('button', { name: '親:失敗にする' }))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('通信に失敗')
    // 結果の案内（role=status）と、失敗（role=alert）は、別の要素
    expect(alert.closest('[role="status"]')).toBeNull()
    expect((radio(/その他/) as HTMLInputElement).checked).toBe(true)
    expect((radio(/デモ用の模擬報告/) as HTMLInputElement).checked).toBe(true)
    expect((note() as HTMLTextAreaElement).value).toBe('道が通行止め')
    expect(sendButton().getAttribute('aria-disabled')).toBeNull()

    await user.click(sendButton())
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(vi.mocked(onSubmit).mock.calls[1][0]).toEqual(vi.mocked(onSubmit).mock.calls[0][0])
  })

  it('親が処理中にせず待機のままなら、ロックは次の描画で外れる（送れなくならない）', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()
    await user.click(radio(/閉店・臨時休業/))
    await user.click(radio(/実際の報告/))
    await user.click(sendButton())
    await user.click(sendButton())
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('処理中から待機に戻っても入力は残り、再送信できる', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(submission: OnSiteReportSubmission) => void>()
    render(<Harness onSubmit={onSubmit} />)
    await user.click(radio(/閉店・臨時休業/))
    await user.click(radio(/実際の報告/))
    await user.click(sendButton())
    await user.click(screen.getByRole('button', { name: '親:待機に戻す' }))

    expect((radio(/閉店・臨時休業/) as HTMLInputElement).checked).toBe(true)
    await user.click(sendButton())
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })
})

describe('ライブリージョンと構造', () => {
  it('結果の案内の領域は常設で、最初は空。失敗の alert は失敗したときだけ出る', () => {
    renderForm()
    expect(statusRegion().textContent).toBe('')
    expect(kindStatusRegion().textContent).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('常設の領域は、再描画しても同じ要素のまま、テキストだけが更新される', async () => {
    const user = userEvent.setup()
    renderForm({ trip: twoOpenTrip })
    const region = statusRegion()
    await user.click(sendButton())
    expect(statusRegion()).toBe(region)
    expect(region.textContent).not.toBe('')
  })

  it('各グループに名前があり、必須が伝わる', () => {
    renderForm({ trip: twoOpenTrip })
    for (const name of [/どの予定/, /何が起きました/, /報告の種類/]) {
      const group = screen.getByRole('radiogroup', { name })
      expect(group.getAttribute('aria-required')).toBe('true')
    }
    expect(screen.getByRole('textbox', { name: /補足（任意）/ })).toBeTruthy()
  })

  it('別の旅程に変わると、前の入力と案内は消える', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(submission: OnSiteReportSubmission) => void>()
    const { rerender } = render(
      <OnSiteReportForm trip={twoOpenTrip} status={IDLE} onSubmit={onSubmit} />,
    )
    await user.click(radio(/昼食店A/))
    await user.click(sendButton())
    expect(screen.getByText(/入力エラー：何が起きたか/)).toBeTruthy()

    rerender(
      <OnSiteReportForm
        trip={{ ...twoOpenTrip, id: 'trip-other' }}
        status={IDLE}
        onSubmit={onSubmit}
      />,
    )
    expect(screen.queryByText(/入力エラー/)).toBeNull()
    expect((radio(/昼食店A/) as HTMLInputElement).checked).toBe(false)
  })

  it('選択中の予定が、旅程の更新で固定されたら、その予定は送られない', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<(submission: OnSiteReportSubmission) => void>()
    const { rerender } = render(
      <OnSiteReportForm trip={twoOpenTrip} status={IDLE} onSubmit={onSubmit} />,
    )
    await user.click(radio(/14時の予約展示/))
    await user.click(radio(/閉店・臨時休業/))
    await user.click(radio(/実際の報告/))

    const nowFixed = TripSchema.parse({
      ...twoOpenTrip,
      stops: twoOpenTrip.stops.map((stop) =>
        stop.id === 'stop-exhibition' ? { ...stop, isFixed: true } : stop,
      ),
    })
    rerender(<OnSiteReportForm trip={nowFixed} status={IDLE} onSubmit={onSubmit} />)

    // 選べる予定は昼食店Aだけになり、固定された予定は選択肢から消える。
    expect(queryRadio(/14時の予約展示/)).toBeNull()
    await user.click(sendButton())
    expect(vi.mocked(onSubmit).mock.calls[0][0].targetStopId).toBe('stop-lunch')
  })
})
