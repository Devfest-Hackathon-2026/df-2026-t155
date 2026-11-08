// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LearningSchema, type Learning, type Trip } from '@/domain'
import { sampleRevision, sampleTrip } from '@/domain/samples'
import { ClientAuthError } from '@/lib/auth/client'
import type { VersionedLearning } from '@/server/persistence/contracts'

import { fakeAuth } from '../../../tests/helpers/fake-auth-client'
import {
  createFakeBackend,
  errorResponse,
  isApprove,
  isListLearnings,
  jsonResponse,
  type BackendCall,
} from '../../../tests/helpers/fake-persistence-backend'
import { ReflectionFlow } from './reflection-flow'

// 認証（Firebase）だけを差し替える。セッションスコープ・LearningReview・api-client・保存ポートは、本物をつないで確かめる。
vi.mock('@/lib/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/client')>()
  const { fakeAuth: fake } = await import('../../../tests/helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

const A = 'user-a'
const B = 'user-b'

// ---- 共通の準備 ----

const candidate = (id: string, content: string, scope: Learning['scope']): Learning =>
  LearningSchema.parse({
    id,
    sourceTripId: sampleTrip.id,
    category: 'preference',
    content,
    scope,
    approval: { status: 'pending' },
  })

const first = candidate('learning-first', '昼食後は休憩を長めに取る', { kind: 'all_trips' })
const second = candidate('learning-second', '朝の移動は短くする', {
  kind: 'region',
  region: sampleTrip.region,
})
const otherTrip: Trip = { ...sampleTrip, id: 'trip-other', region: '奈良市（別の旅行）' }
// 別のアカウントBの旅行。IDはAの旅行と同じで、地域だけが違う。
const tripOfB: Trip = { ...sampleTrip, region: '大阪市（Bのアカウント）' }

const savedEntry = (learning: Learning, version = 1): VersionedLearning => ({
  version,
  learning: {
    id: learning.id,
    sourceTripId: learning.sourceTripId,
    category: learning.category,
    content: learning.content,
    scope: learning.scope,
    approval: { status: 'approved', decidedAt: '2026-11-01T18:00:00+09:00' },
  },
})

const accountA = { trips: [sampleTrip], revisions: [sampleRevision] }

function setupBackend(
  accounts: Parameters<typeof createFakeBackend>[0] = { [A]: accountA },
  candidates: Learning[] = [first, second],
) {
  const backend = createFakeBackend(accounts, { candidates })
  vi.stubGlobal('fetch', backend.fetchFn)
  return backend
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

type User = ReturnType<typeof userEvent.setup>

async function openTrip(user: User, label: string | RegExp = /振り返る/) {
  await user.click(await screen.findByRole('button', { name: label }))
  await screen.findByRole('button', { name: '学びの候補を作る' })
}

async function makeCandidates(user: User) {
  await user.type(screen.getByLabelText(/感想・変更した理由/), '昼食後は休みたかった')
  await user.click(screen.getByRole('button', { name: '学びの候補を作る' }))
  await screen.findByRole('heading', { name: /学びの候補（/ })
}

async function approveAll(user: User) {
  for (;;) {
    const buttons = screen.queryAllByRole('button', { name: '承認する' })
    if (buttons.length === 0) return
    await user.click(buttons[0])
  }
}

// 候補を作って承認し、保存の直前まで進める。
async function prepare(user: User, label?: string | RegExp) {
  await openTrip(user, label)
  await makeCandidates(user)
  await approveAll(user)
}

const saveButton = () =>
  screen.getByRole('button', { name: /保存する|保存しています|保存済みか確認して/ })
const saveStatus = () => screen.getByText(/^保存の状態/).parentElement?.textContent ?? ''
const savedSection = () =>
  screen.getByRole('heading', { name: '保存済みの学び' }).closest('section') as HTMLElement
const approvedList = (count: number) =>
  screen.getByRole('heading', { name: new RegExp('承認済みの学び（' + count + '件）') })
    .parentElement as HTMLElement
const itemOf = (list: HTMLElement, learning: Learning) =>
  within(list)
    .getAllByRole('listitem')
    .find((item) => item.textContent?.includes(learning.content))?.textContent ?? ''
const approvePosts = (backend: ReturnType<typeof setupBackend>, uid?: string) =>
  backend.approveCalls().filter((call) => uid === undefined || call.uid === uid)

beforeEach(() => {
  fakeAuth.reset()
  // 復元（initializeAnonymousSession）で得られるUID。
  fakeAuth.state.restoredUid = A
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ReflectionFlow：実際の画面・保存ポート・APIクライアントをつないだ動作', () => {
  it('承認→保存→保存済みの一覧に出る。保存後は、一覧を取り直した内容を表示する', async () => {
    const backend = setupBackend()
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user)
    await waitFor(() => {
      expect(within(savedSection()).getByText('保存済みの学びはありません。')).toBeTruthy()
    })
    // 保存済みの変更履歴を、学びの確認画面へ渡している。
    const history = screen.getByRole('heading', { name: '変更の履歴' }).parentElement as HTMLElement
    expect(within(history).getByText(sampleRevision.diff.after.name)).toBeTruthy()
    expect(within(history).queryByText('この旅程の変更履歴はありません。')).toBeNull()
    await makeCandidates(user)
    await approveAll(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(saveStatus()).toContain('保存済み（承認済みの学び2件）')
    })
    // 保存先へ、2件の承認が1件ずつ、本人（A）のトークンで送られている。
    expect(approvePosts(backend).map((call) => call.path)).toEqual([
      '/api/learnings/learning-first/approve',
      '/api/learnings/learning-second/approve',
    ])
    expect(backend.calls.every((call) => call.uid === A || call.uid === undefined)).toBe(true)
    // 保存後に一覧を取り直し、保存済みの学びとして表示する（内部IDではなく、旅行の地域と日付で示す）。
    const section = savedSection()
    await waitFor(() => {
      expect(within(section).getByText(first.content)).toBeTruthy()
    })
    expect(within(section).getByText(second.content)).toBeTruthy()
    expect(within(section).queryByText('保存済みの学びはありません。')).toBeNull()
    expect(within(section).getAllByText(/^元の旅行：/)[0].textContent).toBe(
      '元の旅行：' + sampleTrip.region + '（' + sampleTrip.date + '）',
    )
    expect(document.body.textContent).not.toContain('Firestore')
    expect(document.body.textContent).not.toContain(sampleTrip.id)
  })

  it('一部だけ保存できて失敗したとき、警告・状態行・保存済みの一覧が同じ事実を示す', async () => {
    const backend = setupBackend()
    backend.intercept(isApprove(second.id), () =>
      errorResponse(409, 'storage_limit_reached', 'サーバーの文言'),
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user)
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    // (a) 警告：1件は保存済み。上限のため残りは保存できず、再読み込みを案内しない。
    expect(alert.textContent).toContain('1件は保存済みです')
    expect(alert.textContent).toContain('上限に達しているため')
    expect(alert.textContent).toContain('結果は変わりません')
    expect(alert.textContent).not.toContain('再読み込み')
    expect(alert.textContent).not.toContain('もう一度、保存できます')
    // (b) 状態行：保存済みと未保存を分けて示す。
    expect(saveStatus()).toContain('2件のうち、1件は保存済み、1件は未保存です')
    // 承認済みの項目ごとの結果。
    const list = approvedList(2)
    expect(itemOf(list, first)).toContain('保存済み')
    expect(itemOf(list, second)).toContain('未保存')
    // (c) 保存済みの一覧：実際に保存できた1件が出る（「ありません」と矛盾しない）。
    const section = savedSection()
    await waitFor(() => {
      expect(within(section).getByText(first.content)).toBeTruthy()
    })
    expect(within(section).queryByText(second.content)).toBeNull()
    expect(within(section).queryByText('保存済みの学びはありません。')).toBeNull()
  })

  it('版の食い違いのときだけ「再読み込み」を案内し、消えるものも正直に伝える', async () => {
    const backend = setupBackend({ [A]: accountA }, [first])
    backend.intercept(isApprove(first.id), () =>
      errorResponse(409, 'version_conflict', 'サーバーの文言'),
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user)
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    expect(alert.textContent).toContain('再読み込み')
    expect(alert.textContent).toContain('承認と入力した内容は消えます')
    expect(alert.textContent).not.toContain('もう一度、保存できます')
  })

  it('送信前に止まった失敗（保存機能の停止）は、結果不明ではなく未保存で、再試行できるものとして案内する', async () => {
    const backend = setupBackend({ [A]: accountA }, [first])
    backend.intercept(isApprove(first.id), () =>
      errorResponse(503, 'persistence_disabled', 'サーバーの文言'),
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user)
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    expect(alert.textContent).toContain('保存機能は現在利用できません')
    expect(alert.textContent).toContain('もう一度、保存できます')
    expect(alert.textContent).not.toContain('結果不明')
    expect(alert.textContent).not.toContain('サーバーの文言')
    expect(saveStatus()).toContain('1件は未保存です')
  })
})

describe('ReflectionFlow：一部だけ保存された・結果が不明なとき', () => {
  it('2件中1件が保存された後の通信断：保存済み／結果不明を分けて示し、自動では再送しない', async () => {
    const backend = setupBackend()
    backend.intercept(isApprove(second.id), () => {
      throw new TypeError('offline')
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user)
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    expect(alert.textContent).toContain('1件は保存済みです')
    expect(alert.textContent).toContain('1件は保存できたかどうか確認できません（結果不明）')
    expect(alert.textContent).toContain('自動では再送しません')
    expect(alert.textContent).not.toContain('もう一度、保存できます')
    expect(saveStatus()).toContain('2件のうち、1件は保存済み、1件は結果不明です')
    const list = approvedList(2)
    expect(itemOf(list, first)).toContain('— 保存済み')
    expect(itemOf(list, second)).toContain('— 結果不明')
    // 保存できた1件は、保存済みの一覧で確認できる。
    await waitFor(() => {
      expect(within(savedSection()).getByText(first.content)).toBeTruthy()
    })
    expect(within(savedSection()).queryByText(second.content)).toBeNull()
    // 待っても、自動では再送しない。
    await flush()
    expect(approvePosts(backend).map((call) => call.path)).toEqual([
      '/api/learnings/learning-first/approve',
      '/api/learnings/learning-second/approve',
    ])
  })

  it('結果不明のあと、利用者が確認してから保存し直すと、未保存だった学びだけが保存される', async () => {
    const backend = setupBackend()
    backend.intercept(isApprove(second.id), () => {
      throw new TypeError('offline')
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user)
    await user.click(saveButton())
    await screen.findByText(/^保存できませんでした。/)

    await user.click(screen.getByRole('button', { name: '保存済みか確認して、もう一度、保存する' }))

    await waitFor(() => expect(saveStatus()).toContain('保存済み（承認済みの学び2件）'))
    // 1件目は再送せず、2件目は（前回は届いていなかったので）もう一度送る。
    expect(approvePosts(backend).map((call) => call.path)).toEqual([
      '/api/learnings/learning-first/approve',
      '/api/learnings/learning-second/approve',
      '/api/learnings/learning-second/approve',
    ])
    expect(backend.account(A).learnings.size).toBe(2)
  })

  it('サーバー確定後に応答だけを失ったとき、取り直した一覧で保存済みと照合でき、再送しない', async () => {
    const backend = setupBackend()
    backend.intercept(isApprove(second.id), ({ proceed }) => {
      proceed()
      throw new TypeError('offline')
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user)
    await user.click(saveButton())

    await waitFor(() => expect(saveStatus()).toContain('保存済み（承認済みの学び2件）'))
    expect(screen.queryByText(/結果不明/)).toBeNull()
    expect(approvePosts(backend)).toHaveLength(2)
    await waitFor(() => {
      expect(within(savedSection()).getByText(second.content)).toBeTruthy()
    })
  })

  it('確定後の応答喪失で取り直しも失敗：結果不明のまま。確認して保存し直しても、再送しない', async () => {
    const backend = setupBackend({ [A]: accountA }, [first])
    backend.intercept(isApprove(first.id), ({ proceed }) => {
      proceed()
      throw new TypeError('offline')
    })
    // 保存の後の取り直し（保存の間の2回目の一覧取得）が失敗する。
    const lists = { armed: false, count: 0 }
    backend.intercept(
      (call) => lists.armed && isListLearnings(call) && ++lists.count === 2,
      () => {
        throw new TypeError('offline')
      },
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user)
    lists.armed = true
    await user.click(saveButton())

    await screen.findByText(/^保存できませんでした。/)
    expect(saveStatus()).toContain('1件は結果不明です')
    // 取り直した保存済みの一覧には、確定していた学びが出ている（利用者が自分で確かめられる）。
    await waitFor(() => {
      expect(within(savedSection()).getByText(first.content)).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: '保存済みか確認して、もう一度、保存する' }))

    await waitFor(() => expect(saveStatus()).toContain('保存済み（承認済みの学び1件）'))
    expect(approvePosts(backend)).toHaveLength(1)
  })
})

describe('ReflectionFlow：保存結果と現在の承認状態', () => {
  it('事前の一覧で保存済みだった学びが、保存の間に撤回されたら、保存済みと表示しない', async () => {
    const backend = setupBackend({ [A]: { ...accountA, learnings: [savedEntry(first, 2)] } })
    // 2件目の保存の間に、別の端末が1件目の承認を撤回する。
    backend.intercept(isApprove(second.id), ({ proceed }) => {
      const response = proceed()
      backend.account(A).learnings.delete(first.id)
      return response
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user)
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    expect(alert.textContent).toContain('変更または撤回')
    expect(saveStatus()).toContain('2件のうち、1件は保存済み、1件は未保存です')
    const list = approvedList(2)
    expect(itemOf(list, first)).toContain('— 未保存')
    expect(itemOf(list, second)).toContain('— 保存済み')
    await waitFor(() => {
      expect(within(savedSection()).queryByText(first.content)).toBeNull()
      expect(within(savedSection()).getByText(second.content)).toBeTruthy()
    })
  })

  it('保存先が送った内容と違う応答を返したとき、保存済みとは表示しない', async () => {
    const backend = setupBackend({ [A]: accountA }, [first])
    backend.intercept(isApprove(first.id), () =>
      jsonResponse({
        version: 1,
        learning: { ...savedEntry(first).learning, content: '別の内容' },
      }),
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user)
    await user.click(saveButton())

    await screen.findByText(/^保存できませんでした。/)
    expect(saveStatus()).not.toContain('保存済み（')
    expect(saveStatus()).toContain('1件は結果不明です')
    expect(itemOf(approvedList(1), first)).toContain('— 結果不明')
  })

  it('一覧の返却件数と実際の件数が食い違うとき、保存済みの一覧を成功扱いにせず、書き込みもしない', async () => {
    const backend = setupBackend({ [A]: { ...accountA, learnings: [savedEntry(second, 1)] } }, [
      first,
    ])
    backend.intercept(
      isListLearnings,
      ({ proceed }) =>
        proceed()
          .clone()
          .json()
          .then((body: { learnings: unknown[] }) =>
            jsonResponse({
              ...body,
              listInfo: {
                returned: body.learnings.length + 1,
                skippedInvalid: 0,
                truncated: false,
              },
            }),
          ),
      { always: true },
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user)
    await waitFor(() => {
      expect(within(savedSection()).getByRole('alert').textContent).toContain(
        '保存済みの学びをすべて確認できませんでした',
      )
    })
    expect(within(savedSection()).queryByText(second.content)).toBeNull()
    await makeCandidates(user)
    await approveAll(user)
    await user.click(saveButton())
    await screen.findByText(/^保存できませんでした。/)
    expect(approvePosts(backend)).toHaveLength(0)
  })

  it('旅行の一覧の件数が食い違うときは、警告を示す', async () => {
    const backend = setupBackend()
    backend.intercept(
      (call) => call.path === '/api/trips',
      ({ proceed }) =>
        proceed()
          .clone()
          .json()
          .then((body: { trips: unknown[] }) =>
            jsonResponse({
              ...body,
              listInfo: { returned: body.trips.length + 1, skippedInvalid: 0, truncated: false },
            }),
          ),
    )
    render(<ReflectionFlow />)

    expect((await screen.findByRole('alert')).textContent).toContain('一部の旅程を表示できません')
  })

  it('変更履歴の件数が食い違うときは、学びの候補の画面を開始しない', async () => {
    const backend = setupBackend()
    backend.intercept(
      (call) => call.path.endsWith('/revisions'),
      ({ proceed }) =>
        proceed()
          .clone()
          .json()
          .then((body: { revisions: unknown[] }) =>
            jsonResponse({
              ...body,
              listInfo: {
                returned: body.revisions.length + 1,
                skippedInvalid: 0,
                truncated: false,
              },
            }),
          ),
    )
    render(<ReflectionFlow initialTripId={sampleTrip.id} />)

    expect((await screen.findByText(/すべて確認できませんでした/)).textContent).toBeTruthy()
    expect(screen.queryByRole('button', { name: '学びの候補を作る' })).toBeNull()
  })

  it('別端末が保存の間に版を進めたとき、上書きせず、再読み込みの案内を示す', async () => {
    const backend = setupBackend({ [A]: accountA }, [first])
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user)
    await user.click(saveButton())
    await waitFor(() => expect(saveStatus()).toContain('保存済み（承認済みの学び1件）'))

    // 保存した内容を直して再承認する間に、別の端末が同じ学びを更新する。
    await user.type(screen.getByLabelText('学びの内容'), '（追記）')
    await user.click(screen.getByRole('button', { name: /承認する/ }))
    backend.intercept(isApprove(first.id), () => {
      backend.account(A).learnings.set(first.id, {
        version: 2,
        learning: { ...savedEntry(first).learning, content: '別端末で更新した内容' },
      })
    })
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    expect(alert.textContent).toContain('再読み込み')
    expect(alert.textContent).toContain('承認と入力した内容は消えます')
    expect(backend.account(A).learnings.get(first.id)?.learning.content).toBe(
      '別端末で更新した内容',
    )
  })

  it('画面上の編集・却下は保存済みの承認を取り消さないこと、撤回の操作が無いことを示す', async () => {
    const backend = setupBackend({ [A]: { ...accountA, learnings: [savedEntry(first, 1)] } }, [
      first,
    ])
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user)
    await waitFor(() => expect(saveStatus()).toContain('未保存の変更あり'))
    const before = backend.calls.length

    await user.click(screen.getByRole('button', { name: '却下する' }))

    // 却下は画面だけの操作。保存先へは何も送らず、保存先の承認はそのまま。
    expect(backend.calls.length).toBe(before)
    expect(backend.account(A).learnings.get(first.id)).toMatchObject({ version: 1 })
    expect(document.getElementById('saved-learnings-note')?.textContent).toContain(
      '編集・却下しても、この一覧の承認は取り消されません',
    )
    expect(document.getElementById('saved-learnings-note')?.textContent).toContain(
      '撤回する操作は、まだ提供していません',
    )
    expect(document.getElementById('learning-saved-approval-note')?.textContent).toContain(
      '保存済みの承認を取り消しません',
    )
    expect(within(savedSection()).getByText(first.content)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /撤回/ })).toBeNull()
  })
})

describe('ReflectionFlow：取得・編集・保存を同じ認証セッションに結び付ける', () => {
  const twoAccounts = () =>
    setupBackend({
      [A]: { ...accountA, learnings: [savedEntry({ ...first, content: 'Aの保存済みの学び' }, 3)] },
      [B]: { trips: [tripOfB], revisions: [], learnings: [] },
    })

  it('Aのデータを取得した後にBへセッションが変わったら、Aの旅行・候補・承認・保存済みは見えなくなる', async () => {
    const backend = twoAccounts()
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user, /京都市/)
    await waitFor(() => {
      expect(within(savedSection()).getByText('Aの保存済みの学び')).toBeTruthy()
    })
    expect(screen.getByRole('heading', { name: /承認済みの学び（2件）/ })).toBeTruthy()
    const before = backend.calls.length

    await act(async () => {
      fakeAuth.signInAs(B)
    })

    await screen.findByRole('button', { name: /大阪市/ })
    expect(screen.queryByRole('button', { name: /京都市/ })).toBeNull()
    // Aの履歴・候補・承認・保存済みの一覧・入力欄は、どこにも残っていない。
    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /承認済みの学び/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '学びの候補を作る' })).toBeNull()
    expect(document.body.textContent).not.toContain('Aの保存済みの学び')
    expect(screen.queryByDisplayValue(first.content)).toBeNull()
    // 利用者には、セッションが変わって破棄したことを伝える。
    expect(screen.getByText(/認証セッションが変わったため/).textContent).toContain('破棄')
    // 切り替え後の通信は、すべてBのトークン。Aの旅程を、Bのトークンで取りに行かない。
    const after = backend.calls.slice(before)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((call) => call.uid === B)).toBe(true)
    expect(after.some((call) => call.path.includes(sampleTrip.id))).toBe(false)
  })

  it('AとBに同じTrip ID・同じLearning IDがあっても、保存済みの一覧を取り違えない', async () => {
    const backend = setupBackend({
      [A]: { ...accountA, learnings: [savedEntry({ ...first, content: 'Aの学び' }, 3)] },
      [B]: {
        trips: [tripOfB],
        revisions: [],
        learnings: [savedEntry({ ...first, content: 'Bの学び' }, 7)],
      },
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await openTrip(user, /京都市/)
    await waitFor(() => {
      expect(within(savedSection()).getByText('Aの学び')).toBeTruthy()
    })

    await act(async () => {
      fakeAuth.signInAs(B)
    })
    // 同じTrip IDの旅行を、Bの画面で開き直す。
    await openTrip(user, /大阪市/)

    await waitFor(() => {
      expect(within(savedSection()).getByText('Bの学び')).toBeTruthy()
    })
    expect(within(savedSection()).queryByText('Aの学び')).toBeNull()
    expect(backend.account(A).learnings.get(first.id)).toMatchObject({ version: 3 })
  })

  it('同じLearning IDでも、Aで確認した版はBの保存に使わない（Bの保存先の版で送る）', async () => {
    const backend = setupBackend(
      {
        [A]: { ...accountA, learnings: [savedEntry(first, 3)] },
        [B]: { trips: [tripOfB], revisions: [], learnings: [] },
      },
      [first],
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    // Aの画面で、同じ内容を保存し直す（Aの版3を確認する）。
    await prepare(user, /京都市/)
    await user.click(saveButton())
    await waitFor(() => expect(saveStatus()).toContain('保存済み（承認済みの学び1件）'))

    await act(async () => {
      fakeAuth.signInAs(B)
    })
    await prepare(user, /大阪市/)
    await user.click(saveButton())

    await waitFor(() => expect(saveStatus()).toContain('保存済み（承認済みの学び1件）'))
    const post = approvePosts(backend, B)
    expect(post).toHaveLength(1)
    expect(post[0].body).toMatchObject({ expectedVersion: 0 })
    // Aの保存先は、Bの保存の影響を受けない。
    expect(backend.account(A).learnings.get(first.id)).toMatchObject({ version: 3 })
    expect(backend.account(B).learnings.get(first.id)).toMatchObject({ version: 1 })
  })

  it('保存中にUIDが変わっても、残りを送らず、古いセッションの学びを新しいUIDのトークンで保存しない', async () => {
    const backend = setupBackend({
      [A]: accountA,
      [B]: { trips: [tripOfB], revisions: [], learnings: [] },
    })
    const gate = deferred()
    // 1件目の保存は届いたが、応答が返る前に、セッションが切り替わる。
    backend.intercept(isApprove(first.id), async ({ proceed }) => {
      const response = proceed()
      await gate.promise
      return response
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user, /京都市/)
    await user.click(saveButton())
    await waitFor(() => expect(approvePosts(backend)).toHaveLength(1))

    await act(async () => {
      fakeAuth.signInAs(B)
    })
    gate.resolve()
    await flush()

    // 2件目は送られない。Bのトークンでの承認も、1件も無い。
    expect(approvePosts(backend, B)).toHaveLength(0)
    expect(approvePosts(backend)).toHaveLength(1)
    expect(backend.account(B).learnings.size).toBe(0)
    // 画面は、Bのセッションの内容。Aの保存の結果（保存済み・失敗）を、Bの画面に出さない。
    await screen.findByRole('button', { name: /大阪市/ })
    expect(screen.queryByText(/^保存の状態/)).toBeNull()
    expect(screen.queryByText(/^保存できませんでした。/)).toBeNull()
    expect(screen.getByText(/進行中の保存を中止しました/)).toBeTruthy()
  })

  it('取得の応答が、セッションが変わった後に届いても、前のセッションの旅行を表示しない', async () => {
    const backend = twoAccounts()
    const gate = deferred()
    backend.intercept(
      (call) => call.path === '/api/trips' && call.uid === A,
      async ({ proceed }) => {
        const response = proceed()
        await gate.promise
        return response
      },
    )
    render(<ReflectionFlow />)
    await waitFor(() => expect(backend.calls.some((call) => call.uid === A)).toBe(true))

    await act(async () => {
      fakeAuth.signInAs(B)
    })
    await screen.findByRole('button', { name: /大阪市/ })
    gate.resolve()
    await flush()

    expect(screen.queryByRole('button', { name: /京都市/ })).toBeNull()
    expect(screen.getByRole('button', { name: /大阪市/ })).toBeTruthy()
  })

  it('画面への通知より先にFirebase側のUIDだけが変わっても、取得した旅程と履歴を採用しない', async () => {
    const backend = twoAccounts()
    backend.intercept(
      (call) => call.path.endsWith('/revisions'),
      ({ proceed }) => {
        const response = proceed()
        fakeAuth.switchSilently(B)
        return response
      },
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await user.click(await screen.findByRole('button', { name: /京都市/ }))

    const alert = await screen.findByText(/認証セッションが変わりました/)
    expect(alert).toBeTruthy()
    expect(screen.queryByRole('button', { name: '学びの候補を作る' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '変更の履歴' })).toBeNull()
  })

  it('A→B→Aと戻っても、最初のAの画面（候補・承認）は復活しない', async () => {
    twoAccounts()
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user, /京都市/)

    await act(async () => {
      fakeAuth.signInAs(B)
    })
    await screen.findByRole('button', { name: /大阪市/ })
    await act(async () => {
      fakeAuth.signInAs(A)
    })

    await screen.findByRole('button', { name: /京都市/ })
    expect(screen.queryByRole('heading', { name: /承認済みの学び/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
    expect(screen.getByText(/認証セッションが変わったため/)).toBeTruthy()
  })

  it('A→B→Aと戻って旅行を取得し直す間、最初のAで取得した旅行の一覧は表示しない', async () => {
    const backend = twoAccounts()
    render(<ReflectionFlow />)
    await screen.findByRole('button', { name: /京都市/ })
    await act(async () => {
      fakeAuth.signInAs(B)
    })
    await screen.findByRole('button', { name: /大阪市/ })
    // Aに戻った後の旅行の取得は、まだ終わらない。
    const gate = deferred()
    backend.intercept(
      (call) => call.path === '/api/trips' && call.uid === A,
      async ({ proceed }) => {
        const response = proceed()
        await gate.promise
        return response
      },
    )

    await act(async () => {
      fakeAuth.signInAs(A)
    })
    await flush()

    // 最初のAの一覧を再利用せず、取得し直しの間は読み込み中。Bの一覧も出ない。
    expect(screen.queryByRole('button', { name: /京都市/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /大阪市/ })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('確認しています')
    gate.resolve()
    await screen.findByRole('button', { name: /京都市/ })
  })

  it('同じUIDの認証の確認し直し（復元中）では、承認と入力を捨てず、確認できるまで保存できないことを示す', async () => {
    const backend = twoAccounts()
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user, /京都市/)

    await act(async () => {
      fakeAuth.restoring()
    })
    expect(screen.getByRole('heading', { name: /承認済みの学び（2件）/ })).toBeTruthy()
    expect(screen.getByText(/確認できるまで、保存はできません/)).toBeTruthy()
    const savesBefore = backend.approveCalls().length
    const saveButton = screen.getByRole('button', { name: '認証を確認中…' })
    expect(saveButton.getAttribute('aria-disabled')).toBe('true')
    await user.click(saveButton)
    expect(backend.approveCalls()).toHaveLength(savesBefore)

    await act(async () => {
      fakeAuth.notifyCurrent()
    })
    // 同じUIDなので、画面は作り直さない。通知も出さない。
    expect(screen.getByRole('heading', { name: /承認済みの学び（2件）/ })).toBeTruthy()
    expect(screen.queryByText(/確認できるまで、保存はできません/)).toBeNull()
    expect(screen.queryByText(/認証セッションが変わったため/)).toBeNull()
    // 以前の通信のUIDは、変わっていない。
    expect(backend.calls.every((call) => call.uid === A || call.uid === undefined)).toBe(true)
  })

  it('送信後に同じ認証セッションが確認中へ戻っても、中断した保存の結果不明を保持する', async () => {
    const backend = setupBackend()
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user, /京都市/)

    const gate = deferred()
    backend.intercept(isApprove(first.id), async ({ proceed }) => {
      const response = proceed()
      await gate.promise
      return response
    })
    await user.click(saveButton())
    await waitFor(() => expect(backend.approveCalls()).toHaveLength(1))

    await act(async () => {
      fakeAuth.restoring()
    })
    await act(async () => {
      gate.resolve()
    })

    await waitFor(() => expect(saveStatus()).toContain('1件は結果不明'))
    expect(itemOf(approvedList(2), first)).toContain('— 結果不明')
    expect(itemOf(approvedList(2), second)).toContain('— 未保存')
    expect(backend.account(A).learnings.has(first.id)).toBe(true)
    expect(backend.approveCalls()).toHaveLength(1)

    await act(async () => {
      fakeAuth.notifyCurrent()
    })
    expect(saveStatus()).toContain('1件は結果不明')
    expect(
      screen.getByRole('button', { name: '保存済みか確認して、もう一度、保存する' }),
    ).toBeTruthy()
  })

  it('セッションが終了したら、表示中の内容では保存を始めず、匿名アカウントも自動作成しない', async () => {
    const backend = twoAccounts()
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user, /京都市/)

    await act(async () => {
      fakeAuth.endSession()
    })

    const alert = await screen.findByText(/利用可能な認証状態がありません/)
    expect(alert).toBeTruthy()
    expect(screen.getByRole('button', { name: '新しい利用を始める' })).toBeTruthy()
    const before = backend.calls.length
    expect(screen.queryByRole('heading', { name: /承認済みの学び/ })).toBeNull()
    expect(
      screen.queryByRole('button', { name: /保存する|保存しています|保存済みか確認して/ }),
    ).toBeNull()
    expect(approvePosts(backend)).toHaveLength(0)
    expect(backend.calls.length).toBe(before)
    expect(fakeAuth.client.startNewAnonymousSession).not.toHaveBeenCalled()
  })

  it('セッション終了後に同じUIDへ戻っても、前世代の承認内容を再表示しない', async () => {
    setupBackend()
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await prepare(user, /京都市/)
    expect(screen.getByRole('heading', { name: /承認済みの学び（2件）/ })).toBeTruthy()

    await act(async () => {
      fakeAuth.endSession()
      fakeAuth.signInAs(A)
    })

    await screen.findByRole('button', { name: /京都市/ })
    expect(screen.queryByRole('heading', { name: /承認済みの学び/ })).toBeNull()
  })
})

describe('ReflectionFlow：別の旅行へ切り替えるときの確認', () => {
  const twoTrips = () =>
    setupBackend({ [A]: { trips: [sampleTrip, otherTrip], revisions: [sampleRevision] } }, [first])

  it('未保存の承認済みがあるときは、確認するまで切り替えず、残る選択で元に戻れる', async () => {
    const backend = twoTrips()
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user, /京都市/)
    const otherButton = screen.getByRole('button', { name: /奈良市/ })
    await user.click(otherButton)

    const group = screen.getByRole('group', { name: /まだ保存していない承認済みの学び/ })
    expect(group.textContent).toContain('奈良市（別の旅行）')
    expect(document.activeElement).toBe(group)
    // まだ切り替わっていない：履歴の読み込みもなく、確認中の候補と承認も残っている。
    expect(backend.calls.map((call) => call.path)).not.toContain('/api/trips/trip-other')
    expect(screen.getByText(/承認済みの学び（1件）/)).toBeTruthy()

    await user.click(within(group).getByRole('button', { name: 'この旅行に残る' }))
    expect(screen.queryByRole('group', { name: /まだ保存していない/ })).toBeNull()
    expect(document.activeElement).toBe(otherButton)
    expect(screen.getByText(/承認済みの学び（1件）/)).toBeTruthy()
    expect(backend.calls.map((call) => call.path)).not.toContain('/api/trips/trip-other')
  })

  it('保存せずに切り替えると選んだ旅行へ移る。Escで確認だけを閉じられる', async () => {
    const backend = twoTrips()
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await prepare(user, /京都市/)
    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /まだ保存していない/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    await user.click(screen.getByRole('button', { name: '保存せずに切り替える' }))
    await screen.findByRole('button', { name: '学びの候補を作る' })
    expect(backend.calls.map((call) => call.path)).toContain('/api/trips/trip-other')
    expect(screen.getByRole('button', { name: /奈良市/ }).getAttribute('aria-pressed')).toBe('true')
    // 前の旅行の候補・承認は混ざらない。
    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
    expect(screen.getByText('承認した学びはまだありません。')).toBeTruthy()
  })

  it('承認が無いとき、または全件を保存済みのときは、確認なしで切り替える', async () => {
    const backend = twoTrips()
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    // 承認が無い。
    await openTrip(user, /京都市/)
    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    expect(screen.queryByRole('group', { name: /まだ保存していない/ })).toBeNull()
    await waitFor(() => {
      expect(backend.calls.map((call) => call.path)).toContain('/api/trips/trip-other')
    })
    await screen.findByRole('button', { name: '学びの候補を作る' })

    // 承認して、保存まで終えた。
    await user.click(screen.getByRole('button', { name: /京都市/ }))
    await screen.findByRole('button', { name: '学びの候補を作る' })
    await makeCandidates(user)
    await approveAll(user)
    await user.click(saveButton())
    await waitFor(() => {
      expect(saveStatus()).toContain('保存済み（承認済みの学び1件）')
    })
    await waitFor(() => {
      expect(within(savedSection()).getByText(first.content)).toBeTruthy()
    })
    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    expect(screen.queryByRole('group', { name: /まだ保存していない/ })).toBeNull()
  })
})

describe('ReflectionFlow：取得の順序（遅れて届いた古い応答）', () => {
  it('保存済みの学びの一覧は、遅れて届いた古い応答で新しい一覧を上書きしない', async () => {
    const backend = setupBackend()
    const gate = deferred()
    // 最初の一覧の取得だけ、その時点の（空の）内容を、あとから返す。
    backend.intercept(isListLearnings, async ({ proceed }) => {
      const stale = proceed()
      await gate.promise
      return stale
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user)
    // 新しい学びが保存された後に、読み込み直す（新しい一覧が先に届く）。
    backend.account(A).learnings.set(first.id, savedEntry(first, 1))
    await user.click(screen.getByRole('button', { name: '保存済みの学びを読み込み直す' }))
    await waitFor(() => {
      expect(within(savedSection()).getByText(first.content)).toBeTruthy()
    })
    // そのあとで、古い（空の）応答が届いても、表示は変わらない。
    await act(async () => {
      gate.resolve()
    })
    await flush()
    expect(within(savedSection()).getByText(first.content)).toBeTruthy()
    expect(within(savedSection()).queryByText('保存済みの学びはありません。')).toBeNull()
  })

  it('旅行を選び直したとき、遅れて届いた前の旅行の履歴で、いまの旅行の画面を上書きしない', async () => {
    const backend = setupBackend({
      [A]: { trips: [sampleTrip, otherTrip], revisions: [sampleRevision] },
    })
    const gate = deferred()
    backend.intercept(
      (call) => call.path === '/api/trips/' + sampleTrip.id,
      async ({ proceed }) => {
        const response = proceed()
        await gate.promise
        return response
      },
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await user.click(await screen.findByRole('button', { name: /京都市/ }))
    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    await screen.findByText(/奈良市（別の旅行）.*の保存済みデータを表示しています/)

    await act(async () => {
      gate.resolve()
    })
    await flush()

    expect(screen.getByText(/奈良市（別の旅行）.*の保存済みデータを表示しています/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /奈良市/ }).getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.queryByText(new RegExp(sampleTrip.region + '.*の保存済みデータを表示しています')),
    ).toBeNull()
  })
})

describe('ReflectionFlow：認証・読み込みの失敗', () => {
  it('利用できる認証状態が無いときだけ、説明のあとに「新しい利用を始める」を出す', async () => {
    setupBackend({ 'new-user': accountA })
    fakeAuth.state.restoreError = new ClientAuthError('session_ended')
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await screen.findByRole('alert')
    expect(fakeAuth.client.startNewAnonymousSession).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: '新しい利用を始める' })
    // 影響の説明は、ボタンより前にあり、ボタンと結び付いている。
    const describedBy = button.getAttribute('aria-describedby')
    const warning = describedBy ? document.getElementById(describedBy) : null
    expect(warning?.textContent).toContain('戻れないことがあります')
    expect(warning!.closest('[hidden]')).toBeNull()
    expect(warning!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(button)
    await screen.findByRole('button', { name: /振り返る/ })
    expect(fakeAuth.client.startNewAnonymousSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['認証サービスに接続できない', () => new ClientAuthError('unavailable')],
    ['認証の設定が不正', () => new ClientAuthError('configuration_error')],
  ])('%s場合は、新しい利用を始める操作を出さない', async (_name, makeError) => {
    setupBackend()
    fakeAuth.state.restoreError = makeError()
    render(<ReflectionFlow />)

    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: '新しい利用を始める' })).toBeNull()
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('自動作成しません')
  })

  it('保存機能の停止（503）・通信断・不正な応答でも、新しい利用を始める操作を出さない', async () => {
    const cases: Array<[string, () => Promise<Response>, string]> = [
      [
        '保存機能の停止',
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'persistence_disabled', message: 'サーバーの文言' },
            }),
            { status: 503 },
          ),
        '保存機能は現在利用できません。',
      ],
      [
        '通信断',
        async () => {
          throw new TypeError('offline')
        },
        '通信に失敗しました',
      ],
      ['不正な応答', async () => new Response(JSON.stringify({ trips: 'x' })), '想定外の応答'],
    ]
    for (const [, respond, expected] of cases) {
      vi.stubGlobal('fetch', vi.fn(respond))
      const view = render(<ReflectionFlow />)
      expect((await screen.findByRole('alert')).textContent).toContain(expected)
      expect(screen.queryByRole('button', { name: '新しい利用を始める' })).toBeNull()
      expect(fakeAuth.client.startNewAnonymousSession).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('保存サービスの停止（503）と、認証の復元の失敗は、別の理由として示す', async () => {
    // 保存サービスの停止：認証は成功している。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(503, 'persistence_disabled', 'サーバーの文言')),
    )
    const stopped = render(<ReflectionFlow />)
    const stoppedText = (await screen.findByRole('alert')).textContent ?? ''
    expect(stoppedText).toContain('保存機能は現在利用できません')
    expect(stoppedText).not.toContain('認証')
    stopped.unmount()

    // 認証の復元の失敗：保存サービスには触れない。
    fakeAuth.reset()
    fakeAuth.state.restoreError = new ClientAuthError('session_ended')
    const fetchFn = vi.fn()
    vi.stubGlobal('fetch', fetchFn)
    render(<ReflectionFlow />)
    const endedText = (await screen.findByRole('alert')).textContent ?? ''
    expect(endedText).toContain('認証')
    expect(endedText).not.toContain('保存機能')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('未知のコードのサーバーエラー本文は、そのまま利用者に見せない', async () => {
    const backend = setupBackend()
    backend.intercept(
      (call) => call.path === '/api/trips',
      () => errorResponse(500, 'weird_code', 'Error at /srv/app/db.ts:12 users/abc 内部情報'),
    )
    render(<ReflectionFlow />)

    const text = (await screen.findByRole('alert')).textContent ?? ''
    expect(text).toContain('取得・更新できませんでした')
    expect(text).not.toContain('内部情報')
    expect(text).not.toContain('users/abc')
  })

  it('保存した旅行がない場合は、架空サンプルを実データとして表示しない', async () => {
    setupBackend({ [A]: { trips: [] } })
    render(<ReflectionFlow />)
    expect(await screen.findByText('保存された旅行がありません。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /振り返る/ })).toBeNull()
    expect(document.body.textContent).not.toContain('Firestore')
  })

  it('変更履歴が不完全なら、学びの候補の画面を開始しない', async () => {
    const backend = setupBackend()
    backend.intercept(
      (call: BackendCall) => call.path.endsWith('/revisions'),
      () =>
        jsonResponse({
          revisions: [],
          listInfo: { returned: 0, skippedInvalid: 1, truncated: false },
        }),
    )
    render(<ReflectionFlow initialTripId={sampleTrip.id} />)

    expect((await screen.findByText(/すべて確認できませんでした/)).textContent).toBeTruthy()
    expect(screen.queryByRole('button', { name: '学びの候補を作る' })).toBeNull()
    expect(screen.getByRole('button', { name: '読み込み直す' })).toBeTruthy()
  })

  it('保存済みの学びの取得が失敗したら、その理由を示し、保存できたようには見せない', async () => {
    const backend = setupBackend()
    backend.intercept(
      isListLearnings,
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      { always: true },
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await openTrip(user)

    await waitFor(() => {
      expect(within(savedSection()).getByRole('alert').textContent).toContain(
        '保存サービスに接続できませんでした',
      )
    })
    expect(within(savedSection()).queryByText('保存済みの学びはありません。')).toBeNull()
  })

  it('見出し構造：<main>を入れ子にせず、h1と振り返りのh2は別の言葉にする', async () => {
    setupBackend()
    const user = userEvent.setup()
    const { container } = render(<ReflectionFlow />)
    await openTrip(user)

    expect(container.querySelector('main')).toBeNull()
    const h1 = screen.getByRole('heading', { level: 1 })
    const h2s = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(h2s).toContain('旅の振り返り')
    expect(h2s).not.toContain(h1.textContent)
    // 内部の言葉や版番号を、利用者向けの文言に出さない。
    expect(screen.getByRole('button', { name: /振り返る/ }).textContent).not.toMatch(/\d+版/)
    expect(container.textContent).toContain('保存された修正案は、すべて未承認です')
  })
})
