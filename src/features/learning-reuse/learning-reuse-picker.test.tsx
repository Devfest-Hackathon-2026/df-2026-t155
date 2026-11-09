// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLayoutEffect, useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApprovedLearning } from '@/domain'
import { sampleApprovedLearning, sampleLearning } from '@/domain/samples'
import {
  createSessionScope,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'
import type { SessionScopeState } from '@/lib/auth/use-session-scope'
import { approveLearning, MAX_LEARNING_CONTENT_LENGTH } from '@/lib/learnings/lifecycle'
import type { VersionedLearning } from '@/server/persistence/contracts'

import type { LearningLoadResult } from './api-client'
import { LearningReusePicker, type LoadLearningOptions } from './learning-reuse-picker'
import { resolveSelectionForRequest, type ScopedLearningSelection } from './selection-scope'

// session-scope.tsが読み込むFirebase側は使わない（読み込み関数は各テストが差し替える）。
vi.mock('@/lib/auth/client', () => ({ getAuthSnapshot: vi.fn() }))

afterEach(cleanup)

const approvedRegional = approveLearning(
  { ...sampleLearning, scope: { kind: 'region', region: '京都市' } },
  '2026-11-08T20:00:00+09:00',
)
// 版は学びごとに違う値にして、画面で見た版がそのまま返ることを確かめる。
const records: VersionedLearning[] = [
  { version: 2, learning: sampleApprovedLearning },
  { version: 3, learning: approvedRegional },
]

const scopesBySession = new Map<string, SessionScope>()
const scopeFor = (uid: string, epoch = 0): SessionScope => {
  const key = JSON.stringify([uid, epoch])
  let scope = scopesBySession.get(key)
  if (!scope) {
    scope = createSessionScope(uid, epoch)
    scopesBySession.set(key, scope)
  }
  return scope
}
const scopeA = scopeFor('user-a')
const authed = (uid: string, scopeEpoch = 0): SessionScopeState => ({
  status: 'authenticated',
  scope: scopeFor(uid, scopeEpoch),
  scopeEpoch,
})
const sessionA = authed('user-a')

// 取得したセッションと組にして返す（本物のapi-clientと同じ形）。
const okFor = (scope: SessionScope, items: VersionedLearning[] = records): LearningLoadResult => ({
  ok: true,
  learnings: { scope, value: items },
})
const loaded: LoadLearningOptions = async (scope) => okFor(scope)

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('学びの選択UI', () => {
  it('すべての地域と同じ地域の学びだけを、画面に表示した版と選択時のセッションつきで選択できる', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={loaded}
        onSelectionChange={onSelectionChange}
      />,
    )

    expect(await screen.findByText(approvedRegional.content)).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    await user.click(boxes[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      scope: scopeA,
      value: [{ id: approvedRegional.id, version: 3 }],
      learnings: [approvedRegional],
    })
    await user.click(boxes[0])
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      scope: scopeA,
      value: [
        { id: approvedRegional.id, version: 3 },
        { id: sampleApprovedLearning.id, version: 2 },
      ],
      learnings: [sampleApprovedLearning, approvedRegional],
    })
    await user.click(boxes[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      scope: scopeA,
      value: [{ id: sampleApprovedLearning.id, version: 2 }],
      learnings: [sampleApprovedLearning],
    })
  })

  it('取得時のセッションで読み込む（現在の認証ではなく、表示しているセッションのスコープを渡す）', async () => {
    const load = vi.fn<LoadLearningOptions>(loaded)
    render(<LearningReusePicker region="京都市" session={sessionA} load={load} />)
    await screen.findByText(approvedRegional.content)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0][0]).toBe(scopeA)
    expect(load.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
  })

  it('地域が変わると古い選択を破棄し、地域外の学びを表示しない', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const view = render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={loaded}
        onSelectionChange={onSelectionChange}
      />,
    )
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[1])
    view.rerender(
      <LearningReusePicker
        region="奈良市"
        session={sessionA}
        load={loaded}
        onSelectionChange={onSelectionChange}
      />,
    )
    await waitFor(() => expect(screen.queryByText(approvedRegional.content)).toBeNull())
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    // 利用者が選んでいた学びが解除されたことを、黙らずに伝える。
    expect(screen.getByRole('status').textContent).toContain('選んでいた学びを解除しました')
  })

  it('APIが失敗したら、事前に選んでいた学びを持ち越さず、再試行後も未選択から始める', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const load = vi
      .fn<LoadLearningOptions>()
      .mockImplementationOnce(async (scope) => okFor(scope))
      .mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: '停止中です。' })
      .mockImplementationOnce(async (scope) => okFor(scope))
    const view = render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )

    // 先に京都市で学びを選んでおく。
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[0])
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      scope: scopeA,
      value: [{ id: sampleApprovedLearning.id, version: 2 }],
      learnings: [sampleApprovedLearning],
    })
    const callsBeforeFailure = onSelectionChange.mock.calls.length

    // 地域を変えた読み込みが失敗する。選択は無効に戻り、学びは表示されない。
    view.rerender(
      <LearningReusePicker
        region="奈良市"
        session={sessionA}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('停止中です。')
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const afterFailure = onSelectionChange.mock.calls.slice(callsBeforeFailure)
    expect(afterFailure.length).toBeGreaterThan(0)
    expect(afterFailure.every(([selection]) => selection === null)).toBe(true)

    // 再試行で取得できても、前の選択は戻らない。
    await user.click(screen.getByRole('button', { name: '再読み込み' }))
    await screen.findByText(sampleApprovedLearning.content)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
  })

  it('地域外だけなら学びなしと明示する', async () => {
    const load: LoadLearningOptions = async (scope) =>
      okFor(scope, [{ version: 1, learning: approvedRegional }])
    render(<LearningReusePicker region="奈良市" session={sessionA} load={load} />)
    expect(await screen.findByText(/今回の地域に使える、承認済みの学びはありません/)).toBeTruthy()
  })

  it('地域の表記は完全一致だけを対象にすることを画面に示す', () => {
    render(<LearningReusePicker region="京都市" session={sessionA} load={loaded} />)
    expect(screen.getByText(/旅行先の地域と同じ表記のものだけが表示されます/)).toBeTruthy()
  })
})

describe('認証セッションとの結び付け', () => {
  // 同じIDとversionで、本文だけがUIDごとに違う学び。
  const learningOf = (uid: string): VersionedLearning => ({
    version: 1,
    learning: { ...sampleApprovedLearning, content: `${uid}だけが見える本文` },
  })
  const perUser: LoadLearningOptions = async (scope) => okFor(scope, [learningOf(scope.uid)])

  it('UIDが変わると、前のUIDの一覧と選択を捨て、新しいUIDのスコープで読み直す', async () => {
    const load = vi.fn<LoadLearningOptions>(perUser)
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const view = render(
      <LearningReusePicker
        region="京都市"
        session={authed('user-a')}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    await screen.findByText('user-aだけが見える本文')
    await user.click(screen.getByRole('checkbox'))
    const selectedA = onSelectionChange.mock.lastCall?.[0] as ScopedLearningSelection
    expect(selectedA.scope.uid).toBe('user-a')

    view.rerender(
      <LearningReusePicker
        region="京都市"
        session={authed('user-b', 1)}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    // Bの一覧に替わる。Aの本文は一度も残らず、選択は解除される。
    await screen.findByText('user-bだけが見える本文')
    expect(screen.queryByText('user-aだけが見える本文')).toBeNull()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    expect(load.mock.calls.map(([scope]) => scope.uid)).toEqual(['user-a', 'user-b'])
    expect(screen.getByRole('status').textContent).toContain('選んでいた学びを解除しました')

    // 親が古い選択を保持していても、Bのスコープでは取り出せない。
    expect(() => resolveSelectionForRequest(selectedA, scopeFor('user-b', 1))).toThrow(
      SessionChangedError,
    )
  })

  it('UIDが変わった最初の描画（読み直しが始まる前）でも、前のUIDの本文を表示しない', async () => {
    // 変更を反映した描画の直後（読み直しの副作用より前）に、画面の文字を記録する。
    const frames: string[] = []
    function Probe() {
      const ref = useRef<HTMLSpanElement>(null)
      useLayoutEffect(() => {
        frames.push(ref.current?.parentElement?.textContent ?? '')
      })
      return <span ref={ref} />
    }
    const ui = (session: SessionScopeState) => (
      <div>
        <LearningReusePicker region="京都市" session={session} load={perUser} />
        <Probe />
      </div>
    )
    const view = render(ui(authed('user-a')))
    await screen.findByText('user-aだけが見える本文')
    frames.length = 0

    view.rerender(ui(authed('user-b', 1)))
    await screen.findByText('user-bだけが見える本文')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.some((text) => text.includes('user-aだけが見える本文'))).toBe(false)
  })

  it('AからBへ切り替えた後に遅れて届いたAの応答を、Bの画面に出さない（同じID・版で本文だけ違う）', async () => {
    const late = deferred<LearningLoadResult>()
    const signals: AbortSignal[] = []
    const load: LoadLearningOptions = (scope, signal) => {
      signals.push(signal)
      // Aの応答だけが遅れる。Aの読み込み関数は中断を無視して、後から応答を返す。
      return scope.uid === 'user-a' ? late.promise : perUser(scope, signal)
    }
    const onSelectionChange = vi.fn()
    const view = render(
      <LearningReusePicker
        region="京都市"
        session={authed('user-a')}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    view.rerender(
      <LearningReusePicker
        region="京都市"
        session={authed('user-b', 1)}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    await screen.findByText('user-bだけが見える本文')
    expect(signals[0].aborted).toBe(true)

    await act(async () => {
      late.resolve(okFor(scopeA, [learningOf('user-a')]))
      await late.promise
    })
    // Aの本文は、Bの画面に出ない。選ぶこともできない。
    expect(screen.queryByText('user-aだけが見える本文')).toBeNull()
    expect(screen.getByText('user-bだけが見える本文')).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  })

  it('読み込みを始めたセッションと違うセッションの一覧を返す読み込み関数は、一覧を採用しない', async () => {
    // Bとして読み込みを始めたのに、Aで取得した一覧が返ってくる（取り違え）。
    const mixedUp: LoadLearningOptions = async () => okFor(scopeA, [learningOf('user-a')])
    render(<LearningReusePicker region="京都市" session={authed('user-b')} load={mixedUp} />)
    expect((await screen.findByRole('alert')).textContent).toContain('認証状態が変わりました')
    expect(screen.queryByText('user-aだけが見える本文')).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('A→B→Aと戻って同じUIDになっても、世代が違えば前の一覧と選択を使わない', async () => {
    const load = vi.fn<LoadLearningOptions>(perUser)
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const props = { region: '京都市', load, onSelectionChange }
    const view = render(<LearningReusePicker {...props} session={authed('user-a', 0)} />)
    await screen.findByText('user-aだけが見える本文')
    await user.click(screen.getByRole('checkbox'))
    const selectedFromFirstA = onSelectionChange.mock.lastCall?.[0] as ScopedLearningSelection

    view.rerender(<LearningReusePicker {...props} session={authed('user-b', 1)} />)
    await screen.findByText('user-bだけが見える本文')
    view.rerender(<LearningReusePicker {...props} session={authed('user-a', 2)} />)
    await screen.findByText('user-aだけが見える本文')

    expect(load).toHaveBeenCalledTimes(3)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    expect(() => resolveSelectionForRequest(selectedFromFirstA, scopeFor('user-a', 2))).toThrow(
      SessionChangedError,
    )
  })

  it('同じUID・同じ認証世代の再通知では、読み込み直さず選択も保つ', async () => {
    const load = vi.fn<LoadLearningOptions>(perUser)
    const user = userEvent.setup()
    const props = { region: '京都市', load }
    const view = render(<LearningReusePicker {...props} session={authed('user-a')} />)
    await screen.findByText('user-aだけが見える本文')
    await user.click(screen.getByRole('checkbox'))

    view.rerender(<LearningReusePicker {...props} session={authed('user-a')} />)
    expect(load).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  it('認証の復元中は読み込まず、認証済みになってから読み込む', async () => {
    const load = vi.fn<LoadLearningOptions>(perUser)
    const view = render(
      <LearningReusePicker
        region="京都市"
        session={{ status: 'restoring', scopeEpoch: 0 }}
        load={load}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('認証状態を確認しています')
    expect(load).not.toHaveBeenCalled()

    view.rerender(<LearningReusePicker region="京都市" session={authed('user-a')} load={load} />)
    await screen.findByText('user-aだけが見える本文')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('セッションが終了した・確認できないときは、それまでの一覧と選択を消し、読み込みも始めない', async () => {
    for (const status of ['session_ended', 'error'] as const) {
      const load = vi.fn<LoadLearningOptions>(perUser)
      const onSelectionChange = vi.fn()
      const user = userEvent.setup()
      const view = render(
        <LearningReusePicker
          region="京都市"
          session={authed('user-a')}
          load={load}
          onSelectionChange={onSelectionChange}
        />,
      )
      await screen.findByText('user-aだけが見える本文')
      await user.click(screen.getByRole('checkbox'))

      view.rerender(
        <LearningReusePicker
          region="京都市"
          session={{ status, error: { code: 'session_ended' } as never, scopeEpoch: 0 }}
          load={load}
          onSelectionChange={onSelectionChange}
        />,
      )
      expect((await screen.findByRole('alert')).textContent).toContain('認証状態を確認できません')
      expect(screen.queryByText('user-aだけが見える本文')).toBeNull()
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
      // 再読み込みで直る状況ではない（匿名アカウントも作らない）。
      expect(screen.queryByRole('button', { name: '再読み込み' })).toBeNull()
      expect(onSelectionChange).toHaveBeenLastCalledWith(null)
      expect(load).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  it('終了したセッションと同じUIDに戻っても、前の一覧は使わず読み直す', async () => {
    const load = vi.fn<LoadLearningOptions>(perUser)
    const user = userEvent.setup()
    const view = render(
      <LearningReusePicker region="京都市" session={authed('user-a')} load={load} />,
    )
    await screen.findByText('user-aだけが見える本文')
    await user.click(screen.getByRole('checkbox'))

    view.rerender(
      <LearningReusePicker
        region="京都市"
        session={{
          status: 'session_ended',
          error: { code: 'session_ended' } as never,
          scopeEpoch: 0,
        }}
        load={load}
      />,
    )
    view.rerender(<LearningReusePicker region="京都市" session={authed('user-a')} load={load} />)
    await screen.findByText('user-aだけが見える本文')
    expect(load).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('アンマウントで進行中の読み込みを中断し、遅れて届いた応答は反映せず、親の選択も無効にする', async () => {
    const late = deferred<LearningLoadResult>()
    const signals: AbortSignal[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onSelectionChange = vi.fn()
    const view = render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={(_scope, signal) => {
          signals.push(signal)
          return late.promise
        }}
        onSelectionChange={onSelectionChange}
      />,
    )
    view.unmount()
    expect(signals[0].aborted).toBe(true)
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)

    await act(async () => {
      late.resolve(okFor(scopeA))
      await late.promise
    })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('アンマウント後に再マウントすると、読み込み直し、前の選択は戻らない', async () => {
    const load = vi.fn<LoadLearningOptions>(loaded)
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const first = render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[0])
    first.unmount()
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)

    render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    await screen.findByText(approvedRegional.content)
    expect(load).toHaveBeenCalledTimes(2)
    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false)
    }
  })
})

describe('読み直しで版が進んだ・撤回された学び', () => {
  it('再承認で版が進んだ学びは、読み直した新しい版で選び、古い版の選択を持ち越さない', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    // 1回目は版2、2回目（同じIDが再承認された後）は版3で本文も違う。
    const load = vi
      .fn<LoadLearningOptions>()
      .mockImplementationOnce(async (scope) =>
        okFor(scope, [{ version: 2, learning: sampleApprovedLearning }]),
      )
      // 途中の奈良市の読み込み。
      .mockImplementationOnce(async (scope) => okFor(scope, []))
      .mockImplementationOnce(async (scope) =>
        okFor(scope, [
          { version: 3, learning: { ...sampleApprovedLearning, content: '再承認後の本文' } },
        ]),
      )
    const props = { session: sessionA, load, onSelectionChange }
    const view = render(<LearningReusePicker {...props} region="京都市" />)
    await user.click(await screen.findByRole('checkbox'))
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      scope: scopeA,
      value: [{ id: sampleApprovedLearning.id, version: 2 }],
      learnings: [sampleApprovedLearning],
    })

    // 地域を変えて戻すと読み直す。古い版の選択は戻らない。
    view.rerender(<LearningReusePicker {...props} region="奈良市" />)
    view.rerender(<LearningReusePicker {...props} region="京都市" />)
    await screen.findByText('再承認後の本文')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    await user.click(screen.getByRole('checkbox'))
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      scope: scopeA,
      value: [{ id: sampleApprovedLearning.id, version: 3 }],
      learnings: [{ ...sampleApprovedLearning, content: '再承認後の本文' }],
    })
  })

  it('撤回された学びは、読み直した一覧に出ず、選択も戻らない', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const load = vi
      .fn<LoadLearningOptions>()
      .mockImplementationOnce(async (scope) => okFor(scope))
      // 途中の奈良市の読み込み。
      .mockImplementationOnce(async (scope) => okFor(scope, []))
      // 読み直したときには、sampleApprovedLearning が撤回されている。
      .mockImplementationOnce(async (scope) => okFor(scope, [records[1]]))
    const props = { session: sessionA, load, onSelectionChange }
    const view = render(<LearningReusePicker {...props} region="京都市" />)
    await screen.findByText(sampleApprovedLearning.content)
    await user.click(screen.getAllByRole('checkbox')[0])

    view.rerender(<LearningReusePicker {...props} region="奈良市" />)
    view.rerender(<LearningReusePicker {...props} region="京都市" />)
    await screen.findByText(approvedRegional.content)
    expect(screen.queryByText(sampleApprovedLearning.content)).toBeNull()
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
  })
})

describe('取得・表示する一覧の整合', () => {
  const overLimit: ApprovedLearning = {
    ...sampleApprovedLearning,
    content: 'あ'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1),
  }

  it('セッション終了後に同じUIDへ戻っても、前世代の選択を復活させない', async () => {
    const load = vi.fn<LoadLearningOptions>(async (scope) =>
      okFor(scope, [
        {
          version: 1,
          learning: { ...sampleApprovedLearning, content: `${scope.uid}だけが見える本文` },
        },
      ]),
    )
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const view = render(
      <LearningReusePicker
        region="京都市"
        session={authed('user-a', 0)}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    await screen.findByText('user-aだけが見える本文')
    await user.click(screen.getByRole('checkbox'))
    const selectedBeforeEnd = onSelectionChange.mock.lastCall?.[0] as ScopedLearningSelection

    view.rerender(
      <LearningReusePicker
        region="京都市"
        session={{
          status: 'session_ended',
          error: { code: 'session_ended' } as never,
          scopeEpoch: 1,
        }}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('認証状態を確認できません')
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)

    view.rerender(
      <LearningReusePicker
        region="京都市"
        session={authed('user-a', 2)}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    await screen.findByText('user-aだけが見える本文')
    expect(load).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    expect(() => resolveSelectionForRequest(selectedBeforeEnd, scopeFor('user-a', 2))).toThrow(
      SessionChangedError,
    )
  })

  it('上限ちょうどの本文は表示し、上限を超える本文を含む一覧は選べる形で表示しない', async () => {
    const exact: ApprovedLearning = {
      ...sampleApprovedLearning,
      content: 'い'.repeat(MAX_LEARNING_CONTENT_LENGTH),
    }
    const view = render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={async (scope) => okFor(scope, [{ version: 1, learning: exact }])}
      />,
    )
    expect(await screen.findByText(exact.content)).toBeTruthy()

    view.rerender(
      <LearningReusePicker
        region="奈良市"
        session={sessionA}
        load={async (scope) => okFor(scope, [{ version: 1, learning: overLimit }])}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('不正な項目')
    expect(screen.queryByText(overLimit.content)).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('IDが重複する一覧は、どの版を選んだのか曖昧になるため表示しない', async () => {
    render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={async (scope) =>
          okFor(scope, [
            { version: 1, learning: sampleApprovedLearning },
            { version: 2, learning: { ...sampleApprovedLearning, content: '別の文' } },
          ])
        }
      />,
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('読み込み関数が例外で終わっても、空の一覧とはせずエラーとして示す', async () => {
    render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={async () => {
          throw new Error('boom')
        }}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('取得できませんでした')
  })

  it('取得時にUIDが変わっていた失敗（session_changed）は、再読み込みを案内する', async () => {
    render(
      <LearningReusePicker
        region="京都市"
        session={sessionA}
        load={async () => ({
          ok: false,
          kind: 'session_changed',
          message: '認証状態が変わりました。学びを読み込み直してください。',
        })}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('読み込み直してください')
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeTruthy()
  })
})

describe('地域の正規化', () => {
  it('前後に空白がある地域入力でも、同じ表記の地域限定の学びを選べる', async () => {
    const load = vi.fn<LoadLearningOptions>(loaded)
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    render(
      <LearningReusePicker
        region={'  京都市　'}
        session={sessionA}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    expect(await screen.findByText(approvedRegional.content)).toBeTruthy()
    await user.click(screen.getAllByRole('checkbox')[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      scope: scopeA,
      value: [{ id: approvedRegional.id, version: 3 }],
      learnings: [approvedRegional],
    })
  })

  it('空白だけが変わった入力では、読み込みも選択の破棄もやり直さない', async () => {
    const load = vi.fn<LoadLearningOptions>(loaded)
    const user = userEvent.setup()
    const view = render(<LearningReusePicker region="京都市" session={sessionA} load={load} />)
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[1])

    view.rerender(<LearningReusePicker region=" 京都市 " session={sessionA} load={load} />)
    expect(load).toHaveBeenCalledTimes(1)
    expect((screen.getAllByRole('checkbox')[1] as HTMLInputElement).checked).toBe(true)
  })

  it('空白だけの地域は読み込まず、地域の入力を求める', async () => {
    const load = vi.fn<LoadLearningOptions>(loaded)
    render(<LearningReusePicker region={'  　'} session={sessionA} load={load} />)
    expect((await screen.findByRole('alert')).textContent).toContain('地域を入力')
    expect(load).not.toHaveBeenCalled()
  })

  it('表記が違う地域（京都と京都市）の学びは、同じ地域として表示しない', async () => {
    render(<LearningReusePicker region="京都" session={sessionA} load={loaded} />)
    await screen.findByText(sampleApprovedLearning.content)
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.queryByText(approvedRegional.content)).toBeNull()
  })
})

describe('親コンポーネントとの連携', () => {
  // 読み込み関数をrenderごとに新しく作り、選択の通知でstateを更新する、典型的な親。
  // 通知のたびに再描画が連鎖すると読み込みを繰り返し続けるため、描画回数に上限を設けて、
  // ワーカーを固めずにテストを失敗させる。
  let renders = 0
  function InlineParent({ onLoad }: { onLoad: () => void }) {
    renders += 1
    if (renders > 50) throw new Error('再描画が繰り返されています')
    const [selection, setSelection] = useState<ScopedLearningSelection | null>(null)
    return (
      <>
        <LearningReusePicker
          region="京都市"
          session={sessionA}
          onSelectionChange={setSelection}
          load={async (scope) => {
            onLoad()
            return okFor(scope)
          }}
        />
        <output aria-label="親が受け取った件数">{selection?.value.length ?? 0}</output>
      </>
    )
  }

  it('読み込み関数が毎回新しくても、選択通知でstateを更新しても、読み込みを繰り返さない', async () => {
    renders = 0
    const user = userEvent.setup()
    const onLoad = vi.fn()
    render(<InlineParent onLoad={onLoad} />)

    expect(await screen.findByText(approvedRegional.content)).toBeTruthy()
    await user.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByLabelText('親が受け取った件数').textContent).toBe('1')
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('親が選択を保持している間にUIDが変わると、親の選択は無効（null）に戻る', async () => {
    const user = userEvent.setup()
    function Parent({ session }: { session: SessionScopeState }) {
      const [selection, setSelection] = useState<ScopedLearningSelection | null>(null)
      return (
        <>
          <LearningReusePicker
            region="京都市"
            session={session}
            onSelectionChange={setSelection}
            load={async (scope) => okFor(scope)}
          />
          <output aria-label="親の選択の持ち主">{selection ? selection.scope.uid : 'なし'}</output>
        </>
      )
    }
    const view = render(<Parent session={authed('user-a')} />)
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByLabelText('親の選択の持ち主').textContent).toBe('user-a')

    view.rerender(<Parent session={authed('user-b', 1)} />)
    await waitFor(() => expect(screen.getByLabelText('親の選択の持ち主').textContent).toBe('なし'))
  })
})

describe('支援技術への通知とフォーカス', () => {
  it('状況表示の領域は最初から常設され、同じ要素の中身だけが入れ替わる', async () => {
    const user = userEvent.setup()
    render(<LearningReusePicker region="京都市" session={sessionA} load={loaded} />)

    // 内容と同時に挿入される領域は読み上げられないことがあるため、読み込み前から存在する。
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('確認しています')

    await screen.findByText(approvedRegional.content)
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toContain('2件の学びから選べます')
    expect(status.textContent).toContain('現在0件を選択中')

    await user.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toContain('現在1件を選択中')
  })

  it('学びが無いときの案内も、同じ常設の領域に出す', async () => {
    render(
      <LearningReusePicker
        region="奈良市"
        session={sessionA}
        load={async (scope) => okFor(scope, [])}
      />,
    )
    const status = screen.getByRole('status')
    await waitFor(() => expect(status.textContent).toContain('承認済みの学びはありません'))
    expect(screen.getByRole('status')).toBe(status)
  })

  it('再読み込みを押してボタンが消えても、フォーカスが文書の先頭へ落ちない', async () => {
    const user = userEvent.setup()
    let release: (result: LearningLoadResult) => void = () => undefined
    const load = vi
      .fn<LoadLearningOptions>()
      .mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: '停止中です。' })
      .mockImplementationOnce(
        () =>
          new Promise<LearningLoadResult>((resolve) => {
            release = resolve
          }),
      )
    render(<LearningReusePicker region="京都市" session={sessionA} load={load} />)

    const retry = await screen.findByRole('button', { name: '再読み込み' })
    await user.click(retry)

    // ボタンは読み込み中に消えるが、フォーカスは常設の状況表示へ移る。
    await waitFor(() => expect(screen.queryByRole('button', { name: '再読み込み' })).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('status'))
    expect(document.activeElement).not.toBe(document.body)

    release(okFor(scopeA))
    await screen.findByText(approvedRegional.content)
    expect(document.activeElement).not.toBe(document.body)
  })
})
