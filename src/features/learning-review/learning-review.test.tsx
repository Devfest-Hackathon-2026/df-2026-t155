// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { startTransition, useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApprovedLearning, Learning, Revision, Trip } from '@/domain'
import { MANUAL_UNVERIFIED } from '@/domain/manual-revision'
import { sampleLearning, sampleRevision, sampleTrip } from '@/domain/samples'

import type { CandidatesResult } from './api-client'
import { LearningReview, type RequestCandidates } from './learning-review'

afterEach(() => {
  cleanup()
})

const NOW = new Date('2026-11-08T10:00:00+09:00')
const learningWith = (id: string, content = sampleLearning.content): Learning => ({
  ...sampleLearning,
  id,
  content,
})
const proposed = (...learnings: Learning[]): CandidatesResult => ({ ok: true, learnings })

// 承認済みの変更。sampleRevision は模擬報告（on_site・simulated）。
const approvedSimulated: Revision = {
  ...sampleRevision,
  constraintCheck: { status: 'satisfied', explanation: 'テスト用' },
  approval: { status: 'approved', decidedAt: '2026-11-08T12:10:00+09:00' },
}
const approvedActual: Revision = {
  ...approvedSimulated,
  id: 'revision-actual',
  context: { phase: 'on_site', report: { kind: 'actual', description: '昼食店Aが臨時休業だった' } },
}

type Props = Partial<React.ComponentProps<typeof LearningReview>>

const setup = (result: CandidatesResult = proposed(sampleLearning), props: Props = {}) => {
  const request = vi.fn<RequestCandidates>().mockResolvedValue(result)
  const onApprovedChange = vi.fn<(approved: ApprovedLearning[]) => void>()
  const user = userEvent.setup()
  const view = render(
    <LearningReview
      trip={sampleTrip}
      requestCandidates={request}
      now={() => NOW}
      onApprovedChange={onApprovedChange}
      {...props}
    />,
  )
  const rerender = (next: Props) =>
    view.rerender(
      <LearningReview
        trip={sampleTrip}
        requestCandidates={request}
        now={() => NOW}
        onApprovedChange={onApprovedChange}
        {...props}
        {...next}
      />,
    )
  return { request, onApprovedChange, user, rerender }
}

it('本人確認の採用履歴を未確認として表示し、自動承認の履歴と区別する', () => {
  const id = 'manual-revision-test'
  const manual = {
    ...approvedActual,
    id,
    method: 'manual',
    diff: {
      ...approvedActual.diff,
      after: { ...approvedActual.diff.after, evidence: [], manualRevisionId: id },
    },
    constraintCheck: { status: 'unknown' as const, explanation: MANUAL_UNVERIFIED },
    confirmation: {
      source: 'https://example.com/hours',
      checked: '訪問日の営業時間を確認',
      remaining: '臨時休業の有無',
    },
  }
  setup(undefined, { revisions: [approvedActual, manual] })
  const history = within(screen.getByRole('region', { name: '変更の履歴' }))
  const [automatic, manualRow] = history.getAllByRole('listitem')
  expect(within(automatic).getByText('承認済み（学びの材料にします）')).toBeTruthy()
  expect(within(automatic).queryByText('本人確認による採用')).toBeNull()
  const record = within(manualRow)
  expect(record.getByText('本人確認による採用')).toBeTruthy()
  expect(record.getByText(/外部照合の判定：未確認/)).toBeTruthy()
  expect(record.getByText(manual.confirmation.source)).toBeTruthy()
  expect(record.getByText(manual.confirmation.checked)).toBeTruthy()
  expect(record.getByText(manual.confirmation.remaining)).toBeTruthy()
})

const feedback = () => screen.getByLabelText(/感想・変更した理由/)
const makeButton = () => screen.getByRole('button', { name: /学びの候補を作/ })
const lastApproved = (fn: ReturnType<typeof setup>['onApprovedChange']) =>
  fn.mock.lastCall?.[0] ?? []
const approvedHeading = (count: number) =>
  screen.getByRole('heading', { name: `承認済みの学び（${count}件）` })

const generate = async (
  user: ReturnType<typeof userEvent.setup>,
  text = '昼食後は休みたかった',
) => {
  const textarea = feedback()
  await user.clear(textarea)
  await user.type(textarea, text)
  await user.click(makeButton())
  await screen.findByRole('heading', { name: /学びの候補（/ })
}

describe('LearningReview: 表示と候補の作成', () => {
  it('冒頭で、承認しても保存・次回への反映は行われないことを明示する', () => {
    setup()
    const intro = screen.getByText(/いまの画面で承認しても/)

    expect(intro.textContent).toContain('保存されず')
    expect(intro.textContent).toContain('次回の旅程づくりにも反映されません')
    expect(approvedHeading(0)).toBeTruthy()
  })

  it('感想を送って候補を作る。候補は未承認で、承認済みには入らない', async () => {
    const { request, onApprovedChange, user } = setup()
    await generate(user)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toMatchObject({
      trip: sampleTrip,
      feedback: '昼食後は休みたかった',
    })
    expect(screen.getByText('未承認')).toBeTruthy()
    expect(approvedHeading(0)).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])
  })

  it('候補が出たら、見出しへフォーカスを移す。見出しには、フォーカスの表示がある', async () => {
    const { user } = setup()
    await generate(user)
    const heading = screen.getByRole('heading', { name: /学びの候補（/ })

    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(heading.className).toContain('focus:outline')
    expect(heading.className).not.toContain('outline-none')
  })

  it('失敗したら理由を示し、入力した感想は残す', async () => {
    const { user } = setup({
      ok: false,
      failure: { kind: 'external_service_error', message: 'AIに接続できませんでした。' },
    })
    await user.type(feedback(), '昼食後は休みたかった')
    await user.click(makeButton())

    expect((await screen.findByRole('alert')).textContent).toContain('AIに接続できませんでした。')
    expect((feedback() as HTMLTextAreaElement).value).toBe('昼食後は休みたかった')
    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
  })

  it('感想が長すぎるときは、AIを呼ばずに案内する', async () => {
    const { request, user } = setup()
    await user.click(feedback())
    await user.paste('あ'.repeat(1001))
    await user.click(makeButton())

    expect(request).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('1000文字以内')
  })
})

describe('LearningReview: 材料の判定（模擬報告）', () => {
  it('材料（感想も使える変更も）が無いときは、ボタンは押せて、AIを呼ばず感想欄を示す', async () => {
    const { request, user } = setup()
    const button = makeButton()
    expect(button.getAttribute('aria-disabled')).toBeNull()

    await user.click(button)

    expect(request).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('感想を入力')
    expect(feedback().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(feedback())
  })

  it('承認済みの模擬報告だけで、感想が無ければ、APIを呼ばず、入力案内へ誘導する', async () => {
    const { request, user } = setup(proposed(sampleLearning), { revisions: [approvedSimulated] })

    await user.click(makeButton())

    expect(request).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('感想を入力')
    expect(document.activeElement).toBe(feedback())
  })

  it('承認済みで、実際の報告に基づく変更があれば、感想が空でも作成できる', async () => {
    const { request, user } = setup(proposed(sampleLearning), { revisions: [approvedActual] })

    await user.click(makeButton())

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('模擬報告と感想があれば作成できる（模擬報告は材料として案内しない）', async () => {
    const { request, user } = setup(proposed(sampleLearning), { revisions: [approvedSimulated] })
    await user.type(feedback(), '昼食後は休みたかった')
    await user.click(makeButton())

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('変更の履歴で、実報告・模擬報告・未承認を区別して案内する', () => {
    setup(proposed(sampleLearning), {
      revisions: [
        approvedActual,
        { ...approvedSimulated, id: 'revision-simulated' },
        { ...sampleRevision, id: 'revision-pending' },
      ],
    })
    const items = within(screen.getByRole('heading', { name: '変更の履歴' }).parentElement!)
    expect(items.getAllByText(/報告の種類：模擬報告/)).toHaveLength(2)
    expect(items.getAllByText('報告の種類：現地の実際の報告')).toHaveLength(1)

    expect(screen.getAllByText('承認済み（学びの材料にします）')).toHaveLength(1)
    expect(
      screen.getAllByText('模擬報告（デモ用の想定）のため、学びの材料にしません'),
    ).toHaveLength(1)
    expect(screen.getAllByText('未承認または却下のため、学びの材料にしません')).toHaveLength(1)
  })
})

describe('LearningReview: 承認・却下・編集', () => {
  it('承認すると承認済みの一覧に入り、承認済みだけが通知される', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)

    await user.click(screen.getByRole('button', { name: '承認する' }))

    expect(approvedHeading(1)).toBeTruthy()
    const last = lastApproved(onApprovedChange)
    expect(last).toHaveLength(1)
    expect(last[0].approval).toEqual({ status: 'approved', decidedAt: NOW.toISOString() })
  })

  it('却下した学びは承認済みに入らない。取り消すと未承認に戻り、「承認する」へフォーカスが移る', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)

    await user.click(screen.getByRole('button', { name: '却下する' }))
    expect(approvedHeading(0)).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])

    await user.click(screen.getByRole('button', { name: '却下を取り消す' }))
    expect(screen.getByText('未承認')).toBeTruthy()
    expect(approvedHeading(0)).toBeTruthy()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '承認する' })),
    )
  })

  it('内容を編集してから承認すると、編集後の内容が承認される', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    const content = screen.getByLabelText('学びの内容')
    await user.clear(content)
    await user.type(content, '昼食の候補は2つ用意したい')

    await user.click(screen.getByRole('button', { name: '承認する' }))

    expect(lastApproved(onApprovedChange)[0].content).toBe('昼食の候補は2つ用意したい')
  })

  it('適用範囲を「すべての旅行」に変えて承認できる', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    await user.selectOptions(screen.getByLabelText('適用範囲'), 'all_trips')

    await user.click(screen.getByRole('button', { name: '承認する' }))

    expect(lastApproved(onApprovedChange)[0].scope).toEqual({ kind: 'all_trips' })
  })

  it('承認済みの内容を編集し始めた時点で、承認が取り消され、承認済み一覧と通知から外れる', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))
    expect(approvedHeading(1)).toBeTruthy()

    await user.type(screen.getByLabelText('学びの内容'), 'あ')

    expect(approvedHeading(0)).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])
    expect(screen.getByText('未承認')).toBeTruthy()
    expect(screen.queryByText('承認済み')).toBeNull()
    // 案内は、カードの近くに表示され、読み上げは常設のライブリージョンにも入る（2か所に同じ文言がある）。
    expect(screen.getAllByText(/承認が取り消されました/).length).toBeGreaterThan(0)
  })

  it('適用範囲を変え始めた時点でも、承認が取り消される', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))

    await user.selectOptions(screen.getByLabelText('適用範囲'), 'all_trips')

    expect(onApprovedChange).toHaveBeenLastCalledWith([])
    expect(approvedHeading(0)).toBeTruthy()
  })

  it('入力途中の空欄は下書きとして保持し、承認時に検証する（承認されず、理由が出る）', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    await user.clear(screen.getByLabelText('学びの内容'))

    expect((screen.getByLabelText('学びの内容') as HTMLTextAreaElement).value).toBe('')
    await user.click(screen.getByRole('button', { name: '承認する' }))

    expect(screen.getByText('学びの内容を入力してください')).toBeTruthy()
    expect(approvedHeading(0)).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])
  })

  it('承認後に内容を変え、承認し直すと、新しい内容に置き換わる', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))
    const content = screen.getByLabelText('学びの内容')
    await user.clear(content)
    await user.type(content, '昼食は予約しておく')

    await user.click(screen.getByRole('button', { name: '承認する' }))

    const approved = lastApproved(onApprovedChange)
    expect(approved).toHaveLength(1)
    expect(approved[0].content).toBe('昼食は予約しておく')
  })

  it('承認済みの一覧には、内容と適用範囲が表示され、長い文字列は折り返す', async () => {
    const long = 'あ'.repeat(100)
    const { user } = setup(proposed(learningWith('learning-long', long)))
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))

    const list = approvedHeading(1).parentElement as HTMLElement
    expect(within(list).getByText(new RegExp(long))).toBeTruthy()
    expect(list.querySelector('ul')?.className).toContain('break-words')
  })
})

describe('LearningReview: 再生成で、既存のデータを失わない', () => {
  it('再生成に成功しても、承認結果・編集中の内容は消えず、新しい候補が追加される', async () => {
    const request = vi
      .fn<RequestCandidates>()
      .mockResolvedValueOnce(proposed(learningWith('learning-a', '1件目の学び')))
      .mockResolvedValueOnce(proposed(learningWith('learning-b', '2件目の学び')))
    const { onApprovedChange, user } = setup(undefined, { requestCandidates: request })
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))
    await user.type(screen.getByLabelText('学びの内容'), '（追記）')
    await user.click(screen.getByRole('button', { name: '承認する' }))

    await generate(user, '別の感想')

    expect(screen.getByRole('heading', { name: '学びの候補（2件）' })).toBeTruthy()
    expect(approvedHeading(1)).toBeTruthy()
    expect(lastApproved(onApprovedChange)[0].content).toBe('1件目の学び（追記）')
    expect(screen.getByDisplayValue('2件目の学び')).toBeTruthy()
  })

  it('再生成に成功しても、編集中（未承認）の内容は、そのまま残る', async () => {
    const request = vi
      .fn<RequestCandidates>()
      .mockResolvedValueOnce(proposed(learningWith('learning-a', '1件目の学び')))
      .mockResolvedValueOnce(proposed(learningWith('learning-b', '2件目の学び')))
    const { user } = setup(undefined, { requestCandidates: request })
    await generate(user)
    await user.type(screen.getByLabelText('学びの内容'), '（編集中）')

    await generate(user, '別の感想')

    expect(screen.getByDisplayValue('1件目の学び（編集中）')).toBeTruthy()
    expect(screen.getByDisplayValue('2件目の学び')).toBeTruthy()
  })

  it('再生成に失敗しても、承認結果・編集中の内容は、そのまま残る', async () => {
    const request = vi
      .fn<RequestCandidates>()
      .mockResolvedValueOnce(proposed(learningWith('learning-a', '1件目の学び')))
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'external_service_error', message: '接続できませんでした。' },
      })
    const { onApprovedChange, user } = setup(undefined, { requestCandidates: request })
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))
    await user.click(makeButton())

    expect((await screen.findByRole('alert')).textContent).toContain('そのまま残っています')
    expect(approvedHeading(1)).toBeTruthy()
    expect(lastApproved(onApprovedChange)).toHaveLength(1)
    expect(screen.getByDisplayValue('1件目の学び')).toBeTruthy()
  })
})

const deferred = () => {
  let resolve: (value: CandidatesResult) => void = () => undefined
  const promise = new Promise<CandidatesResult>((r) => (resolve = r))
  return { promise, resolve }
}

describe('LearningReview: 非同期の競合', () => {
  it('送信の直後に、すぐ、もう一度押しても、二重に送らない（即時ロック）', async () => {
    const pending = deferred()
    const request = vi.fn<RequestCandidates>(() => pending.promise)
    const { user } = setup(undefined, { requestCandidates: request })
    await user.type(feedback(), '感想')

    await user.click(makeButton())
    await user.click(screen.getByRole('button', { name: /作っています/ }))
    await user.click(screen.getByRole('button', { name: /作っています/ }))

    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve(proposed(sampleLearning))
    await screen.findByRole('heading', { name: /学びの候補（/ })
  })

  it('リクエスト中に旅程が更新されたら、進行中の取得を中止し、古い応答を候補として採用しない', async () => {
    const pending = deferred()
    const signals: AbortSignal[] = []
    const request = vi.fn<RequestCandidates>((_request, options) => {
      if (options?.signal) signals.push(options.signal)
      return pending.promise
    })
    const { user, rerender } = setup(undefined, { requestCandidates: request })
    await user.type(feedback(), '感想')
    await user.click(makeButton())

    const updated: Trip = { ...sampleTrip, version: sampleTrip.version + 1 }
    rerender({ trip: updated })
    await act(async () => {
      pending.resolve(proposed(sampleLearning))
    })

    expect(signals[0].aborted).toBe(true)
    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
    expect(approvedHeading(0)).toBeTruthy()
    // 更新後は、もう一度、送信できる。
    expect(makeButton().getAttribute('aria-disabled')).toBeNull()
  })

  it('リクエスト中に変更履歴が更新されても、古い応答を採用しない', async () => {
    const pending = deferred()
    const request = vi.fn<RequestCandidates>(() => pending.promise)
    const { user, rerender } = setup(undefined, { requestCandidates: request })
    await user.type(feedback(), '感想')
    await user.click(makeButton())

    rerender({ revisions: [approvedActual] })
    await act(async () => {
      pending.resolve(proposed(sampleLearning))
    })

    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
  })

  it('古い応答が、新しい送信の結果を、上書きしない', async () => {
    const first = deferred()
    const second = deferred()
    const request = vi
      .fn<RequestCandidates>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const { user, rerender } = setup(undefined, { requestCandidates: request })
    await user.type(feedback(), '感想')
    await user.click(makeButton())
    // 更新で1回目は古くなる。2回目を送る。
    rerender({ revisions: [approvedActual] })
    await user.click(makeButton())

    await act(async () => {
      second.resolve(proposed(learningWith('learning-new', '新しい結果')))
    })
    await act(async () => {
      first.resolve(proposed(learningWith('learning-old', '古い結果')))
    })

    expect(screen.getByDisplayValue('新しい結果')).toBeTruthy()
    expect(screen.queryByDisplayValue('古い結果')).toBeNull()
  })

  it('別の旅程に切り替わったら、前の旅程の候補・承認状態を消し、親へも空を通知する', async () => {
    const { onApprovedChange, user, rerender } = setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))
    expect(lastApproved(onApprovedChange)).toHaveLength(1)

    rerender({ trip: { ...sampleTrip, id: 'trip-other' } })

    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
    expect(approvedHeading(0)).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])
    expect((feedback() as HTMLTextAreaElement).value).toBe('')
  })

  it('別の旅程に切り替わったあとに届いた、前の旅程の応答は、採用しない', async () => {
    const pending = deferred()
    const request = vi.fn<RequestCandidates>(() => pending.promise)
    const { user, rerender } = setup(undefined, { requestCandidates: request })
    await user.type(feedback(), '感想')
    await user.click(makeButton())

    rerender({ trip: { ...sampleTrip, id: 'trip-other' } })
    await act(async () => {
      pending.resolve(proposed(sampleLearning))
    })

    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
  })
})

describe('LearningReview: 候補の取り込み時の検証（差し替えた取得関数の応答にも適用）', () => {
  const failsToAdopt = async (result: CandidatesResult, expected: string) => {
    const { user } = setup(result)
    await user.type(feedback(), '感想')
    await user.click(makeButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(expected)
    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
  }

  it('同じIDの候補が複数あれば、全体を採用しない', async () => {
    await failsToAdopt(proposed(sampleLearning, sampleLearning), '同じID')
  })

  it('承認済みの候補が含まれていれば、全体を採用しない', async () => {
    const approved: Learning = {
      ...learningWith('learning-x'),
      approval: { status: 'approved', decidedAt: '2026-11-08T10:00:00+09:00' },
    }
    await failsToAdopt(proposed(sampleLearning, approved), '承認済み')
  })

  it('別の旅程の候補は、採用しない', async () => {
    await failsToAdopt(
      proposed({ ...learningWith('learning-x'), sourceTripId: 'trip-other' }),
      '別の旅程',
    )
  })

  it('旅程の地域と一致しない候補は、採用しない', async () => {
    await failsToAdopt(
      proposed({ ...learningWith('learning-y'), scope: { kind: 'region', region: '別の地域' } }),
      '地域',
    )
  })

  it('4件以上の候補は、採用しない', async () => {
    await failsToAdopt(
      proposed(...['a', 'b', 'c', 'd'].map((n) => learningWith(`learning-${n}`))),
      '候補の数',
    )
  })

  it('既存の候補と同じIDの候補は、再生成でも採用しない（既存の承認結果を守る）', async () => {
    const request = vi
      .fn<RequestCandidates>()
      .mockResolvedValueOnce(proposed(sampleLearning))
      .mockResolvedValueOnce(proposed({ ...sampleLearning, content: '上書きしようとする内容' }))
    const { onApprovedChange, user } = setup(undefined, { requestCandidates: request })
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))
    await user.click(makeButton())

    expect((await screen.findByRole('alert')).textContent).toContain('同じID')
    expect(lastApproved(onApprovedChange)[0].content).toBe(sampleLearning.content)
    expect(screen.queryByDisplayValue('上書きしようとする内容')).toBeNull()
  })
})

describe('LearningReview: 再レビューの指摘', () => {
  it('未承認の模擬報告は、「模擬報告」かつ「未承認」と、独立して示す（通常の未承認報告と区別する）', () => {
    setup(proposed(sampleLearning), {
      revisions: [
        { ...sampleRevision, id: 'revision-sim-pending' },
        {
          ...sampleRevision,
          id: 'revision-act-pending',
          context: { phase: 'on_site', report: { kind: 'actual', description: '休業だった' } },
        },
      ],
    })
    const list = screen.getByRole('heading', { name: '変更の履歴' }).parentElement!
    const [simulated, actual] = within(list).getAllByRole('listitem')

    expect(simulated.textContent).toContain(
      '報告の種類：模擬報告（デモ用の想定。実際の出来事ではありません）',
    )
    expect(simulated.textContent).toContain('承認の状態：未承認')
    expect(actual.textContent).toContain('報告の種類：現地の実際の報告')
    expect(actual.textContent).toContain('承認の状態：未承認')
    expect(actual.textContent).not.toContain('模擬報告')
  })

  it('同じ旅程IDで地域が変わったら、候補と承認結果をリセットし、旧地域の承認を残さない', async () => {
    const { onApprovedChange, user, rerender } = setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))
    expect(lastApproved(onApprovedChange)).toHaveLength(1)

    rerender({ trip: { ...sampleTrip, region: '別の地域' } })

    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
    expect(approvedHeading(0)).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])
    expect(screen.getByText(/旅程の地域が変わったため/)).toBeTruthy()
    expect((feedback() as HTMLTextAreaElement).value).toBe('')
  })

  it('地域変更のリセット表示は、次に候補を作る操作で消える（残り続けない）', async () => {
    // 地域が変わったあとの旅程に合う候補（すべての旅行向け）を返す。
    const { user, rerender } = setup(proposed({ ...sampleLearning, scope: { kind: 'all_trips' } }))
    rerender({ trip: { ...sampleTrip, region: '別の地域' } })
    expect(screen.getByText(/旅程の地域が変わったため/)).toBeTruthy()

    await user.type(feedback(), '感想')
    await user.click(makeButton())
    await screen.findByRole('heading', { name: /学びの候補（/ })

    expect(screen.queryByText(/旅程の地域が変わったため/)).toBeNull()
  })

  it('地域が変わったあとに届いた、旧地域の応答は採用しない', async () => {
    const pending = deferred()
    const request = vi.fn<RequestCandidates>(() => pending.promise)
    const { user, rerender } = setup(undefined, { requestCandidates: request })
    await user.type(feedback(), '感想')
    await user.click(makeButton())

    rerender({ trip: { ...sampleTrip, region: '別の地域' } })
    await act(async () => {
      pending.resolve(proposed(sampleLearning))
    })

    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
  })

  it('ID が "__proto__" の候補でも、描画でき、入力不備の案内を出せる', async () => {
    const { user } = setup(proposed(learningWith('__proto__')))
    await generate(user)

    await user.clear(screen.getByLabelText('学びの内容'))
    await user.click(screen.getByRole('button', { name: '承認する' }))

    expect(screen.getByRole('heading', { name: /学びの候補（1件）/ })).toBeTruthy()
    const message = screen.getAllByRole('status').find((el) => el.textContent?.includes('入力'))
    expect(message).toBeTruthy()
  })

  it('旅程の更新が transition でコミットされた直後（副作用の実行前）に旧応答が届いても、採用しない', async () => {
    const pending = deferred()
    const request = vi.fn<RequestCandidates>(() => pending.promise)
    const updated: Trip = { ...sampleTrip, version: sampleTrip.version + 1 }
    let setTripRef: (trip: Trip) => void = () => undefined

    // コミット（レイアウト効果）の時点で、旧リクエストの応答を返す。副作用（useEffect）はまだ実行されていない。
    function Probe({ trip }: { trip: Trip }) {
      useLayoutEffect(() => {
        if (trip.version === updated.version) pending.resolve(proposed(sampleLearning))
      }, [trip])
      return null
    }
    function Harness() {
      const [trip, setTrip] = useState<Trip>(sampleTrip)
      setTripRef = setTrip
      return (
        <>
          <LearningReview trip={trip} requestCandidates={request} now={() => NOW} />
          <Probe trip={trip} />
        </>
      )
    }

    const user = userEvent.setup()
    render(<Harness />)
    await user.type(feedback(), '感想')
    await user.click(makeButton())

    // act の外で実行する（act は副作用を同期的に流すため、この競合を再現できない）。
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const previous = env.IS_REACT_ACT_ENVIRONMENT
    env.IS_REACT_ACT_ENVIRONMENT = false
    try {
      startTransition(() => setTripRef(updated))
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous
    }

    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
  })
})
