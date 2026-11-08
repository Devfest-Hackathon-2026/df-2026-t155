// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApprovedLearning } from '@/domain'
import { sampleLearning, sampleTrip } from '@/domain/samples'

import type { CandidatesResult } from './api-client'
import { LearningReview, type RequestCandidates } from './learning-review'
import type { LearningStore, SaveOptions, SaveResult } from './store'

afterEach(() => {
  cleanup()
})

const NOW = new Date('2026-11-08T10:00:00+09:00')

type SaveFn = (approved: ApprovedLearning[], options?: SaveOptions) => Promise<SaveResult>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Props = Partial<React.ComponentProps<typeof LearningReview>>

const setup = (save: SaveFn | null = async () => ({ ok: true }), props: Props = {}) => {
  const saveMock = vi.fn<SaveFn>(save ?? (async () => ({ ok: true })))
  const store: LearningStore | undefined = save === null ? undefined : { save: saveMock }
  const result: CandidatesResult = { ok: true, learnings: [sampleLearning] }
  const request = vi.fn<RequestCandidates>().mockResolvedValue(result)
  const user = userEvent.setup()
  const element = (next: Props = {}) => (
    <LearningReview
      trip={sampleTrip}
      requestCandidates={request}
      now={() => NOW}
      store={store}
      {...props}
      {...next}
    />
  )
  const view = render(element())
  return {
    saveMock,
    user,
    view,
    rerender: (next: Props) => view.rerender(element(next)),
  }
}

const saveButton = () => screen.getByRole('button', { name: /保存する|保存しています/ })
const approveButton = () => screen.getByRole('button', { name: '承認する' })
const statusText = () => screen.getByText(/^保存の状態/).parentElement?.textContent ?? ''
const liveRegion = () => screen.getByRole('status')
// 保存ボタン付近の案内（ライブリージョンの読み上げ用の複製とは別）。
const saveNotice = () => document.getElementById('learning-save-notice')

// 感想を送って候補を出し、承認する。
const generateAndApprove = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText(/感想・変更した理由/), '昼食後は休みたかった')
  await user.click(screen.getByRole('button', { name: /学びの候補を作/ }))
  await screen.findByRole('heading', { name: /学びの候補（/ })
  await user.click(approveButton())
}

describe('LearningReview: 保存済みの承認は、画面上の編集・却下では取り消されない', () => {
  it('保存先があるときは、編集・却下が保存済みの承認を取り消さないことと、撤回の操作が無いことを示す', async () => {
    setup()

    const note = document.getElementById('learning-saved-approval-note')
    expect(note?.textContent).toContain('画面上の編集・却下は、保存済みの承認を取り消しません')
    expect(note?.textContent).toContain('撤回する操作は、まだ提供していません')
  })

  it('保存した後に却下しても、保存先には何も送らず、以前の保存は変わらないと示す', async () => {
    const { saveMock, user } = setup()
    await generateAndApprove(user)
    await user.click(saveButton())
    await waitFor(() => expect(statusText()).toContain('保存済み'))

    await user.click(screen.getByRole('button', { name: '却下する' }))

    // 却下は画面だけの操作。保存の呼び出しは増えず、状態行も「以前の保存は変わらない」と言う。
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(statusText()).toContain('以前に保存した内容は、まだ変わっていません')
    expect(document.getElementById('learning-saved-approval-note')?.textContent).toContain(
      '取り消しません',
    )
  })

  it('保存先が無いとき（デモ）は、保存済みの承認の話はしない', () => {
    setup(null)

    expect(document.getElementById('learning-saved-approval-note')).toBeNull()
  })
})

describe('LearningReview: store が無いとき', () => {
  it('これまでどおり、保存されないことを示し、保存ボタンは出さない', async () => {
    const { user } = setup(null)
    await generateAndApprove(user)

    expect(screen.getByText(/いまの画面で承認しても/).textContent).toContain('保存されず')
    expect(screen.getByText(/まだ保存されません（保存は、ログインの機能/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull()
    expect(screen.queryByText(/保存の状態/)).toBeNull()
  })
})

describe('LearningReview: 承認と保存は別の状態', () => {
  it('承認しただけでは保存されず、保存済みとも表示しない（未保存の変更あり）', async () => {
    const { saveMock, user } = setup()
    await generateAndApprove(user)

    expect(saveMock).not.toHaveBeenCalled()
    expect(statusText()).toContain('未保存')
    expect(statusText()).not.toContain('保存済み')
    expect(screen.getByText(/承認しただけでは、保存されません/)).toBeTruthy()
  })

  it('保存ボタンは常に押せる（承認済みが0件でも無効化しない）', () => {
    setup()

    expect(saveButton().getAttribute('disabled')).toBeNull()
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()
  })

  it('承認済みが0件で押したら、保存せず、理由を案内する', async () => {
    const { saveMock, user } = setup()
    expect(statusText()).toContain('保存できる承認済みの学びはまだありません')

    await user.click(saveButton())

    expect(saveMock).not.toHaveBeenCalled()
    expect(saveNotice()?.textContent).toContain('承認してから、保存してください')
    expect(liveRegion().textContent).toContain('承認してから、保存してください')
  })

  it('承認が済んだら、0件の案内は消える', async () => {
    const { user } = setup()
    await user.click(saveButton())
    expect(saveNotice()).not.toBeNull()

    await generateAndApprove(user)

    expect(saveNotice()).toBeNull()
  })
})

describe('LearningReview: 保存の成功・失敗・再試行', () => {
  it('保存を押すと、承認済みの学びだけを渡し、成功したら保存済みと示す', async () => {
    const { saveMock, user } = setup()
    await generateAndApprove(user)

    await user.click(saveButton())

    await waitFor(() => expect(statusText()).toContain('保存済み'))
    expect(saveMock).toHaveBeenCalledTimes(1)
    const [approved, options] = saveMock.mock.calls[0]
    expect(approved).toHaveLength(1)
    expect(approved[0].approval).toEqual({ status: 'approved', decidedAt: NOW.toISOString() })
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(liveRegion().textContent).toContain('承認した学び1件を保存しました')
  })

  it('保存中は「保存中」と示す', async () => {
    const pending = deferred<SaveResult>()
    const { user } = setup(() => pending.promise)
    await generateAndApprove(user)

    await user.click(saveButton())

    expect(statusText()).toContain('保存中')
    expect(statusText()).not.toContain('保存済み')
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    await act(async () => pending.resolve({ ok: true }))
    expect(statusText()).toContain('保存済み')
  })

  it('失敗したら理由を示し、承認済みと入力中の内容を残す。再試行で成功すれば保存済みになる', async () => {
    let calls = 0
    const { saveMock, user } = setup(async () => {
      calls += 1
      return calls === 1 ? { ok: false, message: '通信に失敗しました。' } : { ok: true }
    })
    await generateAndApprove(user)
    await user.click(saveButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('保存できませんでした。通信に失敗しました。')
    expect(statusText()).toContain('保存に失敗')
    expect(statusText()).not.toContain('保存済み')
    expect(screen.getByRole('heading', { name: '承認済みの学び（1件）' })).toBeTruthy()
    expect(screen.getByLabelText('学びの内容')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'もう一度、保存する' }))

    await waitFor(() => expect(statusText()).toContain('保存済み'))
    expect(saveMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('保存が例外を投げても、保存できませんでしたと示し、再試行できる', async () => {
    const { saveMock, user } = setup(async () => {
      throw new Error('内部エラー')
    })
    await generateAndApprove(user)

    await user.click(saveButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('保存できませんでした。')
    expect(alert.textContent).not.toContain('内部エラー')
    expect(screen.getByRole('button', { name: 'もう一度、保存する' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'もう一度、保存する' }))
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2))
  })

  it('保存に失敗しても、承認済みの内容と、別の候補の編集中の内容は消えない', async () => {
    const request = vi.fn<RequestCandidates>().mockResolvedValue({
      ok: true,
      learnings: [
        { ...sampleLearning, id: 'learning-a', content: '候補Aの内容' },
        { ...sampleLearning, id: 'learning-b', content: '候補Bの内容' },
      ],
    })
    const { user } = setup(async () => ({ ok: false, message: '失敗' }), {
      requestCandidates: request,
    })
    await user.type(screen.getByLabelText(/感想・変更した理由/), '感想')
    await user.click(screen.getByRole('button', { name: /学びの候補を作/ }))
    await screen.findByRole('heading', { name: /学びの候補（2件）/ })
    await user.click(screen.getAllByRole('button', { name: '承認する' })[0])
    const [, second] = screen.getAllByLabelText('学びの内容') as HTMLTextAreaElement[]
    await user.type(second, '（編集中）')

    await user.click(saveButton())

    await screen.findByRole('alert')
    expect(screen.getByRole('heading', { name: '承認済みの学び（1件）' })).toBeTruthy()
    const [first, again] = screen.getAllByLabelText('学びの内容') as HTMLTextAreaElement[]
    expect(first.value).toBe('候補Aの内容')
    expect(again.value).toBe('候補Bの内容（編集中）')
  })
})

describe('LearningReview: 保存先が返す、項目ごとの結果（任意の拡張）', () => {
  const twoCandidates = () =>
    vi.fn<RequestCandidates>().mockResolvedValue({
      ok: true,
      learnings: [
        { ...sampleLearning, id: 'learning-a', content: '候補Aの内容' },
        { ...sampleLearning, id: 'learning-b', content: '候補Bの内容' },
      ],
    })
  const threeCandidates = () =>
    vi.fn<RequestCandidates>().mockResolvedValue({
      ok: true,
      learnings: [
        { ...sampleLearning, id: 'learning-a', content: '候補Aの内容' },
        { ...sampleLearning, id: 'learning-b', content: '候補Bの内容' },
        { ...sampleLearning, id: 'learning-c', content: '候補Cの内容' },
      ],
    })
  const approveAll = async (user: ReturnType<typeof userEvent.setup>, count: number) => {
    await user.type(screen.getByLabelText(/感想・変更した理由/), '感想')
    await user.click(screen.getByRole('button', { name: /学びの候補を作/ }))
    await screen.findByRole('heading', { name: new RegExp('学びの候補（' + count + '件）') })
    for (let index = 0; index < count; index += 1) {
      await user.click(screen.getAllByRole('button', { name: '承認する' })[0])
    }
  }
  const approveBoth = (user: ReturnType<typeof userEvent.setup>) => approveAll(user, 2)
  const approvedItems = (count = 2) =>
    within(
      screen.getByRole('heading', { name: new RegExp('承認済みの学び（' + count + '件）') })
        .parentElement as HTMLElement,
    ).getAllByRole('listitem')

  it('保存できた学びのIDが返されたら、状態行と項目ごとに、保存済みと未保存を分けて示す', async () => {
    const { user } = setup(
      async () => ({
        ok: false,
        message: '1件は保存済みです。残りは保存できません。',
        savedIds: ['learning-a'],
        retryable: false,
      }),
      { requestCandidates: twoCandidates() },
    )
    await approveBoth(user)
    await user.click(saveButton())

    await screen.findByRole('alert')
    expect(statusText()).toContain('2件のうち、1件は保存済み、1件は未保存です')
    const [itemA, itemB] = approvedItems()
    expect(itemA.textContent).toContain('候補Aの内容')
    expect(itemA.textContent).toContain('保存済み')
    expect(itemB.textContent).toContain('候補Bの内容')
    expect(itemB.textContent).toContain('未保存')
    // 再試行しても直らない失敗では、「もう一度、保存できます」と案内しない。
    expect(screen.getByRole('alert').textContent).not.toContain('もう一度、保存できます')
  })

  it('IDが返されないときは、これまでどおり件数だけを示し、項目ごとの表示は出さない', async () => {
    const { user } = setup(async () => ({ ok: false, message: '失敗しました。' }), {
      requestCandidates: twoCandidates(),
    })
    await approveBoth(user)
    await user.click(saveButton())

    const alert = await screen.findByRole('alert')
    expect(statusText()).toContain('保存に失敗しました（承認済みの学び2件は未保存です）')
    for (const item of approvedItems()) expect(item.textContent).not.toMatch(/— (保存済み|未保存)/)
    expect(alert.textContent).toContain('もう一度、保存できます')
  })

  it('承認済みの内容を変えたら、失敗の時点の項目ごとの表示は消える', async () => {
    const { user } = setup(async () => ({ ok: false, message: '失敗', savedIds: ['learning-a'] }), {
      requestCandidates: twoCandidates(),
    })
    await approveBoth(user)
    await user.click(saveButton())
    await screen.findByRole('alert')

    await user.type(screen.getAllByLabelText('学びの内容')[0], '（編集）')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.body.textContent).not.toMatch(/— (保存済み|未保存)/)
  })

  it('結果不明の学びは、保存済み・未保存と分けて示し、確認してから保存するよう案内する', async () => {
    const { user, saveMock } = setup(
      async () => ({
        ok: false,
        message: '1件は保存済みです。通信に失敗しました。',
        savedIds: ['learning-a'],
        unknownIds: ['learning-b'],
      }),
      { requestCandidates: threeCandidates() },
    )
    await approveAll(user, 3)
    await user.click(saveButton())

    const alert = await screen.findByRole('alert')
    expect(statusText()).toContain('3件のうち、1件は保存済み、1件は結果不明、1件は未保存です')
    const [itemA, itemB, itemC] = approvedItems(3)
    expect(itemA.textContent).toContain('— 保存済み')
    expect(itemB.textContent).toContain('— 結果不明')
    expect(itemC.textContent).toContain('— 未保存')
    // 結果不明の学びは、保存されている場合があるので、自動では再送しないことと、確認の手順を伝える。
    expect(alert.textContent).toContain('結果不明の学びは、保存されている場合があります')
    expect(alert.textContent).toContain('自動では再送しません')
    expect(alert.textContent).not.toContain('もう一度、保存できます')
    expect(
      screen.getByRole('button', { name: '保存済みか確認して、もう一度、保存する' }),
    ).toBeTruthy()
    // 利用者が押すまで、自動では再送しない。
    expect(saveMock).toHaveBeenCalledTimes(1)
  })

  it('保存済みのIDが無く、結果不明だけが返されたときも、項目ごとに示す', async () => {
    const { user } = setup(
      async () => ({ ok: false, message: '通信に失敗しました。', unknownIds: ['learning-a'] }),
      { requestCandidates: twoCandidates() },
    )
    await approveBoth(user)
    await user.click(saveButton())

    await screen.findByRole('alert')
    expect(statusText()).toContain('2件のうち、1件は結果不明、1件は未保存です')
    const [itemA, itemB] = approvedItems()
    expect(itemA.textContent).toContain('— 結果不明')
    expect(itemB.textContent).toContain('— 未保存')
  })

  it('全件が結果不明のときの状態行', async () => {
    const { user } = setup(
      async () => ({
        ok: false,
        message: '通信に失敗しました。',
        unknownIds: ['learning-a', 'learning-b'],
      }),
      { requestCandidates: twoCandidates() },
    )
    await approveBoth(user)
    await user.click(saveButton())

    await screen.findByRole('alert')
    expect(statusText()).toContain('2件のうち、2件は結果不明です')
  })

  it('結果不明のあと、保存し直して成功すれば保存済みになる（確認してから、利用者の操作で）', async () => {
    let calls = 0
    const { user, saveMock } = setup(
      async () => {
        calls += 1
        return calls === 1
          ? { ok: false, message: '通信に失敗しました。', unknownIds: ['learning-a'] }
          : { ok: true }
      },
      { requestCandidates: twoCandidates() },
    )
    await approveBoth(user)
    await user.click(saveButton())
    await screen.findByRole('alert')

    await user.click(screen.getByRole('button', { name: '保存済みか確認して、もう一度、保存する' }))

    await waitFor(() => expect(statusText()).toContain('保存済み（承認済みの学び2件）'))
    expect(saveMock).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('結果不明')
  })

  it('結果不明の後に承認済み内容を編集しても、前回の結果不明を確認できる', async () => {
    const { user } = setup(
      async () => ({ ok: false, message: '失敗', unknownIds: ['learning-a'] }),
      { requestCandidates: twoCandidates() },
    )
    await approveBoth(user)
    await user.click(saveButton())
    await screen.findByRole('alert')

    await user.type(screen.getAllByLabelText('学びの内容')[0], '（編集）')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('前回の保存結果が未確認の学びが1件あります')
    expect(alert.textContent).toContain('候補Aの内容')
    expect(document.body.textContent).not.toContain('— 結果不明')
  })

  it('保存中に別の候補を却下しても、送信済みの結果不明は現在の下書きに置き換わらず、確認できる', async () => {
    const pending = deferred<SaveResult>()
    const { user } = setup(() => pending.promise, { requestCandidates: twoCandidates() })
    await approveBoth(user)
    await user.click(saveButton())

    // 保存の応答を待つ間に、送信に含まれていない操作として、別の候補を却下する。
    await user.click(screen.getAllByRole('button', { name: '却下する' })[1])
    await act(async () =>
      pending.resolve({ ok: false, message: '通信に失敗しました。', unknownIds: ['learning-a'] }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('前回の保存結果が未確認の学びが1件あります')
    expect(alert.textContent).toContain('候補Aの内容')
  })

  it('保存中に別の候補の内容を編集しても、送信済みの結果不明を失わない', async () => {
    const pending = deferred<SaveResult>()
    const { user } = setup(() => pending.promise, { requestCandidates: twoCandidates() })
    await approveBoth(user)
    await user.click(saveButton())

    await user.type(screen.getAllByLabelText('学びの内容')[1], '（編集）')
    await act(async () =>
      pending.resolve({ ok: false, message: '通信に失敗しました。', unknownIds: ['learning-a'] }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('前回の保存結果が未確認の学びが1件あります')
    expect(alert.textContent).toContain('候補Aの内容')
  })

  it('認証状態を確認できない間は保存ボタンを無効にし、保存処理も始めない', async () => {
    const { user, saveMock } = setup(async () => ({ ok: true }), {
      canSave: false,
      requestCandidates: twoCandidates(),
    })
    await approveBoth(user)

    const button = screen.getByRole('button', { name: '認証を確認中…' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await user.click(button)
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('いまの承認済みに無い学びの結果不明は、数えない', async () => {
    const { user } = setup(
      async () => ({
        ok: false,
        message: '失敗',
        savedIds: ['learning-a'],
        unknownIds: ['learning-not-in-view'],
      }),
      { requestCandidates: twoCandidates() },
    )
    await approveBoth(user)
    await user.click(saveButton())
    await screen.findByRole('alert')

    expect(statusText()).toContain('2件のうち、1件は保存済み、1件は未保存です')
    expect(statusText()).not.toContain('結果不明')
  })
})

describe('LearningReview: 二重送信と競合', () => {
  it('保存中に続けて押しても、保存は1回だけ呼ぶ', async () => {
    const pending = deferred<SaveResult>()
    const { saveMock, user } = setup(() => pending.promise)
    await generateAndApprove(user)

    const button = saveButton()
    await user.click(button)
    await user.click(button)
    await user.click(button)

    expect(saveMock).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ ok: true }))
  })

  it('保存中に認証確認へ戻ったら中断し、結果が届くまでは二重送信を防いで結果を保持する', async () => {
    const pending = deferred<SaveResult>()
    const { saveMock, user, rerender } = setup(() => pending.promise)
    await generateAndApprove(user)
    await user.click(saveButton())
    const signal = saveMock.mock.calls[0][1]?.signal

    rerender({ canSave: false })

    expect(signal?.aborted).toBe(true)
    expect(statusText()).toContain('保存中')
    expect(
      screen.getByRole('button', { name: '認証を確認中…' }).getAttribute('aria-disabled'),
    ).toBe('true')
    rerender({ canSave: true })
    await user.click(saveButton())
    expect(saveMock).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ ok: true }))
    expect(statusText()).toContain('保存済み')
  })

  it('保存したあとに承認済みの内容が変わったら、未保存の変更ありに戻る', async () => {
    const { user } = setup()
    await generateAndApprove(user)
    await user.click(saveButton())
    await waitFor(() => expect(statusText()).toContain('保存済み'))

    await user.type(screen.getByLabelText('学びの内容'), 'あ')

    expect(statusText()).toContain('未保存')
    expect(statusText()).not.toContain('保存済み')
    expect(liveRegion().textContent).toContain('未保存の変更があります')
  })

  it('保存したあとに却下すると、保存済みとは表示せず、以前の保存は変わらないと案内する', async () => {
    const { user } = setup()
    await generateAndApprove(user)
    await user.click(saveButton())
    await waitFor(() => expect(statusText()).toContain('保存済み'))

    await user.click(screen.getByRole('button', { name: '却下する' }))

    expect(statusText()).not.toContain('保存済み')
    expect(statusText()).toContain('未保存の変更あり')
    expect(statusText()).toContain('以前に保存した内容は、まだ変わっていません')
  })

  it('保存の間に承認済みの内容が変わったら、成功しても、未保存の変更ありと示す', async () => {
    const pending = deferred<SaveResult>()
    const { user } = setup(() => pending.promise)
    await generateAndApprove(user)
    await user.click(saveButton())

    await user.type(screen.getByLabelText('学びの内容'), 'あ')
    await act(async () => pending.resolve({ ok: true }))

    expect(statusText()).toContain('未保存')
    expect(statusText()).not.toContain('保存済み')
  })

  it('旅程が切り替わったら、進行中の保存を中止し、古い応答（成功）を採用しない', async () => {
    const pending = deferred<SaveResult>()
    const { saveMock, user, rerender } = setup(() => pending.promise)
    await generateAndApprove(user)
    await user.click(saveButton())
    const signal = saveMock.mock.calls[0][1]?.signal

    rerender({ trip: { ...sampleTrip, id: 'trip-other' } })

    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve({ ok: true }))
    expect(statusText()).not.toContain('保存済み')
    expect(statusText()).not.toContain('保存中')
    // 新しい旅程は、保存の履歴を持たない（古い成功を、新しい旅程の保存として扱わない）。
    expect(statusText()).toContain('保存できる承認済みの学びはまだありません')
    expect(liveRegion().textContent).not.toContain('保存しました')
    expect(screen.getByRole('heading', { name: '承認済みの学び（0件）' })).toBeTruthy()
  })

  it('旅程が切り替わったあとに届いた、古い失敗も採用しない', async () => {
    const pending = deferred<SaveResult>()
    const { user, rerender } = setup(() => pending.promise)
    await generateAndApprove(user)
    await user.click(saveButton())

    rerender({ trip: { ...sampleTrip, id: 'trip-other' } })
    await act(async () => pending.resolve({ ok: false, message: '古い失敗' }))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/古い失敗/)).toBeNull()
  })

  it('旅程が切り替わったあとは、新しい旅程の保存を、すぐ始められる（古い保存の鍵が残らない）', async () => {
    const pending = deferred<SaveResult>()
    const { saveMock, user, rerender } = setup(() => pending.promise)
    await generateAndApprove(user)
    await user.click(saveButton())

    rerender({ trip: { ...sampleTrip, id: 'trip-other' } })
    await user.click(saveButton())

    // 承認済みが0件なので、案内だけが出る（保存中のまま固まらない）。
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveNotice()?.textContent).toContain('承認してから、保存してください')
  })

  it('画面を閉じたら、進行中の保存を中止する', async () => {
    const pending = deferred<SaveResult>()
    const { saveMock, user, view } = setup(() => pending.promise)
    await generateAndApprove(user)
    await user.click(saveButton())
    const signal = saveMock.mock.calls[0][1]?.signal

    view.unmount()

    expect(signal?.aborted).toBe(true)
    // 閉じたあとに応答が届いても、エラーにならない。
    await act(async () => pending.resolve({ ok: true }))
  })
})

describe('LearningReview: 通知の読み上げ（常設のライブリージョン）', () => {
  it('ライブリージョンは画面に1つだけで、保存の状態の通知も、そこへ入る', async () => {
    const { user, view } = setup()
    await generateAndApprove(user)
    await user.click(saveButton())
    await waitFor(() => expect(statusText()).toContain('保存済み'))

    expect(view.container.querySelectorAll('[aria-live]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(liveRegion().textContent).toContain('保存しました')
  })

  it('ライブリージョンは、描画の最初から存在し、中身のテキストが更新される', async () => {
    const { user } = setup()
    const region = liveRegion()
    expect(region.textContent?.trim()).toBe('')

    await generateAndApprove(user)
    await user.click(saveButton())

    await waitFor(() => expect(region.textContent).toContain('保存しました'))
    // 同じ要素のまま、内容が更新されている（要素を挿入し直していない）。
    expect(liveRegion()).toBe(region)
  })

  it('入力不備の案内も、常設のライブリージョンで読み上げ、カードの案内には role を付けない', async () => {
    const { user, view } = setup()
    await generateAndApprove(user)
    await user.clear(screen.getByLabelText('学びの内容'))
    await user.click(approveButton())

    expect(liveRegion().textContent).toContain('学びの内容を入力してください')
    const card = screen.getByLabelText('学びの内容').closest('li')!
    expect(card.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[aria-live]')).toHaveLength(1)
    // 承認ボタンは、無効化しない。
    expect(approveButton().getAttribute('aria-disabled')).toBeNull()
  })

  it('同じ入力不備のまま、もう一度、承認を押したら、読み上げ直す', async () => {
    const { user } = setup()
    await generateAndApprove(user)
    await user.clear(screen.getByLabelText('学びの内容'))
    await user.click(approveButton())
    const first = liveRegion().textContent

    await user.click(approveButton())

    expect(liveRegion().textContent).toContain('学びの内容を入力してください')
    expect(liveRegion().textContent).not.toBe(first)
  })

  it('保存の失敗は role="alert" で伝え、ライブリージョン（status）とは使い分ける', async () => {
    const { user } = setup(async () => ({ ok: false, message: '失敗' }))
    await generateAndApprove(user)
    await user.click(saveButton())

    const alert = await screen.findByRole('alert')
    expect(liveRegion().contains(alert)).toBe(false)
    expect(liveRegion().textContent).not.toContain('保存できませんでした')
  })
})
