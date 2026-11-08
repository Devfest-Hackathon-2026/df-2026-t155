import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleLearning, sampleTrip } from '@/domain/samples'
import { captureSessionScope } from '@/lib/auth/session-scope'

import { fakeAppCheck } from '../../../tests/helpers/fake-app-check'
import { fakeAuth, tokenOf } from '../../../tests/helpers/fake-auth-client'
import { requestLearningCandidates } from './api-client'

// 保護APIヘッダー（protected-api.ts）とセッションスコープは本物。App Check SDKと認証クライアントだけ差し替える。
vi.mock(
  'firebase/app-check',
  async () => (await import('../../../tests/helpers/fake-app-check')).appCheckModule,
)
vi.mock('@/lib/firebase/client', () => ({ getClientAuth: () => ({ app: {} }) }))
vi.mock('@/lib/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/client')>()
  const { fakeAuth: fake } = await import('../../../tests/helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

const request = { trip: sampleTrip, revisions: [], feedback: '昼食後は休みたかった' }
const okResponse = () =>
  new Response(JSON.stringify({ status: 'proposed', learnings: [sampleLearning] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  fakeAppCheck.reset()
  fakeAuth.reset()
  fakeAuth.signInAs('user-a')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requestLearningCandidates: 取得したセッションに束縛する', () => {
  it('同じセッションでは、Aのトークン＋App Checkで送り、候補を返す', async () => {
    const scope = await captureSessionScope()
    const fetchFn = vi.fn(async () => okResponse())
    const result = await requestLearningCandidates(request, { scope, fetchFn })
    expect(result).toMatchObject({ ok: true })
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
    const sent = new Headers(init.headers)
    expect(sent.get('Authorization')).toBe(`Bearer ${tokenOf('user-a')}`)
    expect(sent.get('X-Firebase-AppCheck')).toBe('test.app.check')
  })

  it('A→Bに切り替わった後は、Aの旅行情報をBのトークンで送らない', async () => {
    const scope = await captureSessionScope()
    fakeAuth.signInAs('user-b')
    const fetchFn = vi.fn(async () => okResponse())
    const result = await requestLearningCandidates(request, { scope, fetchFn })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
    expect(fetchFn).not.toHaveBeenCalled()
    // 現在のUIDで作り直す（スコープ非束縛の）ヘッダー取得を使っていない。
    expect(fakeAuth.client.getAuthHeaders).not.toHaveBeenCalled()
  })

  it('A→B→A（同じUIDに戻っても世代が違う）は、不一致として送らない', async () => {
    const scope = await captureSessionScope()
    fakeAuth.signInAs('user-b')
    fakeAuth.signInAs('user-a')
    const fetchFn = vi.fn(async () => okResponse())
    const result = await requestLearningCandidates(request, { scope, fetchFn })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('App Checkの取得待ち中に切り替わったら、取得が済んでも送らない', async () => {
    const scope = await captureSessionScope()
    let release!: (value: { token: string }) => void
    fakeAppCheck.getToken.mockReturnValue(new Promise((resolve) => (release = resolve)))
    const fetchFn = vi.fn(async () => okResponse())
    const pending = requestLearningCandidates(request, { scope, fetchFn })
    await Promise.resolve()
    fakeAuth.signInAs('user-b')
    release({ token: 'late.app.check' })
    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('ヘッダーを作った後、送信の直前に切り替わっても送らない（送信直前の再確認）', async () => {
    const scope = await captureSessionScope()
    const fetchFn = vi.fn(async () => okResponse())
    const result = await requestLearningCandidates(request, {
      scope,
      fetchFn,
      // ヘッダー取得の完了と同時に切り替わる場面。
      getHeaders: async () => {
        const headers = new Headers({ Authorization: `Bearer ${tokenOf('user-a')}` })
        fakeAuth.signInAs('user-b')
        return headers
      },
    })
    expect(result).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('送信後に切り替わった場合は、応答が成功でも結果を採用しない', async () => {
    const scope = await captureSessionScope()
    let respond!: (response: Response) => void
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)))
    const pending = requestLearningCandidates(request, { scope, fetchFn })
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
    fakeAuth.signInAs('user-b')
    respond(okResponse())
    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
  })

  it('応答待ちの間に同じUIDへ戻っても、古い世代の結果を採用しない', async () => {
    const scope = await captureSessionScope()
    let respond!: (response: Response) => void
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)))
    const pending = requestLearningCandidates(request, { scope, fetchFn })
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
    fakeAuth.signInAs('user-b')
    fakeAuth.signInAs('user-a')
    respond(okResponse())
    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'session_changed' } })
  })

  it('App Checkを用意できないときは、有効なセッションでも送らない', async () => {
    const scope = await captureSessionScope()
    fakeAppCheck.getToken.mockRejectedValue(new Error('failed'))
    const fetchFn = vi.fn(async () => okResponse())
    expect(await requestLearningCandidates(request, { scope, fetchFn })).toMatchObject({
      ok: false,
      failure: { kind: 'app_check_unavailable' },
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
