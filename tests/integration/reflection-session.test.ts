import '../helpers/mock-cost-control'

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as approveLearning } from '@/app/api/learnings/[learningId]/approve/route'
import { DELETE as revokeLearning } from '@/app/api/learnings/[learningId]/route'
import { GET as listLearnings } from '@/app/api/learnings/route'
import { GET as listRevisions } from '@/app/api/trips/[tripId]/revisions/route'
import { GET as getTrip } from '@/app/api/trips/[tripId]/route'
import { GET as listTrips, POST as createTrip } from '@/app/api/trips/route'
import { sampleApprovedLearning, sampleTrip } from '@/domain/samples'
import { captureSessionScope } from '@/lib/auth/session-scope'
import { LearningListResponseSchema } from '@/server/persistence/contracts'
import { createFirestoreLearningStore } from '@/features/reflection-flow/api-client'

import { fakeAuth } from '../helpers/fake-auth-client'

// 認証クライアントだけを差し替える（IDトークンは、Auth Emulatorが発行した本物を使う）。
// 保存API（Route Handlers）・Firestore Emulator・セッションスコープ・保存ポートは、すべて本物。
vi.mock('@/lib/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/client')>()
  const { fakeAuth: fake } = await import('../helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

const apps: FirebaseApp[] = []
let sequence = 0

interface Session {
  uid: string
  token: string
  request: (method?: string, body?: unknown, query?: string) => Request
}

async function createSession(label: string): Promise<Session> {
  sequence += 1
  const app = initializeApp(
    { projectId: 'demo-groundtrip', apiKey: 'demo-api-key' },
    `reflection-${label}-${sequence}`,
  )
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const { user } = await signInAnonymously(auth)
  const token = await user.getIdToken()
  return {
    uid: user.uid,
    token,
    request(method = 'GET', body?: unknown, query = '') {
      return new Request(`http://localhost/api${query}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
  }
}

const context = <T>(params: T) => ({ params: Promise.resolve(params) })
const learningOf = (id: string, content: string, tripId: string) => ({
  ...sampleApprovedLearning,
  id,
  sourceTripId: tripId,
  content,
})

interface Call {
  method: string
  path: string
  uid: string | undefined
  body: unknown
}
type Around = (call: Call, run: () => Promise<Response>) => Promise<Response>

// クライアントのfetchを、実際のRoute Handlersへつなぐ。割り込みで、応答の喪失・別端末の更新などを再現する。
function createServerFetch(sessions: Session[]) {
  const calls: Call[] = []
  const arounds: Array<{ match: (call: Call) => boolean; around: Around }> = []
  const uidOf = (header: string | null) =>
    sessions.find((session) => `Bearer ${session.token}` === header)?.uid

  async function dispatch(request: Request, call: Call): Promise<Response> {
    const url = new URL(request.url)
    let match: RegExpExecArray | null
    if (url.pathname === '/api/learnings') return listLearnings(request)
    if (url.pathname === '/api/trips') return listTrips(request)
    if ((match = /^\/api\/learnings\/([^/]+)\/approve$/.exec(url.pathname))) {
      return approveLearning(request, context({ learningId: decodeURIComponent(match[1]) }))
    }
    if ((match = /^\/api\/trips\/([^/]+)\/revisions$/.exec(url.pathname))) {
      return listRevisions(request, context({ tripId: decodeURIComponent(match[1]) }))
    }
    if ((match = /^\/api\/trips\/([^/]+)$/.exec(url.pathname))) {
      return getTrip(request, context({ tripId: decodeURIComponent(match[1]) }))
    }
    throw new Error('未対応のパス: ' + call.path)
  }

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const headers = new Headers(init?.headers)
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      uid: uidOf(headers.get('Authorization')),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    const request = new Request(url, {
      method: call.method,
      headers,
      ...(init?.body === undefined ? {} : { body: init.body }),
    })
    const index = arounds.findIndex((entry) => entry.match(call))
    if (index >= 0) {
      const [entry] = arounds.splice(index, 1)
      return entry.around(call, () => dispatch(request, call))
    }
    return dispatch(request, call)
  })

  return {
    fetchFn,
    calls,
    approves: () => calls.filter((call) => call.path.endsWith('/approve')),
    /** 条件に合う次のリクエストを、runを呼ぶ前後で加工する（1回だけ）。 */
    around(match: (call: Call) => boolean, around: Around) {
      arounds.push({ match, around })
    },
  }
}

const isApprove = (id: string) => (call: Call) =>
  call.method === 'POST' && call.path === `/api/learnings/${id}/approve`

let a: Session
let b: Session
let server: ReturnType<typeof createServerFetch>
const SHARED_TRIP = 'trip-shared'

async function listOf(session: Session) {
  const response = await listLearnings(session.request())
  return LearningListResponseSchema.parse(await response.json())
}

async function saveTripFor(session: Session, tripId = SHARED_TRIP) {
  const response = await createTrip(
    session.request('POST', { ...sampleTrip, id: tripId, learningApplications: [] }),
  )
  expect(response.status).toBe(201)
}

beforeEach(async () => {
  fakeAuth.reset()
  ;[a, b] = await Promise.all([createSession('a'), createSession('b')])
  const tokens: Record<string, string> = { [a.uid]: a.token, [b.uid]: b.token }
  fakeAuth.state.tokenFor = (uid) => tokens[uid]
  server = createServerFetch([a, b])
  // 2つのアカウントは、同じTrip IDの旅程を、それぞれ自分のデータとして持つ。
  await Promise.all([saveTripFor(a), saveTripFor(b)])
})

const scopeFor = async (uid: string) => {
  fakeAuth.signInAs(uid)
  return captureSessionScope()
}

afterAll(async () => {
  await Promise.all(apps.map(deleteApp))
})

describe('振り返りの保存：セッション・結果不明・競合（Firestore Emulator＋認証済みRoute Handlers）', () => {
  it('AとBに同じTrip IDと同じLearning IDがあっても、保存先の版と内容を混同しない', async () => {
    const storeA = createFirestoreLearningStore(await scopeFor(a.uid), undefined, server.fetchFn)
    expect(await storeA.save([learningOf('lrn-shared', 'Aの内容', SHARED_TRIP)])).toEqual({
      ok: true,
    })
    // Aの内容を更新して、版を2にする。
    expect(await storeA.save([learningOf('lrn-shared', 'Aの更新後の内容', SHARED_TRIP)])).toEqual({
      ok: true,
    })
    const storeB = createFirestoreLearningStore(await scopeFor(b.uid), undefined, server.fetchFn)
    // Bには同じIDの学びがまだ無い。Aの版（2）を使わず、Bの保存先の版（初回＝0）で保存できる。
    expect(await storeB.save([learningOf('lrn-shared', 'Bの内容', SHARED_TRIP)])).toEqual({
      ok: true,
    })

    const [listA, listB] = await Promise.all([listOf(a), listOf(b)])
    expect(listA.learnings).toMatchObject([
      { version: 2, learning: { content: 'Aの更新後の内容' } },
    ])
    expect(listB.learnings).toMatchObject([{ version: 1, learning: { content: 'Bの内容' } }])
    const bodies = server
      .approves()
      .map((call) => [call.uid, (call.body as { expectedVersion: number }).expectedVersion])
    expect(bodies).toEqual([
      [a.uid, 0],
      [a.uid, 1],
      [b.uid, 0],
    ])
  })

  it('Aのスコープのストアは、UIDがBに変わった後は何も送らず、Bの保存先に書き込まない', async () => {
    const storeA = createFirestoreLearningStore(await scopeFor(a.uid), undefined, server.fetchFn)
    fakeAuth.signInAs(b.uid)

    const result = await storeA.save([learningOf('lrn-a', 'Aの学び', SHARED_TRIP)])

    expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [], retryable: false })
    expect(server.fetchFn).not.toHaveBeenCalled()
    expect((await listOf(b)).learnings).toHaveLength(0)
    expect((await listOf(a)).learnings).toHaveLength(0)
  })

  it('保存中にUIDが変わっても、残りは送らず、Bのトークンでは何も書き込まない', async () => {
    const storeA = createFirestoreLearningStore(await scopeFor(a.uid), undefined, server.fetchFn)
    // 1件目の保存が終わった直後に、認証済みのUIDがBへ変わる。
    server.around(isApprove('lrn-1'), async (_call, run) => {
      const response = await run()
      fakeAuth.switchSilently(b.uid)
      return response
    })

    const result = await storeA.save([
      learningOf('lrn-1', '1件目', SHARED_TRIP),
      learningOf('lrn-2', '2件目', SHARED_TRIP),
      learningOf('lrn-3', '3件目', SHARED_TRIP),
    ])

    expect(result).toMatchObject({
      ok: false,
      savedIds: [],
      unknownIds: ['lrn-1'],
      retryable: false,
    })
    if (!result.ok) {
      expect(result.message).toContain('セッションが変わったため保存を中止しました')
    }
    // 送った承認は1件だけ。Bのトークンでは、何も送っていない。
    expect(server.approves().map((call) => call.path)).toEqual(['/api/learnings/lrn-1/approve'])
    expect(server.calls.some((call) => call.uid === b.uid)).toBe(false)
    expect((await listOf(a)).learnings.map((entry) => entry.learning.id)).toEqual(['lrn-1'])
    expect((await listOf(b)).learnings).toHaveLength(0)
  })

  it('サーバーが確定した後に応答だけを失っても、取り直した一覧で保存済みと照合でき、再送しない', async () => {
    const store = createFirestoreLearningStore(await scopeFor(a.uid), undefined, server.fetchFn)
    server.around(isApprove('lrn-2'), async (_call, run) => {
      // 書き込みは確定するが、応答は届かない。
      await run()
      throw new TypeError('offline')
    })

    const result = await store.save([
      learningOf('lrn-1', '1件目', SHARED_TRIP),
      learningOf('lrn-2', '2件目', SHARED_TRIP),
    ])

    expect(result).toEqual({ ok: true })
    expect(server.approves()).toHaveLength(2)
    expect((await listOf(a)).learnings.map((entry) => entry.learning.id).sort()).toEqual([
      'lrn-1',
      'lrn-2',
    ])
  })

  it('確定後の応答喪失で取り直しも失敗したら結果不明。確認して保存し直しても二重に保存しない', async () => {
    const store = createFirestoreLearningStore(await scopeFor(a.uid), undefined, server.fetchFn)
    server.around(isApprove('lrn-1'), async (_call, run) => {
      await run()
      throw new TypeError('offline')
    })
    // 保存の後の取り直し（2回目の一覧取得）も失敗する。
    let lists = 0
    const failSecondList = (call: Call) => call.path === '/api/learnings' && ++lists === 2
    server.around(failSecondList, async () => {
      throw new TypeError('offline')
    })

    const first = await store.save([learningOf('lrn-1', '1件目', SHARED_TRIP)])
    expect(first).toMatchObject({ ok: false, savedIds: [], unknownIds: ['lrn-1'], retryable: true })
    // サーバーは、実際には確定している。
    expect((await listOf(a)).learnings).toMatchObject([{ version: 1 }])

    const again = await store.save([learningOf('lrn-1', '1件目', SHARED_TRIP)])
    expect(again).toEqual({ ok: true })
    expect(server.approves()).toHaveLength(1)
    expect((await listOf(a)).learnings).toMatchObject([{ version: 1 }])
  })

  it('事前の一覧で保存済みだった学びが、保存の間に撤回されたら、保存済みと断定しない', async () => {
    const store = createFirestoreLearningStore(await scopeFor(a.uid), undefined, server.fetchFn)
    expect(await store.save([learningOf('lrn-1', '1件目', SHARED_TRIP)])).toEqual({ ok: true })
    // 2件目の保存の直前に、別の端末が1件目の承認を撤回する（版1）。
    server.around(isApprove('lrn-2'), async (_call, run) => {
      const revoked = await revokeLearning(
        a.request('DELETE', undefined, '/learnings/lrn-1?expectedVersion=1'),
        context({ learningId: 'lrn-1' }),
      )
      expect(revoked.status).toBe(204)
      return run()
    })

    const result = await store.save([
      learningOf('lrn-1', '1件目', SHARED_TRIP),
      learningOf('lrn-2', '2件目', SHARED_TRIP),
    ])

    expect(result).toMatchObject({
      ok: false,
      savedIds: ['lrn-2'],
      unknownIds: [],
      retryable: false,
    })
    if (!result.ok) expect(result.message).toContain('変更または撤回')
    expect((await listOf(a)).learnings.map((entry) => entry.learning.id)).toEqual(['lrn-2'])
  })

  it('別端末が学びを更新していたら、古い内容で上書きしない（取得時の版の不一致）', async () => {
    const store = createFirestoreLearningStore(await scopeFor(a.uid), undefined, server.fetchFn)
    expect(await store.save([learningOf('lrn-1', '最初の内容', SHARED_TRIP)])).toEqual({ ok: true })
    // 別の端末が、同じ学びを版1から更新する。
    const other = await approveLearning(
      a.request('POST', {
        expectedVersion: 1,
        sourceTripId: SHARED_TRIP,
        category: sampleApprovedLearning.category,
        content: '別端末の内容',
        scope: sampleApprovedLearning.scope,
      }),
      context({ learningId: 'lrn-1' }),
    )
    expect(other.status).toBe(200)
    const approvesBefore = server.approves().length

    const result = await store.save([learningOf('lrn-1', 'この画面で直した内容', SHARED_TRIP)])

    expect(result).toMatchObject({ ok: false, retryable: false })
    expect(server.approves()).toHaveLength(approvesBefore)
    expect((await listOf(a)).learnings).toMatchObject([
      { version: 2, learning: { content: '別端末の内容' } },
    ])
  })

  it('取得とPOSTの間に別端末が更新したら、サーバーの版の検査で止まり、上書きしない。取得時の版は#53の版付き契約どおり', async () => {
    const store = createFirestoreLearningStore(await scopeFor(a.uid), undefined, server.fetchFn)
    expect(await store.save([learningOf('lrn-1', '最初の内容', SHARED_TRIP)])).toEqual({ ok: true })
    server.around(isApprove('lrn-1'), async (_call, run) => {
      await approveLearning(
        a.request('POST', {
          expectedVersion: 1,
          sourceTripId: SHARED_TRIP,
          category: sampleApprovedLearning.category,
          content: '別端末の内容',
          scope: sampleApprovedLearning.scope,
        }),
        context({ learningId: 'lrn-1' }),
      )
      return run()
    })

    const result = await store.save([learningOf('lrn-1', 'この画面で直した内容', SHARED_TRIP)])

    // 画面は、GET /api/learnings の version（1）を期待版として送った。サーバーは版2で、409 version_conflict。
    const sent = server.approves().at(-1)
    expect(sent?.body).toMatchObject({ expectedVersion: 1, content: 'この画面で直した内容' })
    expect(result).toMatchObject({ ok: false, savedIds: [], unknownIds: [], retryable: false })
    if (!result.ok) expect(result.message).toContain('再読み込み')
    expect((await listOf(a)).learnings).toMatchObject([
      { version: 2, learning: { content: '別端末の内容' } },
    ])
  })
})
