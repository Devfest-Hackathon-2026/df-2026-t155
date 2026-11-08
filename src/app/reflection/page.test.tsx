// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision, sampleTrip } from '@/domain/samples'

import { fakeAuth } from '../../../tests/helpers/fake-auth-client'
import { createFakeBackend } from '../../../tests/helpers/fake-persistence-backend'
import ReflectionPage from './page'

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
