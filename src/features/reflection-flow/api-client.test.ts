import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TripSchema } from '@/domain'
import { sampleApprovedLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import { ClientAuthError } from '@/lib/auth/client'
import { PROTECTED_FAILURE_MESSAGES } from '@/lib/auth/protected-api-errors'
import {
  captureSessionScope,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'
import type { VersionedLearning } from '@/server/persistence/contracts'

import { APP_CHECK_TOKEN, fakeAppCheck } from '../../../tests/helpers/fake-app-check'
import { fakeAuth } from '../../../tests/helpers/fake-auth-client'
import {
  createFakeBackend,
  errorResponse,
  isApprove,
  isListLearnings,
  jsonResponse,
} from '../../../tests/helpers/fake-persistence-backend'
import {
  createFirestoreLearningStore,
  isCompleteList,
  loadReflectionHistory,
  loadSavedLearnings,
  loadSavedTrips,
  ReflectionApiError,
  sameLearning,
  saveTrip,
  TRIP_NOT_SAVABLE_CODE,
  userMessageOf,
} from './api-client'

// 保護APIのヘッダー（Bearer＋App Check）は実物のprotected-api.tsを通し、App Check SDKとFirebase初期化だけを差し替える。
vi.mock(
  'firebase/app-check',
  async () => (await import('../../../tests/helpers/fake-app-check')).appCheckModule,
)
vi.mock('@/lib/firebase/client', () => ({ getClientAuth: () => ({ app: {} }) }))

// 認証クライアントだけを差し替える。セッションスコープ（session-scope.ts）は本物を使う。
vi.mock('@/lib/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/client')>()
  const { fakeAuth: fake } = await import('../../../tests/helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

const listInfo = { returned: 0, skippedInvalid: 0, truncated: false }
const json = jsonResponse
// プロキシなどが返す、JSONではないエラー応答。
const html = (status: number) =>
  new Response('<html><body>error</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  })
const failure = errorResponse

const A = 'user-a'
const B = 'user-b'
let scope: SessionScope

const first = sampleApprovedLearning
const second = { ...sampleApprovedLearning, id: 'learning-second', content: '次は休憩を多めに' }
const third = { ...sampleApprovedLearning, id: 'learning-third', content: '朝は早く出発する' }
const entry = (learning: typeof first, version = 1): VersionedLearning => ({ version, learning })

beforeEach(async () => {
  fakeAppCheck.reset()
  fakeAuth.reset()
  fakeAuth.signInAs(A)
  scope = await captureSessionScope()
})

// 保存済みの学びがある1アカウントの疑似バックエンド。
const backendWith = (...learnings: VersionedLearning[]) =>
  createFakeBackend({ [A]: { learnings, trips: [sampleTrip], revisions: [sampleRevision] } })

describe('振り返りの保存済みデータ取得', () => {
  it('認証済みの旅程だけを取得し、認証トークンは送るが再利用できるキャッシュには載せない', async () => {
    const backend = backendWith()
    const result = await loadSavedTrips(scope, { fetchFn: backend.fetchFn })
    expect(result.trips).toEqual([sampleTrip])
    const [url, init] = backend.fetchFn.mock.calls[0]
    expect(url).toBe('/api/trips')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-of-user-a')
    expect(init?.cache).toBe('no-store')
  })

  describe('旅程と変更履歴の整合', () => {
    const serve = (overrides: { trip?: unknown; revisions?: unknown; info?: object } = {}) =>
      vi.fn().mockImplementation(async (path: string) =>
        path.endsWith('/revisions')
          ? json({
              revisions: overrides.revisions ?? [sampleRevision],
              listInfo: { ...listInfo, returned: 1, ...overrides.info },
            })
          : json({ trip: overrides.trip ?? sampleTrip }),
      )

    it('旅程と変更履歴の両方が揃って初めて振り返りに渡す', async () => {
      const fetchFn = serve()
      const history = await loadReflectionHistory(scope, sampleTrip.id, { fetchFn })
      expect(history.trip).toEqual(sampleTrip)
      expect(history.revisions).toEqual([sampleRevision])
    })

    it('履歴が打ち切られている場合は学び作成に使わない', async () => {
      const fetchFn = serve({ revisions: [], info: { truncated: true, returned: 0 } })
      await expect(loadReflectionHistory(scope, sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })

    it('履歴に読み取れなかった項目がある場合は学び作成に使わない', async () => {
      const fetchFn = serve({ info: { skippedInvalid: 1 } })
      await expect(loadReflectionHistory(scope, sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })

    it('履歴の件数が、返した件数と食い違うときは学び作成に使わない', async () => {
      const fetchFn = serve({ info: { returned: 2 } })
      await expect(loadReflectionHistory(scope, sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })

    it('要求した旅程と別の旅程が返ってきたら使わない', async () => {
      const fetchFn = serve({ trip: { ...sampleTrip, id: 'trip-someone-else' } })
      await expect(loadReflectionHistory(scope, sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })

    it('別の旅程の変更履歴が混ざっていたら使わない', async () => {
      const fetchFn = serve({ revisions: [{ ...sampleRevision, tripId: 'trip-someone-else' }] })
      await expect(loadReflectionHistory(scope, sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })
  })

  it('一覧の完全性：読み取れない項目・打ち切り・件数の不一致のどれもが不完全', () => {
    expect(isCompleteList({ returned: 2, skippedInvalid: 0, truncated: false }, 2)).toBe(true)
    expect(isCompleteList({ returned: 2, skippedInvalid: 1, truncated: false }, 2)).toBe(false)
    expect(isCompleteList({ returned: 2, skippedInvalid: 0, truncated: true }, 2)).toBe(false)
    expect(isCompleteList({ returned: 3, skippedInvalid: 0, truncated: false }, 2)).toBe(false)
  })
})

describe('取得と保存は、取得したセッションに結び付く', () => {
  const getters = [
    ['旅程の一覧', (fetchFn: typeof fetch) => loadSavedTrips(scope, { fetchFn })],
    [
      '旅程と変更履歴',
      (fetchFn: typeof fetch) => loadReflectionHistory(scope, sampleTrip.id, { fetchFn }),
    ],
    ['保存済みの学び', (fetchFn: typeof fetch) => loadSavedLearnings(scope, { fetchFn })],
  ] as const

  it.each(getters)('%s：すべての要求を、スコープのUIDのトークンで送る', async (_name, load) => {
    const backend = backendWith()
    await load(backend.fetchFn)
    expect(backend.calls.length).toBeGreaterThan(0)
    expect(backend.calls.every((call) => call.uid === A)).toBe(true)
  })

  it.each(getters)('%s：UIDが変わった後は、要求を送らない', async (_name, load) => {
    const backend = backendWith()
    fakeAuth.signInAs(B)
    await expect(load(backend.fetchFn)).rejects.toBeInstanceOf(SessionChangedError)
    // 新しいUIDのトークンでも、古いスコープのデータを求める要求は送らない。
    expect(backend.fetchFn).not.toHaveBeenCalled()
  })

  it('ヘッダー取得後・fetch直前のA→B→Aでは、古いscopeの要求を送らない', async () => {
    const headersReady = Promise.withResolvers<void>()
    const pendingHeaders = Promise.withResolvers<Headers>()
    const fetchFn = vi.fn<typeof fetch>()
    const request = loadSavedTrips(scope, {
      fetchFn,
      getHeaders: () => {
        headersReady.resolve()
        return pendingHeaders.promise
      },
    })

    await headersReady.promise
    pendingHeaders.resolve(new Headers({ Authorization: 'Bearer token-of-user-a' }))
    // await継続がfetchへ進む前に、認証境界を同じ同期区間で通す。
    fakeAuth.switchSilently(B)
    fakeAuth.switchSilently(A)

    await expect(request).rejects.toBeInstanceOf(SessionChangedError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each(getters)(
    '%s：応答を待つ間にA→B→Aと切り替わったら、取得したデータを渡さない',
    async (_name, load) => {
      const backend = backendWith()
      backend.intercept(
        () => true,
        ({ proceed }) => {
          const response = proceed()
          // 画面への通知より先にA→B→Aと切り替わる。UIDが元に戻っても古い世代は無効。
          fakeAuth.switchSilently(B)
          fakeAuth.switchSilently(A)
          return response
        },
        { always: true },
      )
      await expect(load(backend.fetchFn)).rejects.toBeInstanceOf(SessionChangedError)
    },
  )

  it.each(getters)(
    '%s：セッション終了後に同じUIDへ戻っても、古い応答を渡さない',
    async (_name, load) => {
      const backend = backendWith()
      backend.intercept(
        () => true,
        ({ proceed }) => {
          const response = proceed()
          fakeAuth.endSession()
          fakeAuth.signInAs(A)
          return response
        },
        { always: true },
      )
      await expect(load(backend.fetchFn)).rejects.toBeInstanceOf(SessionChangedError)
    },
  )

  it('認証トークンが取得できないときはリクエストせず、新しい匿名UIDを自動作成しない', async () => {
    fakeAuth.endSession()
    const fetchFn = vi.fn()
    // 認証エラーは包み直さず、そのまま画面へ渡す（画面が「新しい利用」の要否を判断する）。
    await expect(loadSavedTrips(scope, { fetchFn })).rejects.toBeInstanceOf(ClientAuthError)
    await expect(loadSavedTrips(scope, { fetchFn })).rejects.toMatchObject({
      code: 'session_ended',
    })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(fakeAuth.client.startNewAnonymousSession).not.toHaveBeenCalled()
  })
})

describe('認証とHTTPエラーの扱い', () => {
  it('トークンを送って401が返ったときは、ステータス・コード・既知の定型文言を保つ', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(failure(401, 'session_revoked', '認証を継続できません。再認証が必要です'))
    const error = await loadSavedTrips(scope, { fetchFn }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ReflectionApiError)
    expect(error).toMatchObject({
      status: 401,
      code: 'session_revoked',
      message: '認証を継続できません。再認証が必要です',
    })
    expect(fetchFn.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer token-of-user-a')
  })

  it('401の本文が読めないときも、認証の案内を使う', async () => {
    const fetchFn = vi.fn().mockResolvedValue(html(401))
    const error = await loadSavedLearnings(scope, { fetchFn }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 401 })
    expect((error as Error).message).toContain('認証')
    expect((error as Error).message).not.toContain('想定外')
  })

  it.each([
    [503, '保存機能は現在利用できません'],
    [502, '保存サービスに接続できませんでした'],
    [504, '保存サービスに接続できませんでした'],
    [409, 'ほかの操作で更新されました'],
    [500, '取得・更新できませんでした'],
  ])(
    'JSONではない%i応答でも、ステータスに合う案内を使う（想定外の応答にしない）',
    async (status, text) => {
      const fetchFn = vi.fn().mockResolvedValue(html(status))
      const error = await loadSavedTrips(scope, { fetchFn }).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ status })
      expect((error as Error).message).toContain(text)
      expect((error as Error).message).not.toContain('想定外')
    },
  )

  it('既知のコードは定型文言を使い、サーバーの本文はそのまま見せない', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(failure(503, 'storage_unavailable', 'UNAVAILABLE: users/abc/learnings'))
    const error = await loadSavedTrips(scope, { fetchFn }).catch((reason: unknown) => reason)
    expect(userMessageOf(error)).toBe(
      '保存サービスを利用できません。時間をおいて、もう一度お試しください。',
    )
    expect(userMessageOf(error)).not.toContain('users/abc')
  })

  it.each(['unknown_secret_code', 'constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    '未知のコード（%s）の本文は見せず、ステータスに合う定型文言にする',
    async (code) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(failure(500, code, 'Error at /srv/app/firestore.ts:123 (内部情報)'))
      const error = await loadSavedTrips(scope, { fetchFn }).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(ReflectionApiError)
      expect((error as Error).message).toBe('保存データを取得・更新できませんでした。')
      expect((error as Error).message).not.toContain('内部情報')
    },
  )

  it('想定外の例外の本文は、利用者向けの文言に使わない', () => {
    expect(userMessageOf(new TypeError('Cannot read properties of undefined (reading x)'))).toBe(
      '情報を取得できませんでした。もう一度お試しください。',
    )
    expect(userMessageOf(new ClientAuthError('unavailable'))).toContain(
      '認証サービスに接続できません',
    )
    expect(userMessageOf(new SessionChangedError())).toContain('認証セッションが変わりました')
  })

  it('保存サービスの停止（503）と、端末側の認証の復元の失敗は、別の理由として示す', async () => {
    const stopped = await loadSavedTrips(scope, {
      fetchFn: vi
        .fn()
        .mockResolvedValue(failure(503, 'persistence_disabled', '保存機能は現在利用できません。')),
    }).catch((reason: unknown) => reason)
    fakeAuth.endSession()
    const ended = await loadSavedTrips(scope, { fetchFn: vi.fn() }).catch(
      (reason: unknown) => reason,
    )
    expect(stopped).toBeInstanceOf(ReflectionApiError)
    expect(ended).toBeInstanceOf(ClientAuthError)
    expect(userMessageOf(stopped)).toContain('保存機能')
    expect(userMessageOf(stopped)).not.toContain('認証')
    expect(userMessageOf(ended)).toContain('認証')
    expect(userMessageOf(ended)).not.toContain('保存機能')
  })

  it('成功のステータスなのに本文がJSONでない、または契約に合わないときは想定外の応答とする', async () => {
    for (const response of [html(200), json({ trips: 'x' })]) {
      const fetchFn = vi.fn().mockResolvedValue(response)
      const error = await loadSavedTrips(scope, { fetchFn }).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ status: 200 })
      expect((error as Error).message).toContain('想定外の応答')
    }
  })

  it('通信そのものが失敗したときは、通信の失敗として案内する', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(loadSavedTrips(scope, { fetchFn })).rejects.toThrow('通信に失敗しました')
  })

  it('中止済みの信号ではリクエストしない', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn()
    await expect(loadSavedTrips(scope, { fetchFn, signal: controller.signal })).rejects.toThrow(
      '通信に失敗しました',
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('応答を待つ間に中止されたら、届いた応答を採用しない', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn().mockImplementation(async () => {
      controller.abort()
      return json({ trips: [sampleTrip], listInfo: { ...listInfo, returned: 1 } })
    })
    await expect(loadSavedTrips(scope, { fetchFn, signal: controller.signal })).rejects.toThrow(
      '通信に失敗しました',
    )
  })
})

describe('保護API用ヘッダー（Bearer＋App Check）', () => {
  const sendersOf = [
    ['旅程の一覧', (fetchFn: typeof fetch) => loadSavedTrips(scope, { fetchFn })],
    ['保存済みの学び', (fetchFn: typeof fetch) => loadSavedLearnings(scope, { fetchFn })],
  ] as const

  it.each(sendersOf)('%s：BearerとApp Checkのトークンを付けて送る', async (_name, load) => {
    const backend = backendWith()
    await load(backend.fetchFn)
    const headers = new Headers(backend.fetchFn.mock.calls[0][1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer token-of-user-a')
    expect(headers.get('X-Firebase-AppCheck')).toBe(APP_CHECK_TOKEN)
  })

  it('保存（POST）にも、BearerとApp Checkのトークンを付ける', async () => {
    const backend = backendWith()
    const store = createFirestoreLearningStore(scope, vi.fn(), backend.fetchFn)
    expect(await store.save([first])).toEqual({ ok: true })
    const post = backend.fetchFn.mock.calls.find(([, init]) => init?.method === 'POST')
    const headers = new Headers(post?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer token-of-user-a')
    expect(headers.get('X-Firebase-AppCheck')).toBe(APP_CHECK_TOKEN)
  })

  it.each(sendersOf)('%s：App Checkのトークンを取得できなければ送信しない', async (_name, load) => {
    fakeAppCheck.getToken.mockRejectedValue(new Error('recaptcha: sdk internal detail'))
    const fetchFn = vi.fn()
    const error = await load(fetchFn).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ReflectionApiError)
    expect(error).toMatchObject({ code: 'app_check_unavailable', outcome: 'not_sent' })
    expect(userMessageOf(error)).toBe(PROTECTED_FAILURE_MESSAGES.app_check_unavailable)
    expect(userMessageOf(error)).not.toContain('sdk internal')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('App Checkの鍵の設定がないときも送信しない', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY', '')
    const fetchFn = vi.fn()
    await expect(loadSavedTrips(scope, { fetchFn })).rejects.toMatchObject({
      code: 'app_check_unavailable',
      outcome: 'not_sent',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('保存でApp Checkを用意できなければ、1件も送らず、未保存で再試行できるものとして返す', async () => {
    fakeAppCheck.getToken.mockRejectedValue(new Error('boom'))
    const backend = backendWith()
    const result = await createFirestoreLearningStore(scope, vi.fn(), backend.fetchFn).save([first])
    expect(result).toMatchObject({ ok: false, retryable: true, savedIds: [], unknownIds: [] })
    expect((result as { message: string }).message).toContain('App Check')
    expect(backend.fetchFn).not.toHaveBeenCalled()
  })

  it('UIDが変わった後はApp Checkのトークンを取れても送らない（fail-closed）', async () => {
    const backend = backendWith()
    fakeAuth.signInAs(B)
    await expect(loadSavedLearnings(scope, { fetchFn: backend.fetchFn })).rejects.toBeInstanceOf(
      SessionChangedError,
    )
    expect(backend.fetchFn).not.toHaveBeenCalled()
  })

  it('認証が切れているときは、App Checkの失敗とは別に、認証エラーのまま伝える', async () => {
    fakeAuth.endSession()
    const fetchFn = vi.fn()
    await expect(loadSavedTrips(scope, { fetchFn })).rejects.toBeInstanceOf(ClientAuthError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
  ] as const)(
    '%i応答は、本文に関わらず平易な固定文言にし、未保存として扱う',
    async (status, kind) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(failure(status, 'whatever_secret', 'users/abc 内部情報'))
      const error = await loadSavedTrips(scope, { fetchFn }).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ status, outcome: 'rejected' })
      expect(userMessageOf(error)).toBe(PROTECTED_FAILURE_MESSAGES[kind])
      expect(userMessageOf(error)).not.toContain('内部情報')
    },
  )

  it('403・429で本文がJSONでなくても、同じ固定文言を使う', async () => {
    const forbidden = vi.fn().mockResolvedValue(html(403))
    await expect(loadSavedTrips(scope, { fetchFn: forbidden })).rejects.toMatchObject({
      message: PROTECTED_FAILURE_MESSAGES.unauthorized,
    })
    const limited = vi.fn().mockResolvedValue(html(429))
    await expect(loadSavedTrips(scope, { fetchFn: limited })).rejects.toMatchObject({
      message: PROTECTED_FAILURE_MESSAGES.rate_limited,
    })
  })
})

describe('学びの同一性', () => {
  it('IDが違えば、内容・分類・適用範囲・元の旅程が同じでも、別の学び', () => {
    expect(sameLearning(first, { ...first })).toBe(true)
    expect(sameLearning(first, { ...first, id: 'learning-other' })).toBe(false)
    expect(sameLearning(first, { ...first, content: '別の内容' })).toBe(false)
    expect(sameLearning(first, { ...first, sourceTripId: 'trip-other' })).toBe(false)
    expect(sameLearning(first, { ...first, category: 'verification' })).toBe(false)
    expect(sameLearning(first, { ...first, scope: { kind: 'region', region: '京都市' } })).toBe(
      false,
    )
  })
})

describe('承認済み学びのFirestore保存', () => {
  it('本人が承認した学びをexpectedVersion=0で新規保存し、保存後に一覧を取り直して確認する', async () => {
    const backend = backendWith()
    const onSaved = vi.fn()
    const store = createFirestoreLearningStore(scope, onSaved, backend.fetchFn)
    expect(await store.save([first])).toEqual({ ok: true })
    expect(onSaved).toHaveBeenCalledTimes(1)

    // 事前の取得 → 承認 → 保存後の取得（最後の取得は、最後の書き込みより後）。
    expect(backend.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/learnings',
      'POST /api/learnings/learning-rest/approve',
      'GET /api/learnings',
    ])
    const [, approve] = backend.fetchFn.mock.calls
    expect(approve[1]?.method).toBe('POST')
    expect(new Headers(approve[1]?.headers).get('Authorization')).toBe('Bearer token-of-user-a')
    expect(backend.calls[1].body).toEqual({
      expectedVersion: 0,
      sourceTripId: first.sourceTripId,
      category: first.category,
      content: first.content,
      scope: first.scope,
    })
    expect(backend.calls[1].body).not.toHaveProperty('approval')
  })

  it('保存済みなら同じ内容を再送信せず、内容を変えたときだけ版を更新する', async () => {
    const updated = { ...first, content: '次回は歩く距離を短くする' }
    const backend = backendWith(entry(first, 4))
    const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
    expect(await store.save([first])).toEqual({ ok: true })
    // 同じ内容：事前・事後の取得で保存済みを確かめ、書き込みは送らない。
    expect(backend.calls).toHaveLength(2)
    expect(await store.save([updated])).toEqual({ ok: true })
    expect(backend.approveCalls()).toHaveLength(1)
    expect((backend.approveCalls()[0].body as { expectedVersion: number }).expectedVersion).toBe(4)
    expect(backend.account(A).learnings.get(first.id)).toMatchObject({ version: 5 })
  })

  it('適用範囲だけを変えたときも、変更として版を更新する', async () => {
    const regional = {
      ...first,
      scope: { kind: 'region' as const, region: sampleTrip.region },
    }
    const backend = backendWith(entry(first, 2))
    const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
    expect(await store.save([first])).toEqual({ ok: true })
    expect(await store.save([regional])).toEqual({ ok: true })
    expect(backend.approveCalls()[0].body).toMatchObject({
      expectedVersion: 2,
      scope: regional.scope,
    })
  })

  it('適用範囲の項目の並び順が違っても、同じ内容なら再送信しない', async () => {
    const regional = { kind: 'region' as const, region: sampleTrip.region }
    const saved = { ...first, scope: regional }
    // 保存先と画面で、オブジェクトのキーの並びが違っても同じ学びとして扱う。
    const reordered = { ...first, scope: { region: sampleTrip.region, kind: 'region' as const } }
    expect(Object.keys(reordered.scope)).not.toEqual(Object.keys(saved.scope))
    const backend = backendWith(entry(saved, 3))
    const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
      reordered,
    ])
    expect(result).toEqual({ ok: true })
    expect(backend.calls).toHaveLength(2)
  })

  describe('一部だけ成功したとき', () => {
    it('全件成功とせず、保存できた学びのIDを返す。サービス障害（503）は、結果不明として扱う', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(second.id), () =>
        failure(503, 'storage_unavailable', 'サーバーの文言'),
      )
      const onSaved = vi.fn()
      const store = createFirestoreLearningStore(scope, onSaved, backend.fetchFn)
      const result = await store.save([first, second])
      expect(result).toMatchObject({
        ok: false,
        savedIds: [first.id],
        unknownIds: [second.id],
        retryable: true,
      })
      if (!result.ok) {
        expect(result.message).toContain('1件は保存済みです')
        expect(result.message).toContain('1件は保存できたかどうか確認できません')
        expect(result.message).toContain('保存サービスを利用できません')
        expect(result.message).not.toContain('サーバーの文言')
      }
      // 保存済み・結果不明があるので、画面が一覧を取り直せるよう知らせる。
      expect(onSaved).toHaveBeenCalledTimes(1)
    })

    it('サーバーが何も変更せずに拒否したもの（409）は、結果不明ではなく未保存', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(second.id), () =>
        failure(409, 'storage_limit_reached', '上限です'),
      )
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
        second,
      ])
      expect(result).toMatchObject({
        ok: false,
        savedIds: [first.id],
        unknownIds: [],
        retryable: false,
      })
      if (!result.ok) expect(result.message).not.toContain('結果不明')
    })

    it('次回は成功済みの学びを再取得し、残りだけを保存する', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(second.id), () =>
        failure(409, 'storage_limit_reached', '上限です'),
      )
      const onSaved = vi.fn()
      const store = createFirestoreLearningStore(scope, onSaved, backend.fetchFn)
      await store.save([first, second])
      expect(await store.save([first, second])).toEqual({ ok: true })
      expect(onSaved).toHaveBeenCalledTimes(2)
      expect(
        backend.approveCalls().filter((call) => call.path.endsWith('/learning-rest/approve')),
      ).toHaveLength(1)
    })

    it('1件も保存できなかったときは、保存済みの一覧を取り直す通知をしない', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(), () => failure(409, 'storage_limit_reached', '上限です'), {
        always: true,
      })
      const onSaved = vi.fn()
      const result = await createFirestoreLearningStore(scope, onSaved, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [] })
      if (!result.ok) expect(result.message).not.toContain('件は保存済み')
      expect(onSaved).not.toHaveBeenCalled()
    })
  })

  describe('送信した後に応答だけを失ったとき（結果不明）', () => {
    it('3件中1件が保存された後の通信断：保存済み／結果不明／未保存を分け、自動では再送しない', async () => {
      const backend = backendWith()
      // 2件目の送信は、サーバーへ届く前に通信が切れる。
      backend.intercept(isApprove(second.id), () => {
        throw new TypeError('offline')
      })
      // 保存の後の取り直しも、通信が戻らず失敗する。
      const onSaved = vi.fn()
      const store = createFirestoreLearningStore(scope, onSaved, backend.fetchFn)
      const result = await store.save([first, second, third])

      expect(result).toMatchObject({
        ok: false,
        savedIds: [first.id],
        unknownIds: [second.id],
        retryable: true,
      })
      if (!result.ok) {
        expect(result.message).toContain('1件は保存済みです')
        expect(result.message).toContain('1件は保存できたかどうか確認できません（結果不明）')
        expect(result.message).toContain('通信に失敗しました')
      }
      // 3件目は送らない。結果不明の2件目も、自動では再送しない。
      expect(backend.approveCalls().map((call) => call.path)).toEqual([
        '/api/learnings/learning-rest/approve',
        '/api/learnings/learning-second/approve',
      ])
      expect(onSaved).toHaveBeenCalledTimes(1)
    })

    it('サーバー確定後に応答だけを失ったとき、取り直した一覧で保存済みと照合でき、再送しない', async () => {
      const backend = backendWith()
      // 書き込みは確定したが、応答は届かない。
      backend.intercept(isApprove(second.id), ({ proceed }) => {
        proceed()
        throw new TypeError('offline')
      })
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
        second,
      ])
      expect(result).toEqual({ ok: true })
      expect(backend.approveCalls()).toHaveLength(2)
      expect(backend.account(A).learnings.get(second.id)?.version).toBe(1)
    })

    it('サーバーが確定した後の500でも、取り直した一覧で保存済みと照合できる', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(first.id), ({ proceed }) => {
        proceed()
        return failure(500, 'internal_error', '内部エラー')
      })
      expect(
        await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([first]),
      ).toEqual({ ok: true })
      expect(backend.approveCalls()).toHaveLength(1)
    })

    it('応答喪失から保存済みと照合できた学びは、その版を確認済みとして、次の更新に使える', async () => {
      const edited = { ...first, content: '休憩を増やしたい' }
      const backend = backendWith()
      backend.intercept(isApprove(first.id), ({ proceed }) => {
        proceed()
        throw new TypeError('offline')
      })
      const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      expect(await store.save([first])).toEqual({ ok: true })

      // 照合で確認した版1が、期待版として使われる（別端末の更新と取り違えて、止めない）。
      expect(await store.save([edited])).toEqual({ ok: true })
      expect(
        (backend.approveCalls().at(-1)?.body as { expectedVersion: number }).expectedVersion,
      ).toBe(1)
      expect(backend.account(A).learnings.get(first.id)).toMatchObject({ version: 2 })
    })

    it('送信前の想定外の例外でも、本文は見せず、送信の有無を言い切らない（結果不明）', async () => {
      const backend = backendWith()
      // 1回目の取得（2回の認証確認）の後、承認の送信の認証確認で想定外の例外が起きる。
      const normal = fakeAuth.client.getAuthSnapshot.getMockImplementation()!
      fakeAuth.client.getAuthSnapshot
        .mockImplementationOnce(normal)
        .mockImplementationOnce(normal)
        .mockRejectedValueOnce(new Error('boom: internal detail'))
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false, unknownIds: [first.id] })
      if (!result.ok) expect(result.message).not.toContain('boom')
      expect(backend.approveCalls()).toHaveLength(0)
    })

    it('確定後に応答を失い、取り直しも失敗したら結果不明のまま。確認してから、利用者の操作で保存する', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(first.id), ({ proceed }) => {
        proceed()
        throw new TypeError('offline')
      })
      // 保存の後の取り直し（2回目の一覧取得）も失敗する。
      let lists = 0
      backend.intercept(
        (call) => isListLearnings(call) && ++lists === 2,
        () => {
          throw new TypeError('offline')
        },
        { always: true },
      )
      const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      const result = await store.save([first])
      expect(result).toMatchObject({
        ok: false,
        savedIds: [],
        unknownIds: [first.id],
        retryable: true,
      })
      expect(backend.approveCalls()).toHaveLength(1)

      // 利用者が、確認してから保存し直す：一覧を取り直して保存済みと分かり、再送しない。
      expect(await store.save([first])).toEqual({ ok: true })
      expect(backend.approveCalls()).toHaveLength(1)
    })

    it('確定しなかった応答喪失は、利用者の操作で保存し直すと、1回だけ保存される', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(first.id), () => {
        throw new TypeError('offline')
      })
      const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      expect(await store.save([first])).toMatchObject({ ok: false, unknownIds: [first.id] })
      expect(backend.account(A).learnings.size).toBe(0)
      expect(await store.save([first])).toEqual({ ok: true })
      expect(backend.account(A).learnings.get(first.id)?.version).toBe(1)
      expect(backend.approveCalls()).toHaveLength(2)
    })

    it.each([
      ['読めない応答（HTML）', () => html(502)],
      ['200なのに本文がJSONでない', () => html(200)],
      ['200なのに契約に合わない本文', () => json({ ok: true })],
    ])('%s：未保存と決めつけず、結果不明にする', async (_name, makeResponse) => {
      const backend = backendWith()
      // 書き込みは実行せず、応答だけを返す（取り直しでは見つからない）。
      backend.intercept(isApprove(first.id), () => makeResponse())
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [first.id] })
    })

    it('応答を待つ間に中止されたら、未保存ではなく結果不明にする', async () => {
      const controller = new AbortController()
      const backend = backendWith()
      backend.intercept(isApprove(first.id), ({ proceed }) => {
        proceed()
        controller.abort()
        return jsonResponse({}, 200)
      })
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save(
        [first],
        { signal: controller.signal },
      )
      expect(result).toMatchObject({ ok: false, unknownIds: [first.id] })
    })
  })

  describe('保存結果と現在の承認状態の整合', () => {
    it('POSTの応答が、送った内容と違うときは、保存できたとしない（結果不明）', async () => {
      const onSaved = vi.fn()
      const backend = backendWith()
      backend.intercept(isApprove(first.id), () =>
        json({ version: 1, learning: { ...first, content: '送っていない別の内容' } }),
      )
      const result = await createFirestoreLearningStore(scope, onSaved, backend.fetchFn).save([
        first,
        second,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [first.id] })
      if (!result.ok) expect(result.message).toContain('想定外の応答')
      // 1件目で止まり、2件目は送らない。
      expect(backend.approveCalls()).toHaveLength(1)
      // 結果不明なので、画面が一覧を取り直せるよう通知する。
      expect(onSaved).toHaveBeenCalledTimes(1)
    })

    it('POSTの応答のIDが、送ったIDと違うときは、保存できたとしない', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(first.id), () =>
        json({ version: 1, learning: { ...first, id: 'learning-someone-else' } }),
      )
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [first.id] })
    })

    it.each([
      ['期待した版+1より小さい', 2],
      ['期待した版+1より大きい', 9],
    ])('POSTの応答の版が%s：保存できたとしない', async (_name, version) => {
      // 版3の保存済みの内容を確認した上で、内容を変えて保存する（期待する新しい版は4）。
      const edited = { ...first, content: '休憩を増やしたい' }
      const backend = backendWith(entry(first, 3))
      const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      expect(await store.save([first])).toEqual({ ok: true })
      backend.intercept(isApprove(first.id), () => json({ version, learning: edited }))
      const result = await store.save([edited])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [first.id] })
    })

    it('POSTの応答の版が、期待した版+1ちょうどなら、保存できたと確認する', async () => {
      const edited = { ...first, content: '休憩を増やしたい' }
      const backend = backendWith(entry(first, 3))
      const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      expect(await store.save([first])).toEqual({ ok: true })
      expect(await store.save([edited])).toEqual({ ok: true })
      expect(backend.account(A).learnings.get(first.id)).toMatchObject({ version: 4 })
    })

    it('不正なPOST応答でも、サーバーが送った内容どおりに確定していれば、取り直した一覧で保存済みと照合する', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(first.id), ({ proceed }) => {
        proceed()
        return json({ version: 9, learning: first })
      })
      expect(
        await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([first]),
      ).toEqual({ ok: true })
    })

    it('事前の一覧で同じ内容だった学びが、処理中に撤回されたら、保存済みと断定しない', async () => {
      const backend = backendWith(entry(first, 2))
      // 2件目の送信の間に、別の端末が1件目の承認を撤回する。
      backend.intercept(isApprove(second.id), ({ proceed }) => {
        const response = proceed()
        backend.account(A).learnings.delete(first.id)
        return response
      })
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
        second,
      ])
      expect(result).toMatchObject({
        ok: false,
        savedIds: [second.id],
        unknownIds: [],
        retryable: false,
      })
      if (!result.ok) {
        expect(result.message).toContain('1件は保存済みです')
        expect(result.message).toContain('変更または撤回')
      }
    })

    it('保存後の取り直しで、別の端末の更新が見つかったときも、保存済みと断定しない', async () => {
      const backend = backendWith(entry(first, 2))
      backend.intercept(isApprove(second.id), ({ proceed }) => {
        const response = proceed()
        backend.account(A).learnings.set(first.id, {
          version: 3,
          learning: { ...first, content: '別の端末で書き換えた内容' },
        })
        return response
      })
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
        second,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [second.id] })
    })

    it('保存後の取り直しに失敗したとき、POSTの応答で確認できた学びは保存済み、事前の一覧だけの学びは結果不明', async () => {
      const backend = backendWith(entry(first, 2))
      let lists = 0
      backend.intercept(
        (call) => isListLearnings(call) && ++lists === 2,
        () => {
          throw new TypeError('offline')
        },
        { always: true },
      )
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
        second,
      ])
      expect(result).toMatchObject({
        ok: false,
        savedIds: [second.id],
        unknownIds: [first.id],
      })
      if (!result.ok) expect(result.message).toContain('保存後の確認ができませんでした')
    })

    it('POSTの応答で確認できていれば、保存後の取り直しに失敗しても成功', async () => {
      const backend = backendWith()
      let lists = 0
      backend.intercept(
        (call) => isListLearnings(call) && ++lists === 2,
        () => {
          throw new TypeError('offline')
        },
        { always: true },
      )
      expect(
        await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([first]),
      ).toEqual({ ok: true })
    })

    it('事前一覧に同じ内容があっても、保存済みとする前に取り直して撤回を検出する', async () => {
      const backend = backendWith(entry(first, 2))
      const onSaved = vi.fn()
      let lists = 0
      backend.intercept(
        (call) => isListLearnings(call) && ++lists === 2,
        () => {
          // 別端末が事前一覧の取得後に撤回した状態を返す。
          backend.account(A).learnings.delete(first.id)
          return json({
            learnings: [],
            listInfo: { returned: 0, skippedInvalid: 0, truncated: false },
          })
        },
        { always: true },
      )
      const result = await createFirestoreLearningStore(scope, onSaved, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({
        ok: false,
        savedIds: [],
        unknownIds: [],
        retryable: false,
      })
      if (!result.ok) expect(result.message).toContain('変更または撤回')
      expect(lists).toBe(2)
      expect(backend.approveCalls()).toHaveLength(0)
      expect(onSaved).toHaveBeenCalledOnce()
    })

    it('一覧の返却件数と実際の件数が食い違うときは、書き込みの根拠にしない', async () => {
      const backend = backendWith(entry(first, 1))
      backend.intercept(isListLearnings, () =>
        json({
          learnings: [entry(first, 1)],
          listInfo: { returned: 2, skippedInvalid: 0, truncated: false },
        }),
      )
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        second,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [] })
      expect(backend.approveCalls()).toHaveLength(0)
    })

    it('保存済み一覧に同じIDが複数あるときは、内容が一致しても保存済みと判定しない', async () => {
      const backend = backendWith(entry(first, 1))
      backend.intercept(isListLearnings, () =>
        json({
          learnings: [entry(first, 1), entry(first, 1)],
          listInfo: { returned: 2, skippedInvalid: 0, truncated: false },
        }),
      )

      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])

      expect(result).toMatchObject({ ok: false })
      expect(backend.approveCalls()).toHaveLength(0)
    })

    it('保存後の一覧の件数が食い違うときは、確認できたことにしない', async () => {
      const backend = backendWith(entry(first, 2))
      let lists = 0
      backend.intercept(
        (call) => isListLearnings(call) && ++lists === 2,
        ({ proceed }) => {
          const body = (proceed() as Response).clone()
          return body
            .json()
            .then((value: { learnings: unknown[] }) =>
              json({ ...value, listInfo: { returned: 9, skippedInvalid: 0, truncated: false } }),
            )
        },
        { always: true },
      )
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
        second,
      ])
      // 2件目はPOSTの応答で確認できた。1件目は事前の一覧だけなので、結果不明。
      expect(result).toMatchObject({ ok: false, savedIds: [second.id], unknownIds: [first.id] })
    })
  })

  describe('別端末との版の競合', () => {
    it('一度確認した版が別端末で変更されたら古い内容で上書きしない', async () => {
      const edited = { ...first, content: '休憩を増やしたい' }
      const backend = backendWith(entry(first, 4))
      const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      expect(await store.save([first])).toEqual({ ok: true })
      backend.account(A).learnings.set(first.id, {
        version: 5,
        learning: { ...first, content: '別端末で更新した文章' },
      })
      const result = await store.save([edited])
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(backend.approveCalls()).toHaveLength(0)
    })

    it('取得とPOSTの間に別端末が更新したら、サーバーの版の検査で止まり、上書きしない', async () => {
      const edited = { ...first, content: '休憩を増やしたい' }
      const backend = backendWith(entry(first, 4))
      const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      expect(await store.save([first])).toEqual({ ok: true })
      backend.intercept(isApprove(first.id), () => {
        backend.account(A).learnings.set(first.id, {
          version: 5,
          learning: { ...first, content: '別端末で更新した文章' },
        })
      })
      const result = await store.save([edited])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [], retryable: false })
      if (!result.ok) expect(result.message).toContain('再読み込み')
      expect(backend.account(A).learnings.get(first.id)).toMatchObject({
        version: 5,
        learning: { content: '別端末で更新した文章' },
      })
    })

    it('初めて見た既存IDの内容を、本人確認なく上書きしない', async () => {
      const different = { ...first, content: '別の内容へ更新したい' }
      const backend = backendWith(entry(first, 4))
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        different,
      ])
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(backend.calls).toHaveLength(1)
    })
  })

  describe('認証セッションとの結び付き', () => {
    it('保存の途中でUIDが変わったら、残りは送らず、新しいUIDのトークンでは何も送らない', async () => {
      const backend = createFakeBackend({ [A]: {}, [B]: {} })
      // 1件目のPOSTはサーバーで保存済みだが、応答を採用する前にUIDが変わる。
      backend.intercept(isApprove(first.id), ({ proceed }) => {
        const response = proceed()
        fakeAuth.switchSilently(B)
        return response
      })
      const onSaved = vi.fn()
      const result = await createFirestoreLearningStore(scope, onSaved, backend.fetchFn).save([
        first,
        second,
        third,
      ])
      expect(result).toMatchObject({
        ok: false,
        savedIds: [],
        unknownIds: [first.id],
        retryable: false,
      })
      if (!result.ok) {
        expect(result.message).toContain('セッションが変わったため保存を中止しました')
        expect(result.message).toContain('結果不明')
      }
      expect(backend.approveCalls()).toHaveLength(1)
      // 新しいUIDのトークンでは、何も送っていない。
      expect(backend.calls.some((call) => call.uid === B)).toBe(false)
      expect(backend.account(B).learnings.size).toBe(0)
      expect(backend.account(A).learnings.has(first.id)).toBe(true)
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('保存後の一覧取得中にA→B→Aへ切り替わったら成功にせず、一覧更新通知もしない', async () => {
      const backend = backendWith()
      let lists = 0
      backend.intercept(
        (call) => isListLearnings(call) && ++lists === 2,
        ({ proceed }) => {
          const response = proceed()
          fakeAuth.switchSilently(B)
          fakeAuth.signInAs(A)
          return response
        },
        { always: true },
      )
      const onSaved = vi.fn()

      const result = await createFirestoreLearningStore(scope, onSaved, backend.fetchFn).save([
        first,
      ])

      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [first.id] })
      if (!result.ok) expect(result.message).toContain('結果不明')
      expect(backend.account(A).learnings.has(first.id)).toBe(true)
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('最初の取得の前にUIDが変わっていたら、何も送らない', async () => {
      const backend = createFakeBackend({ [A]: {}, [B]: {} })
      fakeAuth.signInAs(B)
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [], retryable: false })
      if (!result.ok) expect(result.message).toContain('セッションが変わったため保存を中止しました')
      expect(backend.fetchFn).not.toHaveBeenCalled()
    })

    it('異なるUIDに同じ学びIDがあっても、保存先の版と内容を混同しない', async () => {
      const backend = createFakeBackend({
        [A]: { learnings: [entry({ ...first, content: 'Aの学び' }, 3)] },
        [B]: { learnings: [entry({ ...first, content: 'Bの学び' }, 7)] },
      })
      const storeA = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      // Aの版を確認した後、Bの画面で同じIDを保存しようとしても、Aの版は使われない。
      expect(await storeA.save([{ ...first, content: 'Aの学び' }])).toEqual({ ok: true })
      fakeAuth.signInAs(B)
      const storeB = createFirestoreLearningStore(
        await captureSessionScope(),
        undefined,
        backend.fetchFn,
      )
      const result = await storeB.save([{ ...first, content: 'Bの新しい内容' }])
      // Bの学びは、Bの画面で確認した覚えがないので、上書きしない。
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(backend.approveCalls()).toHaveLength(0)
      expect(backend.account(B).learnings.get(first.id)).toMatchObject({ version: 7 })
      expect(backend.account(A).learnings.get(first.id)).toMatchObject({ version: 3 })
    })

    it('認証が使えない（セッション終了）ときは、何も送らず、認証の案内を示す。匿名UIDを作らない', async () => {
      const backend = backendWith()
      fakeAuth.endSession()
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [], retryable: false })
      if (!result.ok) {
        expect(result.message).toContain('認証')
        expect(result.message).not.toContain('結果不明')
      }
      expect(backend.fetchFn).not.toHaveBeenCalled()
      expect(fakeAuth.client.startNewAnonymousSession).not.toHaveBeenCalled()
    })
  })

  describe('保存できない理由に合わせた案内', () => {
    const failWith = async (code: string, message: string, status: number) => {
      const backend = backendWith()
      backend.intercept(isApprove(), () => failure(status, code, message), { always: true })
      return createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([first])
    }

    it('版の食い違い（409）：再読み込みを案内し、承認と入力が消えることも伝える', async () => {
      const result = await failWith('version_conflict', '版が一致しません', 409)
      expect(result).toMatchObject({ ok: false, retryable: false, savedIds: [] })
      if (!result.ok) {
        expect(result.message).toContain('再読み込み')
        expect(result.message).toContain('消えます')
      }
    })

    it.each([
      [409, 'revision_report_changed'],
      [409, 'revision_proposal_expired'],
      [422, 'revision_unverified'],
    ] as const)('確定した修正拒否 %s %s は結果不明にしない', async (status, code) => {
      const result = await failWith(code, 'server detail', status)
      expect(result).toMatchObject({ ok: false, unknownIds: [] })
    })
    it('HTTP 502とversion_conflictの不整合応答は、確定拒否にせず結果不明にする', async () => {
      const result = await failWith('version_conflict', '版が一致しません', 502)

      expect(result).toMatchObject({
        ok: false,
        savedIds: [],
        unknownIds: [first.id],
        retryable: true,
      })
      if (!result.ok) {
        expect(result.message).toContain('保存サービスに接続できませんでした')
        expect(result.message).not.toContain('版が一致しません')
      }
    })

    it('同じIDがすでにある（409）：再読み込みを案内する', async () => {
      const result = await failWith('already_exists', '同じIDがあります', 409)
      expect(result).toMatchObject({ ok: false, retryable: false })
      if (!result.ok) expect(result.message).toContain('再読み込み')
    })

    it('件数の上限（409）：保存できない理由を言い切り、再読み込みも再試行も案内しない', async () => {
      const result = await failWith('storage_limit_reached', '上限です', 409)
      expect(result).toMatchObject({ ok: false, retryable: false, savedIds: [] })
      if (!result.ok) {
        expect(result.message).toContain('上限に達している')
        expect(result.message).toContain('結果は変わりません')
        expect(result.message).not.toContain('再読み込み')
      }
    })

    it('撤回済みの学び（409）：保存できない理由と、候補を作り直す案内を示す', async () => {
      const result = await failWith('learning_revoked', '撤回済みです', 409)
      expect(result).toMatchObject({ ok: false, retryable: false })
      if (!result.ok) {
        expect(result.message).toContain('撤回済み')
        expect(result.message).toContain('作り直して')
        expect(result.message).not.toContain('再読み込み')
      }
    })

    it('保存サービスの停止（503 persistence_disabled）：定型文言を使い、未保存・再試行できるものとして扱う', async () => {
      const result = await failWith('persistence_disabled', 'サーバーの文言', 503)
      expect(result).toMatchObject({ ok: false, retryable: true, unknownIds: [] })
      if (!result.ok) {
        expect(result.message).toContain('保存機能は現在利用できません')
        expect(result.message).not.toContain('サーバーの文言')
        expect(result.message).not.toContain('認証')
      }
    })

    it('認証基盤の障害（503 auth_unavailable）は、保存先の障害とは別の文言で、未保存として扱う', async () => {
      const result = await failWith('auth_unavailable', 'サーバーの文言', 503)
      expect(result).toMatchObject({ ok: false, retryable: true, unknownIds: [] })
      if (!result.ok) {
        expect(result.message).toContain('認証サービスを利用できません')
        expect(result.message).not.toContain('保存サービス')
      }
    })

    it('認証の失効（401）：定型文言を使い、成功とも再読み込みの案内ともしない', async () => {
      const result = await failWith('session_revoked', '認証を継続できません', 401)
      expect(result).toMatchObject({ ok: false, retryable: true, unknownIds: [] })
      if (!result.ok) {
        expect(result.message).toBe('認証を継続できません。再認証が必要です')
        expect(result.message).not.toContain('再読み込み')
      }
    })

    it('入力が受け付けられない（400）：同じ内容での再試行は案内しない', async () => {
      const result = await failWith('invalid_request', 'サーバーの文言', 400)
      expect(result).toMatchObject({ ok: false, retryable: false, unknownIds: [] })
    })

    it('未知のコードの本文は見せず、結果不明として扱う', async () => {
      const result = await failWith('weird_secret', 'path /users/abc/learnings', 500)
      expect(result).toMatchObject({ ok: false, unknownIds: [first.id] })
      if (!result.ok) expect(result.message).not.toContain('/users/abc')
    })

    it.each(['constructor', '__proto__', 'toString'])(
      'サーバーが返したコードが「%s」でも、継承されたプロパティを文言に使わない',
      async (code) => {
        const result = await failWith(code, 'path /users/abc/learnings', 500)
        expect(result).toMatchObject({ ok: false, unknownIds: [first.id], retryable: true })
        if (!result.ok) {
          expect(result.message).not.toContain('function')
          expect(result.message).toContain('取得・更新できませんでした')
        }
      },
    )

    it('JSONではない503（プロキシのHTML）でも、想定外の応答ではなく保存停止の案内を使う', async () => {
      const backend = backendWith()
      backend.intercept(isApprove(), () => html(503), { always: true })
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) {
        expect(result.message).toContain('保存機能は現在利用できません')
        expect(result.message).not.toContain('想定外')
      }
    })
  })

  describe('誤った保存を防ぐ検査', () => {
    it('承認された学びが0件なら、通信しない', async () => {
      const fetchFn = vi.fn()
      const result = await createFirestoreLearningStore(scope, undefined, fetchFn).save([])
      expect(result).toMatchObject({ ok: false })
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('同じIDの学びが重複して渡されたら、通信しない', async () => {
      const fetchFn = vi.fn()
      const result = await createFirestoreLearningStore(scope, undefined, fetchFn).save([
        first,
        { ...first, content: '別の内容' },
      ])
      expect(result).toMatchObject({ ok: false })
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('承認済みの形式ではない学び（本人の承認がない）は、通信しない', async () => {
      const fetchFn = vi.fn()
      const notApproved = { ...first, approval: { status: 'pending' } }
      const result = await createFirestoreLearningStore(scope, undefined, fetchFn).save([
        notApproved as unknown as typeof first,
      ])
      expect(result).toMatchObject({ ok: false })
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('保存済みの一覧が不完全（読み取れない項目あり）なら、新しい書き込みを行わない', async () => {
      const backend = backendWith()
      backend.intercept(isListLearnings, () =>
        json({ learnings: [], listInfo: { ...listInfo, skippedInvalid: 1 } }),
      )
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false })
      expect(backend.calls).toHaveLength(1)
    })

    it('保存済みの一覧が打ち切られているときも、新しい書き込みを行わない', async () => {
      const backend = backendWith()
      backend.intercept(isListLearnings, () =>
        json({ learnings: [], listInfo: { ...listInfo, truncated: true } }),
      )
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false })
      expect(backend.calls).toHaveLength(1)
    })

    it('別の旅程で使われている学びIDと重複したら、書き込まない', async () => {
      const backend = backendWith(entry({ ...first, sourceTripId: 'trip-someone-else' }, 2))
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false, retryable: false, savedIds: [] })
      if (!result.ok) expect(result.message).toContain('別の旅行で使われている')
      expect(backend.calls).toHaveLength(1)
    })

    it('同じIDで分類（category）が違う学びとも、書き込まない', async () => {
      const backend = backendWith(entry({ ...first, category: 'verification' }, 2))
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      // 版の食い違いではなく、別の学びとのIDの重複として止める。
      expect(result).toMatchObject({ ok: false, retryable: false })
      if (!result.ok) expect(result.message).toContain('別の旅行で使われている')
      expect(backend.calls).toHaveLength(1)
    })

    it('同時に2回の保存を始めない（二重送信の防止）', async () => {
      const backend = backendWith()
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      backend.intercept(isListLearnings, async () => {
        await held
      })
      const store = createFirestoreLearningStore(scope, undefined, backend.fetchFn)
      const running = store.save([first])
      const duplicate = await store.save([first])
      expect(duplicate).toMatchObject({ ok: false, retryable: true })
      if (!duplicate.ok) expect(duplicate.message).toContain('前の保存がまだ終わっていません')
      release()
      expect(await running).toEqual({ ok: true })
      // 2回目は、通信を始めていない（取得・承認・取り直しの3回だけ）。
      expect(backend.calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET'])
      // 終わった後は、また保存できる。
      expect(await store.save([first])).toEqual({ ok: true })
    })

    it('通信の応答を受けた直後に中止されたら、その応答を保存済みに数えず、結果不明にして、残りも送らない', async () => {
      const controller = new AbortController()
      const onSaved = vi.fn()
      const backend = backendWith(entry(second, 1))
      backend.intercept(isApprove(first.id), ({ proceed }) => {
        proceed()
        controller.abort()
        return jsonResponse({ version: 1, learning: first })
      })
      const result = await createFirestoreLearningStore(scope, onSaved, backend.fetchFn).save(
        [first, second],
        { signal: controller.signal },
      )
      // 2件目は事前の一覧で同じ内容だが、送信が中止された後の確認はできない。
      expect(result).toMatchObject({ ok: false, unknownIds: [first.id] })
      if (!result.ok) expect(result.message).toContain('通信に失敗しました')
      expect(backend.approveCalls()).toHaveLength(1)
    })

    it('通信が要らない項目の処理でも中止を確認し、中止後に成功を返さない', async () => {
      // 一覧の取得（通信の前後の確認）を通り抜けたあと、最初の項目の処理で中止に切り替わる信号。
      const controller = new AbortController()
      const signal = controller.signal
      let reads = 0
      const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
      Object.defineProperty(signal, 'aborted', {
        configurable: true,
        get() {
          reads += 1
          if (reads >= 4) controller.abort()
          return readAborted?.call(signal) ?? false
        },
      })
      const backend = backendWith(entry(first, 1))
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save(
        [first],
        { signal },
      )
      expect(result).toMatchObject({ ok: false, savedIds: [] })
      if (!result.ok) expect(result.message).toContain('通信に失敗しました')
    })

    it('送信前に中止されたら、何も書き込まない（結果不明にもしない）', async () => {
      const controller = new AbortController()
      const backend = backendWith()
      backend.intercept(isListLearnings, ({ proceed }) => {
        const response = proceed()
        controller.abort()
        return response
      })
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save(
        [first],
        { signal: controller.signal },
      )
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [] })
      expect(backend.approveCalls()).toHaveLength(0)
    })
  })
})

describe('レビュー指摘の回帰：一覧の一意性・ステータスとコードの整合・認証世代', () => {
  it('保存前の一覧に同じIDの学びが2件あるときは、書き込みの根拠にせず、何も送らない', async () => {
    const backend = backendWith()
    backend.intercept(isListLearnings, () =>
      json({
        learnings: [entry(first, 1), entry(first, 2)],
        listInfo: { returned: 2, skippedInvalid: 0, truncated: false },
      }),
    )
    const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
      second,
    ])
    expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [] })
    expect(backend.approveCalls()).toHaveLength(0)
  })

  it('保存後の一覧にIDの重複があるときは、取り直した一覧で保存済みと照合しない（結果不明のまま）', async () => {
    const backend = backendWith()
    backend.intercept(isApprove(first.id), () => {
      throw new TypeError('offline')
    })
    let lists = 0
    backend.intercept(
      (call) => isListLearnings(call) && ++lists === 2,
      ({ proceed }) => {
        proceed()
        return json({
          learnings: [entry(first, 1), entry(first, 1)],
          listInfo: { returned: 2, skippedInvalid: 0, truncated: false },
        })
      },
      { always: true },
    )
    const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
      first,
    ])
    expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [first.id] })
  })

  it.each([
    [502, 'version_conflict'],
    [500, 'learning_revoked'],
    [409, 'storage_unavailable'],
    [200 + 201, 'invalid_request'],
  ])(
    'ステータス%iとコード%sが矛盾する応答からは、保存されなかったと確定しない（結果不明）',
    async (status, code) => {
      const backend = backendWith()
      backend.intercept(isApprove(first.id), () => failure(status, code, 'サーバーの文言'))
      const result = await createFirestoreLearningStore(scope, undefined, backend.fetchFn).save([
        first,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [first.id] })
    },
  )

  it('保存後の取り直しが通信断で失敗し、その間に認証世代が変わったときは、全件成功と断定しない', async () => {
    const backend = backendWith()
    let lists = 0
    backend.intercept(
      (call) => isListLearnings(call) && ++lists === 2,
      ({ proceed }) => {
        proceed()
        // A→B→A。同じUIDでも別の認証世代。
        fakeAuth.switchSilently(B)
        fakeAuth.signInAs(A)
        throw new TypeError('offline')
      },
      { always: true },
    )
    const onSaved = vi.fn()
    const result = await createFirestoreLearningStore(scope, onSaved, backend.fetchFn).save([first])
    expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [first.id] })
    expect(backend.account(A).learnings.has(first.id)).toBe(true)
    // 古い世代の保存からは、一覧更新の通知をしない。
    expect(onSaved).not.toHaveBeenCalled()
  })
})

// 保存できる旅程：版0・適用記録なし。
const savableTrip = TripSchema.parse({ ...sampleTrip, learningApplications: [] })

describe('旅程の保存（POST /api/trips）', () => {
  it('本人のBearerとApp Checkで保存し、保存先が返した旅程を返す', async () => {
    const backend = createFakeBackend({ [A]: {} })
    vi.stubGlobal('fetch', backend.fetchFn)

    const saved = await saveTrip(scope, savableTrip)

    expect(saved.id).toBe(savableTrip.id)
    const [call] = backend.calls
    expect(call).toMatchObject({ method: 'POST', path: '/api/trips', uid: A })
    expect(backend.account(A).trips.map((trip) => trip.id)).toEqual([savableTrip.id])
    const init = backend.fetchFn.mock.calls[0][1]
    expect(new Headers(init?.headers).get('X-Firebase-AppCheck')).toBe(APP_CHECK_TOKEN)
    vi.unstubAllGlobals()
  })

  it('学びを使って作った旅程（適用記録あり）は、送らずに保存できない理由を返す', async () => {
    const backend = createFakeBackend({ [A]: {} })
    vi.stubGlobal('fetch', backend.fetchFn)

    await expect(saveTrip(scope, sampleTrip)).rejects.toMatchObject({
      code: TRIP_NOT_SAVABLE_CODE,
      outcome: 'not_sent',
    })
    expect(backend.calls).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('現地での変更を反映した旅程（版が1以上）は、送らずに保存できない理由を返す', async () => {
    const backend = createFakeBackend({ [A]: {} })
    vi.stubGlobal('fetch', backend.fetchFn)

    await expect(saveTrip(scope, { ...savableTrip, version: 1 })).rejects.toThrow(
      /現地での変更を反映した旅程/,
    )
    expect(backend.calls).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('送信後に応答を失ったときは「結果不明」とし、再送しない', async () => {
    const backend = createFakeBackend({ [A]: {} })
    backend.intercept(
      (call) => call.method === 'POST',
      ({ proceed }) => {
        proceed()
        throw new TypeError('offline')
      },
    )
    vi.stubGlobal('fetch', backend.fetchFn)

    await expect(saveTrip(scope, savableTrip)).rejects.toMatchObject({ outcome: 'unknown' })
    expect(backend.calls).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('同じIDがすでにある（409）ときは、サーバーが何も変更せず拒否した扱い', async () => {
    const backend = createFakeBackend({ [A]: { trips: [savableTrip] } })
    vi.stubGlobal('fetch', backend.fetchFn)

    await expect(saveTrip(scope, savableTrip)).rejects.toMatchObject({
      status: 409,
      outcome: 'rejected',
    })
    vi.unstubAllGlobals()
  })

  it('別のUIDに切り替わった後は、古いセッションの旅程を送らない', async () => {
    const backend = createFakeBackend({ [A]: {}, [B]: {} })
    vi.stubGlobal('fetch', backend.fetchFn)
    fakeAuth.signInAs(B)

    await expect(saveTrip(scope, savableTrip)).rejects.toBeInstanceOf(SessionChangedError)
    expect(backend.calls).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})
