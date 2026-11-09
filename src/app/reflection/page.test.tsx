// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleLearning, sampleRevision, sampleTrip } from '@/domain/samples'

import { fakeAppCheck } from '../../../tests/helpers/fake-app-check'
import { fakeAuth } from '../../../tests/helpers/fake-auth-client'
import { createFakeBackend } from '../../../tests/helpers/fake-persistence-backend'
import ReflectionPage from './page'

// 保護APIのヘッダー（Bearer＋App Check）は実物のprotected-api.tsを通し、App Check SDKとFirebase初期化だけを差し替える。
vi.mock(
  'firebase/app-check',
  async () => (await import('../../../tests/helpers/fake-app-check')).appCheckModule,
)
vi.mock('@/lib/firebase/client', () => ({ getClientAuth: () => ({ app: {} }) }))

// 認証（Firebase）だけを差し替える。ページ・ReflectionFlow・セッションスコープ・LearningReviewは本物を使う。
vi.mock('@/lib/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/client')>()
  const { fakeAuth: fake } = await import('../../../tests/helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

// 保存済みの旅程が1件だけある保存先。
let backend: ReturnType<typeof createFakeBackend>

beforeEach(() => {
  fakeAppCheck.reset()
  fakeAuth.reset()
  fakeAuth.state.restoredUid = 'user-1'
  backend = createFakeBackend({ 'user-1': { trips: [sampleTrip], revisions: [sampleRevision] } })
  vi.stubGlobal('fetch', backend.fetchFn)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const renderPage = async (searchParams: { tripId?: string; demo?: string }) =>
  render(await ReflectionPage({ searchParams: Promise.resolve(searchParams) }))

function generateDemoLearning() {
  fireEvent.change(screen.getByLabelText(/感想・変更した理由/), {
    target: { value: '昼食後は休みたかった' },
  })
  fireEvent.click(screen.getByRole('button', { name: '学びの候補を作る' }))
}

it.each(['終了', 'A→B→A'])(
  '架空デモの候補APIは認証切替（%s）で中断し、遅延応答を表示しない',
  async (change) => {
    fakeAuth.signInAs('user-1')
    const response = Promise.withResolvers<Response>()
    const api = vi.fn<typeof fetch>(() => response.promise)
    vi.stubGlobal('fetch', api)
    await renderPage({ demo: '1' })
    generateDemoLearning()
    await waitFor(() => expect(api).toHaveBeenCalledOnce())
    expect(api.mock.calls[0][0]).toBe('/api/learnings/candidates')
    expect(new Headers(api.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer token-of-user-1',
    )
    const signal = api.mock.calls[0][1]?.signal

    if (change === '終了') fakeAuth.endSession()
    else {
      fakeAuth.signInAs('user-2')
      fakeAuth.signInAs('user-1')
    }
    await act(async () =>
      response.resolve(Response.json({ status: 'proposed', learnings: [sampleLearning] })),
    )

    expect(screen.queryByDisplayValue(sampleLearning.content)).toBeNull()
    expect(screen.queryByText(sampleLearning.content)).toBeNull()
    expect(signal?.aborted).toBe(true)
  },
)

it('架空デモでもヘッダー取得中に世代が変わったら候補APIを送信しない', async () => {
  fakeAuth.signInAs('user-1')
  const pending = Promise.withResolvers<{ token: string }>()
  fakeAppCheck.getToken.mockReturnValueOnce(pending.promise)
  const api = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', api)
  await renderPage({ demo: '1' })
  generateDemoLearning()
  await waitFor(() => expect(fakeAppCheck.getToken).toHaveBeenCalledOnce())
  fakeAuth.signInAs('user-2')
  fakeAuth.signInAs('user-1')
  await act(async () => pending.resolve({ token: 'test.app.check' }))
  expect(api).not.toHaveBeenCalled()
})

it('架空デモでも認証スコープがなければヘッダーを取得せず送信しない', async () => {
  await renderPage({ demo: '1' })
  generateDemoLearning()
  await screen.findByRole('alert')
  expect(fakeAppCheck.getToken).not.toHaveBeenCalled()
  expect(backend.fetchFn).not.toHaveBeenCalled()
})

it('同じ認証世代で届いた架空デモの候補は採用する', async () => {
  fakeAuth.signInAs('user-1')
  const api = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ status: 'proposed', learnings: [sampleLearning] }))
  vi.stubGlobal('fetch', api)
  await renderPage({ demo: '1' })
  generateDemoLearning()
  expect(await screen.findByDisplayValue(sampleLearning.content)).toBeTruthy()
  expect(api).toHaveBeenCalledOnce()
})

describe('/reflection のページ', () => {
  it('?demo=1 だけは、架空デモと明示し、保存先へつながず、保存の操作も出さない', async () => {
    await renderPage({ demo: '1' })

    expect(screen.getByRole('note').textContent).toContain('デモ用の想定です')
    expect(screen.getByRole('note').textContent).toContain('架空')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('振り返りの確認ページ')
    // 架空の旅程（サンプル）でLearningReviewを開く。保存の接続（store）は渡さない。
    expect(screen.getByRole('button', { name: '学びの候補を作る' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /保存する/ })).toBeNull()
    expect(document.body.textContent).toContain('承認した内容は、いまはこの画面の中だけにあり')
    // 本人の保存済みの旅程には触れない（認証も通信もしない）。
    expect(backend.fetchFn).not.toHaveBeenCalled()
    expect(fakeAuth.client.initializeAnonymousSession).not.toHaveBeenCalled()
    expect(fakeAuth.client.observeAuthState).not.toHaveBeenCalled()
    expect(screen.queryByText('保存済みの旅行')).toBeNull()
  })

  it('通常は、本人の保存済み旅程の振り返りを開き、架空デモの注記は出さない', async () => {
    await renderPage({})

    expect(await screen.findByRole('button', { name: /振り返る/ })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('保存した旅行を振り返る')
    expect(screen.queryByRole('note')).toBeNull()
    expect(backend.fetchFn).toHaveBeenCalledWith('/api/trips', expect.any(Object))
  })

  it.each(['0', '', 'true'])('demo=%s はデモにしない（1のときだけデモ）', async (demo) => {
    await renderPage({ demo })

    expect(await screen.findByRole('button', { name: /振り返る/ })).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('tripId は表示する旅行の指定にだけ使い、保存済みの旅行にあるときだけ選ぶ', async () => {
    await renderPage({ tripId: sampleTrip.id })
    const button = await screen.findByRole('button', { name: /振り返る/ })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByRole('button', { name: '学びの候補を作る' })).toBeTruthy()
    cleanup()

    await renderPage({ tripId: 'trip-not-owned' })
    const other = await screen.findByRole('button', { name: /振り返る/ })
    expect(other.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('button', { name: '学びの候補を作る' })).toBeNull()
  })
})
