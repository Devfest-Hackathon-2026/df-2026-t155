import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning } from '@/domain/samples'
import { createSessionScope } from '@/lib/auth/session-scope'
import { MAX_LEARNING_CONTENT_LENGTH } from '@/lib/learnings/lifecycle'

import { loadApprovedLearningOptions } from './api-client'

// 既定の認証ヘッダー（getAuthHeadersForScope）の経路を、実際のsession-scope.tsのまま通すため、
// 土台のgetAuthSnapshotだけを差し替える。
const mocks = vi.hoisted(() => ({
  getAuthSnapshot: vi.fn(),
  session: { uid: 'user-a', generation: 0 },
  operations: new Set<{
    uid: string
    generation: number
    controller: AbortController
  }>(),
}))
vi.mock('@/lib/auth/client', () => ({
  getAuthSnapshot: mocks.getAuthSnapshot,
  isAuthSessionCurrent: (uid: string, generation: number) =>
    mocks.session.uid === uid && mocks.session.generation === generation,
  registerAuthSessionOperation: (uid: string, generation: number, controller: AbortController) => {
    if (mocks.session.uid !== uid || mocks.session.generation !== generation) return undefined
    const operation = { uid, generation, controller }
    mocks.operations.add(operation)
    return () => mocks.operations.delete(operation)
  },
}))

// 既定のヘッダー経路は実物の protected-api.ts を通し、App Check SDKとFirebase初期化だけを差し替える。
const appCheck = vi.hoisted(() => ({ getToken: vi.fn() }))
vi.mock('firebase/app-check', () => ({
  initializeAppCheck: () => ({}),
  getToken: appCheck.getToken,
  ReCaptchaEnterpriseProvider: class {},
}))
vi.mock('@/lib/firebase/client', () => ({ getClientAuth: () => ({ app: {} }) }))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY', 'test-site-key')
  appCheck.getToken.mockReset()
  appCheck.getToken.mockResolvedValue({ token: 'test.app.check' })
  for (const operation of mocks.operations) operation.controller.abort()
  mocks.operations.clear()
  mocks.session = { uid: 'user-a', generation: 0 }
  mocks.getAuthSnapshot.mockReset()
  mocks.getAuthSnapshot.mockResolvedValue({
    uid: 'user-a',
    token: 'token-of-a',
    generation: 0,
  })
})

const scopeA = createSessionScope('user-a', 0)
const switchSyncSession = (uid: string, generation: number) => {
  for (const operation of mocks.operations) operation.controller.abort()
  mocks.operations.clear()
  mocks.session = { uid, generation }
}
const headers = async () => new Headers({ Authorization: 'Bearer test-token' })
const payload = (learnings: unknown[] = [{ learning: sampleApprovedLearning, version: 1 }]) => ({
  learnings,
  listInfo: { returned: learnings.length, skippedInvalid: 0, truncated: false },
})
const load = (fetchFn: typeof fetch) =>
  loadApprovedLearningOptions({ scope: scopeA, fetchFn, getHeaders: headers })

describe('承認済みLearningの取得', () => {
  it('本人トークンを付け、完全な一覧を、取得したセッションと組にして返す', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const result = await load(fetchFn)
    expect(result).toMatchObject({
      ok: true,
      learnings: { scope: scopeA, value: [{ learning: sampleApprovedLearning, version: 1 }] },
    })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/learnings',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )
    // Authorizationの値そのもの（Headersの型だけでなく、本人のトークン）を送っていること。
    const init = fetchFn.mock.calls[0][1]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token')
  })

  it('保存済みの学びが0件でも、完全な空の一覧として受け付ける', async () => {
    const result = await load(async () => Response.json(payload([])))
    expect(result).toEqual({ ok: true, learnings: { scope: scopeA, value: [] } })
  })

  it('未認証ならAPIを呼ばない。匿名UIDを自動作成しない', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const result = await loadApprovedLearningOptions({
      scope: scopeA,
      fetchFn,
      getHeaders: async () => {
        throw new Error('session_ended')
      },
    })
    expect(result).toMatchObject({ ok: false, kind: 'session' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('不完全な一覧、重複ID、不正な承認状態を拒否する', async () => {
    const cases = [
      { ...payload(), listInfo: { returned: 1, skippedInvalid: 1, truncated: false } },
      { ...payload(), listInfo: { returned: 1, skippedInvalid: 0, truncated: true } },
      payload([
        { learning: sampleApprovedLearning, version: 1 },
        { learning: sampleApprovedLearning, version: 2 },
      ]),
      payload([
        { learning: { ...sampleApprovedLearning, approval: { status: 'pending' } }, version: 1 },
      ]),
    ]
    for (const item of cases) {
      const result = await load(async () => Response.json(item))
      expect(result).toMatchObject({ ok: false, kind: 'incomplete' })
    }
  })

  it('返却件数が実際の件数と一致しない一覧を拒否する', async () => {
    const mismatched = [
      { ...payload(), listInfo: { returned: 2, skippedInvalid: 0, truncated: false } },
      { ...payload(), listInfo: { returned: 0, skippedInvalid: 0, truncated: false } },
    ]
    for (const body of mismatched) {
      expect(await load(async () => Response.json(body))).toMatchObject({
        ok: false,
        kind: 'incomplete',
      })
    }
  })

  it('余分なキーや版のない項目を含む応答を、そのまま使わず拒否する', async () => {
    const extras = [
      { ...payload(), unexpected: true },
      { ...payload(), listInfo: { ...payload().listInfo, extra: 1 } },
      payload([{ learning: sampleApprovedLearning, version: 1, extra: 'x' }]),
      payload([{ learning: sampleApprovedLearning }]),
      payload([{ learning: sampleApprovedLearning, version: 0 }]),
      payload([{ learning: sampleApprovedLearning, version: 1.5 }]),
      payload([{ learning: sampleApprovedLearning, version: -1 }]),
    ]
    for (const body of extras) {
      expect(await load(async () => Response.json(body))).toMatchObject({
        ok: false,
        kind: 'incomplete',
      })
    }
  })

  it('JSONではない応答は、読み取れなかった失敗として返す', async () => {
    const result = await load(async () => new Response('<html>error</html>', { status: 200 }))
    expect(result).toMatchObject({ ok: false, kind: 'unexpected' })
  })

  it('500や想定外の状態は、空の一覧にせず失敗として返す', async () => {
    for (const status of [204, 404, 500]) {
      const result = await load(async () => new Response(null, { status }))
      expect(result).toMatchObject({ ok: false, kind: 'unexpected' })
    }
  })

  it('503と401と403は安全に表示できる失敗として返す', async () => {
    const unavailable = await load(async () => new Response(null, { status: 503 }))
    const session = await load(async () => new Response(null, { status: 401 }))
    const forbidden = await load(async () => new Response(null, { status: 403 }))
    expect(unavailable).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(session).toMatchObject({ ok: false, kind: 'session' })
    expect(forbidden).toMatchObject({ ok: false, kind: 'session' })
  })

  it('通信の失敗と、取得前の中断は、再試行できる失敗として返す', async () => {
    const offline = await load(async () => {
      throw new TypeError('network')
    })
    expect(offline).toMatchObject({ ok: false, kind: 'interrupted' })

    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const aborted = await loadApprovedLearningOptions({
      scope: scopeA,
      fetchFn,
      getHeaders: headers,
      signal: AbortSignal.abort(),
    })
    expect(aborted).toMatchObject({ ok: false, kind: 'interrupted' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('応答の本文を読んでいる間に中断された場合は、その応答を結果として返さない', async () => {
    const controller = new AbortController()
    const result = await loadApprovedLearningOptions({
      scope: scopeA,
      signal: controller.signal,
      getHeaders: headers,
      fetchFn: async () => {
        // 応答が届いた直後に、条件が変わって呼び出し側が中断した。
        queueMicrotask(() => controller.abort())
        return {
          status: 200,
          json: async () => {
            await Promise.resolve()
            return payload()
          },
        } as Response
      },
    })
    expect(result).toMatchObject({ ok: false, kind: 'interrupted' })
  })
})

describe('取得時の本文の長さ（サーバー採用・表示と同じ上限）', () => {
  const withContent = (length: number) => ({
    learning: { ...sampleApprovedLearning, content: 'あ'.repeat(length) },
    version: 1,
  })

  it('上限ちょうどの本文は受け付ける', async () => {
    const result = await load(async () =>
      Response.json(payload([withContent(MAX_LEARNING_CONTENT_LENGTH)])),
    )
    expect(result).toMatchObject({ ok: true })
  })

  it('上限を超える本文を含む一覧は、選べる形で返さず不完全な一覧として拒否する', async () => {
    const result = await load(async () =>
      Response.json(payload([withContent(MAX_LEARNING_CONTENT_LENGTH + 1)])),
    )
    expect(result).toMatchObject({ ok: false, kind: 'incomplete' })
  })

  it('一覧の一部だけが上限を超えていても、その一覧ごと使わない', async () => {
    const result = await load(async () =>
      Response.json(
        payload([
          { learning: sampleApprovedLearning, version: 1 },
          {
            learning: {
              ...sampleApprovedLearning,
              id: 'long-one',
              content: 'い'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1),
            },
            version: 1,
          },
        ]),
      ),
    )
    expect(result).toMatchObject({ ok: false, kind: 'incomplete' })
  })
})

describe('認証セッションとの結び付け', () => {
  it('既定では、取得するセッションのUIDと同じときだけ、そのトークンで取得する', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const result = await loadApprovedLearningOptions({ scope: scopeA, fetchFn })

    expect(result).toMatchObject({ ok: true, learnings: { scope: scopeA } })
    const init = fetchFn.mock.calls[0][1]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-of-a')
    // 保護APIなので、App Checkのトークンも同時に送る。
    expect(new Headers(init?.headers).get('x-firebase-appcheck')).toBe('test.app.check')
  })

  it('App Checkを用意できないときは、取得せず、設定不足として別の失敗で返す', async () => {
    appCheck.getToken.mockRejectedValue(new Error('recaptcha failed: secret-detail'))
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const result = await loadApprovedLearningOptions({ scope: scopeA, fetchFn })

    expect(result).toMatchObject({ ok: false, kind: 'app_check_unavailable' })
    expect(JSON.stringify(result)).not.toContain('secret-detail')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('サイトキーが無いときも送信しない', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY', '')
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const result = await loadApprovedLearningOptions({ scope: scopeA, fetchFn })

    expect(result).toMatchObject({ ok: false, kind: 'app_check_unavailable' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('429は利用制限として、401・403とは別の失敗で返す', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response('{"detail":"internal"}', { status: 429 }),
    )
    const result = await loadApprovedLearningOptions({ scope: scopeA, fetchFn })

    expect(result).toMatchObject({ ok: false, kind: 'rate_limited' })
    expect(JSON.stringify(result)).not.toContain('internal')
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('現在のUIDが取得するセッションと違えば、トークンを送らず取得もしない', async () => {
    mocks.getAuthSnapshot.mockResolvedValue({
      uid: 'user-b',
      token: 'token-of-b',
      generation: 1,
    })
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const result = await loadApprovedLearningOptions({ scope: scopeA, fetchFn })

    expect(result).toMatchObject({ ok: false, kind: 'session_changed' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('ヘッダー取得後・fetch直前のA→B→Aでは、古いscopeの要求を送らない', async () => {
    const headersReady = Promise.withResolvers<void>()
    const pendingHeaders = Promise.withResolvers<Headers>()
    const fetchFn = vi.fn<typeof fetch>()
    const resultPromise = loadApprovedLearningOptions({
      scope: scopeA,
      fetchFn,
      getHeaders: () => {
        headersReady.resolve()
        return pendingHeaders.promise
      },
    })

    await headersReady.promise
    pendingHeaders.resolve(new Headers({ Authorization: 'Bearer test-token' }))
    switchSyncSession('user-b', 1)
    switchSyncSession('user-a', 2)

    await expect(resultPromise).resolves.toMatchObject({ ok: false, kind: 'session_changed' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('認証境界はGET中の通信を同期中断し、応答を採用しない', async () => {
    let requestSignal: AbortSignal | null | undefined
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      requestSignal = init?.signal
      switchSyncSession('user-b', 1)
      switchSyncSession('user-a', 2)
      return Response.json(payload())
    })

    await expect(load(fetchFn)).resolves.toMatchObject({ ok: false, kind: 'session_changed' })
    expect(requestSignal?.aborted).toBe(true)
  })

  it('応答待ちの間に同じUIDへ再認証した場合、前世代の一覧を採用しない', async () => {
    mocks.getAuthSnapshot
      .mockResolvedValueOnce({ uid: 'user-a', token: 'token-of-a', generation: 0 })
      .mockResolvedValueOnce({ uid: 'user-a', token: 'token-of-a-new', generation: 2 })
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))

    const result = await loadApprovedLearningOptions({ scope: scopeA, fetchFn })

    expect(result).toMatchObject({ ok: false, kind: 'session_changed' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('セッションの失効・復元失敗は、UIDの変更とは別の失敗として返し、取得しない', async () => {
    mocks.getAuthSnapshot.mockRejectedValue(new Error('session_ended'))
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const result = await loadApprovedLearningOptions({ scope: scopeA, fetchFn })

    expect(result).toMatchObject({ ok: false, kind: 'session' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('ヘッダーの作成には、取得するセッションそのものを渡す', async () => {
    const getHeaders = vi.fn(headers)
    await loadApprovedLearningOptions({
      scope: scopeA,
      getHeaders,
      fetchFn: async () => Response.json(payload()),
    })
    expect(getHeaders).toHaveBeenCalledWith(scopeA)
  })
})
