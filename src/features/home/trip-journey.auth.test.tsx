// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sampleReviseTripRequest } from '@/domain/samples'
import type { GenerateRevisions, RevisionResult } from '@/features/revision-review/api-client'
import { captureSessionScope } from '@/lib/auth/session-scope'

import { fakeAppCheck } from '../../../tests/helpers/fake-app-check'
import { fakeAuth } from '../../../tests/helpers/fake-auth-client'

import { createScopedRevisions } from './trip-journey'

const { firebaseApp } = vi.hoisted(() => ({ firebaseApp: {} }))
vi.mock(
  'firebase/app-check',
  async () => (await import('../../../tests/helpers/fake-app-check')).appCheckModule,
)
vi.mock('@/lib/firebase/client', () => ({ getClientAuth: () => ({ app: firebaseApp }) }))
vi.mock('@/lib/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/client')>()
  const { fakeAuth: fake } = await import('../../../tests/helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

beforeEach(() => {
  fakeAppCheck.reset()
  fakeAuth.reset()
  fakeAuth.signInAs('user-a')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('scope不在では現在の別UIDのヘッダーにフォールバックせず、候補生成を始めない', async () => {
  const fetchFn = vi.fn<typeof fetch>()
  const custom = vi.fn<GenerateRevisions>()
  vi.stubGlobal('fetch', fetchFn)

  const result = await createScopedRevisions(null)(
    sampleReviseTripRequest,
    new AbortController().signal,
  )
  expect(result.status).toBe('auth_required')
  expect(fetchFn).not.toHaveBeenCalled()
  expect(fakeAppCheck.getToken).not.toHaveBeenCalled()

  const customResult = await createScopedRevisions(null, custom)(
    sampleReviseTripRequest,
    new AbortController().signal,
  )
  expect(customResult.status).toBe('auth_required')
  expect(custom).not.toHaveBeenCalled()
})

it('scopeが有効なら取得元AのBearerとApp Checkで一度だけ送る', async () => {
  const scope = await captureSessionScope()
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }))
  vi.stubGlobal('fetch', fetchFn)

  const result = await createScopedRevisions(scope)(
    sampleReviseTripRequest,
    new AbortController().signal,
  )
  expect(result.status).toBe('unavailable')
  expect(fetchFn).toHaveBeenCalledTimes(1)
  const headers = new Headers(fetchFn.mock.calls[0][1]?.headers)
  expect(headers.get('Authorization')).toBe('Bearer token-of-user-a')
  expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
})

it('App Check取得中にA→Bへ切り替わっても、AのTripをBのBearerで送信しない', async () => {
  const scope = await captureSessionScope()
  const token = Promise.withResolvers<{ token: string }>()
  fakeAppCheck.getToken.mockReturnValueOnce(token.promise)
  const fetchFn = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchFn)

  const pending = createScopedRevisions(scope)(
    sampleReviseTripRequest,
    new AbortController().signal,
  )
  await vi.waitFor(() => expect(fakeAppCheck.getToken).toHaveBeenCalledOnce())
  fakeAuth.signInAs('user-b')
  token.resolve({ token: 'test.app.check' })

  const result = await pending
  expect(result.status).toBe('auth_required')
  expect(fetchFn).not.toHaveBeenCalled()
})

it('古いAの候補が遅れて返り、A→B→Aと戻っても旧結果を採用しない', async () => {
  const scope = await captureSessionScope()
  const response = Promise.withResolvers<RevisionResult>()
  const custom = vi.fn<GenerateRevisions>(() => response.promise)

  const pending = createScopedRevisions(scope, custom)(
    sampleReviseTripRequest,
    new AbortController().signal,
  )
  expect(custom).toHaveBeenCalledOnce()
  fakeAuth.signInAs('user-b')
  fakeAuth.signInAs('user-a')
  response.resolve({ status: 'proposed', revisions: [] })

  const result = await pending
  expect(result.status).toBe('auth_required')
  expect(result.status).not.toBe('proposed')
})

it('候補取得開始後の認証変更では、遅延したAPI応答を採用しない', async () => {
  const scope = await captureSessionScope()
  const response = Promise.withResolvers<Response>()
  const fetchFn = vi.fn<typeof fetch>(() => response.promise)
  vi.stubGlobal('fetch', fetchFn)

  const pending = createScopedRevisions(scope)(
    sampleReviseTripRequest,
    new AbortController().signal,
  )
  await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
  fakeAuth.signInAs('user-b')
  response.resolve(new Response(null, { status: 503 }))

  const result = await pending
  expect(result.status).toBe('auth_required')
})
