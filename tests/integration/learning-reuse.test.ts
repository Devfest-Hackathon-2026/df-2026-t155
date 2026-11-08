import { deleteApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInAnonymously, signOut } from 'firebase/auth'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as approveLearning } from '@/app/api/learnings/[learningId]/approve/route'
import { DELETE as revokeLearning } from '@/app/api/learnings/[learningId]/route'
import { GET as listLearnings } from '@/app/api/learnings/route'
import { GET as getTrip } from '@/app/api/trips/[tripId]/route'
import { POST as createTrip } from '@/app/api/trips/route'
import { sampleApprovedLearning, sampleTrip } from '@/domain/samples'
import type { SessionScope, SessionScopeOperation } from '@/lib/auth/session-scope'
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase/admin'
import { MAX_LEARNING_CONTENT_LENGTH } from '@/lib/learnings/lifecycle'
import { resolveSelectedLearnings } from '@/server/learning-reuse/selection'
import { LearningListResponseSchema, TripResponseSchema } from '@/server/persistence/contracts'
import { toLearningDocument, toTripDocument } from '@/server/persistence/dto'
import { FirestoreLearningStore } from '@/server/persistence/learnings'

// 次回の旅への学びの再利用（#13）の、保存先・認証・サーバー側の解決を実際のEmulatorで確かめる。
// 画面側のセッション結び付けは、実クライアントの認証モジュールで確かめる。

const apps: FirebaseApp[] = []

async function createSession(name: string) {
  const app = initializeApp({ projectId: 'demo-groundtrip', apiKey: 'demo-api-key' }, name)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const { user } = await signInAnonymously(auth)
  const token = await user.getIdToken()
  return {
    uid: user.uid,
    headers: () => new Headers({ Authorization: `Bearer ${token}` }),
    request(method = 'GET', body?: unknown, query = '') {
      return new Request(`http://localhost/api${query}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
  }
}
type Session = Awaited<ReturnType<typeof createSession>>

const region = sampleTrip.region
const context = <T>(params: T) => ({ params: Promise.resolve(params) })
const store = new FirestoreLearningStore()
const allTrips = { kind: 'all_trips' } as const

async function saveTrip(session: Session, id: string) {
  const response = await createTrip(
    session.request('POST', { ...sampleTrip, id, learningApplications: [] }),
  )
  expect(response.status).toBe(201)
  return TripResponseSchema.parse(await response.json()).trip
}

// 本人が内容を確認して承認する（初回の期待版は0、再承認は取得した版）。
async function approve(
  session: Session,
  learningId: string,
  sourceTripId: string,
  content: string,
  expectedVersion = 0,
  scope: unknown = allTrips,
) {
  return approveLearning(
    session.request('POST', {
      sourceTripId,
      expectedVersion,
      content,
      category: 'preference',
      scope,
    }),
    context({ learningId }),
  )
}

async function revoke(session: Session, learningId: string, expectedVersion: number) {
  return revokeLearning(
    session.request('DELETE', undefined, `?expectedVersion=${expectedVersion}`),
    context({ learningId }),
  )
}

async function listedBy(session: Session) {
  const response = await listLearnings(session.request())
  expect(response.status).toBe(200)
  return LearningListResponseSchema.parse(await response.json())
}

// 画面のapi-clientの代わりに、同じ認証済みRoute Handlerへ取得リクエストを渡す。
const viaRoute: typeof fetch = async (_input, init) =>
  listLearnings(
    new Request('http://localhost/api/learnings', { method: 'GET', headers: init?.headers }),
  )

// These parser integration cases use an isolated Firebase App and inject its headers directly.
const isolatedSessionOperation = (
  scope: SessionScope,
  signal?: AbortSignal,
): SessionScopeOperation => {
  void scope
  return {
    signal: signal ?? new AbortController().signal,
    assertCurrent: () => {},
    dispose: () => {},
  }
}

async function codeOf(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: { code?: string }) => error.code,
  )
}

let a: Session
let b: Session
let tripA: { id: string }
let tripB: { id: string }

beforeAll(async () => {
  ;[a, b] = await Promise.all([createSession('reuse-a'), createSession('reuse-b')])
  ;[tripA, tripB] = await Promise.all([saveTrip(a, 'reuse-trip-a'), saveTrip(b, 'reuse-trip-b')])
})

afterAll(async () => {
  await Promise.all(apps.map(deleteApp))
})

describe('学びの選択の解決（Emulator・認証済みRoute・実Firestore）', () => {
  it('同じIDと版で本文だけ違う2人の学びは、それぞれのUIDでだけ自分の本文に解決される', async () => {
    expect((await approve(a, 'shared-learning', tripA.id, 'Aだけが見える本文')).status).toBe(200)
    expect((await approve(b, 'shared-learning', tripB.id, 'Bだけが見える本文')).status).toBe(200)

    const listA = (await listedBy(a)).learnings.find(
      ({ learning }) => learning.id === 'shared-learning',
    )
    const listB = (await listedBy(b)).learnings.find(
      ({ learning }) => learning.id === 'shared-learning',
    )
    expect(listA).toMatchObject({ version: 1, learning: { content: 'Aだけが見える本文' } })
    expect(listB).toMatchObject({ version: 1, learning: { content: 'Bだけが見える本文' } })

    // 同じ { id, version } の選択が、UIDによって別の本文に解決される。
    // Aが見た選択をBのトークンで送ると、Bの本文へ黙って置き換わる。画面側は選択を取得時の
    // セッションに結び付け、UIDが違えば送らない（下の「実クライアントの認証セッション切替」）。
    const selection = [{ id: 'shared-learning', version: 1 }]
    expect((await resolveSelectedLearnings(store, a.uid, region, selection))[0].content).toBe(
      'Aだけが見える本文',
    )
    expect((await resolveSelectedLearnings(store, b.uid, region, selection))[0].content).toBe(
      'Bだけが見える本文',
    )
  })

  it('一方だけが持つ学びのIDは、相手のUIDでは存在しない扱い（selection_changed）になる', async () => {
    await approve(a, 'only-a-learning', tripA.id, 'Aだけの学び')
    expect(
      await codeOf(
        resolveSelectedLearnings(store, b.uid, region, [{ id: 'only-a-learning', version: 1 }]),
      ),
    ).toBe('selection_changed')
  })

  it('同じUID内で再承認して版が進むと、古い版の選択は拒否し、一覧は新しい版と本文を返す', async () => {
    await approve(a, 'reapproved-learning', tripA.id, '最初の本文')
    expect(
      (
        await resolveSelectedLearnings(store, a.uid, region, [
          { id: 'reapproved-learning', version: 1 },
        ])
      )[0].content,
    ).toBe('最初の本文')

    expect((await approve(a, 'reapproved-learning', tripA.id, '再承認後の本文', 1)).status).toBe(
      200,
    )
    const current = (await listedBy(a)).learnings.find(
      ({ learning }) => learning.id === 'reapproved-learning',
    )
    expect(current).toMatchObject({ version: 2, learning: { content: '再承認後の本文' } })
    // 利用者が版1を見て選んでいた場合、本文が変わったことに気付かないまま使わない。
    expect(
      await codeOf(
        resolveSelectedLearnings(store, a.uid, region, [{ id: 'reapproved-learning', version: 1 }]),
      ),
    ).toBe('selection_changed')
    expect(
      (
        await resolveSelectedLearnings(store, a.uid, region, [
          { id: 'reapproved-learning', version: 2 },
        ])
      )[0].content,
    ).toBe('再承認後の本文')
  })

  it('撤回した学びは一覧に出ず、同じIDと過去の版では再選択できない。再承認もできない', async () => {
    await approve(a, 'revoked-learning', tripA.id, '撤回する学び')
    expect((await revoke(a, 'revoked-learning', 1)).status).toBe(204)

    expect(
      (await listedBy(a)).learnings.some(({ learning }) => learning.id === 'revoked-learning'),
    ).toBe(false)
    expect(
      await codeOf(
        resolveSelectedLearnings(store, a.uid, region, [{ id: 'revoked-learning', version: 1 }]),
      ),
    ).toBe('selection_changed')
    // 同じIDでの再承認は、古いリクエストによる復活を防ぐため拒否される。新しい学びは新しいIDで承認する。
    const again = await approve(a, 'revoked-learning', tripA.id, '同じIDで承認し直す', 0)
    expect(again.status).toBe(409)
    expect((await again.json()).error.code).toBe('learning_revoked')
  })

  it('サーバーが検証した後に学びが撤回されても、検証済みの値は変わらず、保存時の再検証は拒否できる', async () => {
    await approve(a, 'revoked-after-verify', tripA.id, '検証後に撤回される学び')
    const selection = [{ id: 'revoked-after-verify', version: 1 }]

    // 生成の入口: 検証済みの学びを、その時点のスナップショットとして受け取る。
    const snapshot = await resolveSelectedLearnings(store, a.uid, region, selection)
    expect(snapshot.map(({ content }) => content)).toEqual(['検証後に撤回される学び'])

    // 生成中（Gemini呼び出し中を想定）に撤回される。
    expect((await revoke(a, 'revoked-after-verify', 1)).status).toBe(204)

    // 受け取った値は保存先と結び付かないコピー。撤回で変わらない（生成は検証時点の内容で続けられる）。
    expect(snapshot.map(({ content }) => content)).toEqual(['検証後に撤回される学び'])
    // 一方、保存の直前に同じ { id, version } を再検証すると拒否される（保存処理の責務）。
    expect(await codeOf(resolveSelectedLearnings(store, a.uid, region, selection))).toBe(
      'selection_changed',
    )
  })

  it('地域限定の学びは、選択時と違う地域では採用しない', async () => {
    await approve(a, 'regional-learning', tripA.id, '京都の学び', 0, { kind: 'region', region })
    const selection = [{ id: 'regional-learning', version: 1 }]
    expect(await resolveSelectedLearnings(store, a.uid, ` ${region} `, selection)).toHaveLength(1)
    expect(await codeOf(resolveSelectedLearnings(store, a.uid, '奈良市', selection))).toBe(
      'selection_changed',
    )
  })

  it('不正な版の選択は、保存先を読まずに invalid_selection で拒否する', async () => {
    const bad = [
      { id: 'x', version: 0 },
      { id: 'x', version: -1 },
      { id: 'x', version: 1.5 },
      { id: 'x' },
    ]
    for (const item of bad) {
      expect(
        await codeOf(
          resolveSelectedLearnings(store, a.uid, region, [item as { id: string; version: number }]),
        ),
      ).toBe('invalid_selection')
    }
  })

  it('適用記録が指す学びが存在しなくても、旅程の記録は読み出せ、その学びは選べない', async () => {
    const session = await createSession('reuse-orphan')
    const trip = {
      ...sampleTrip,
      id: 'orphan-trip',
      learningApplications: [
        {
          learningId: 'missing-learning',
          targetStopIds: [sampleTrip.stops[1].id],
          explanation: '説明（未検証）',
        },
      ],
    }
    // 現在の保存APIは適用記録つきのTripを保存させないため、保存済みの旧データを直接用意する。
    await getAdminFirestore()
      .doc(`users/${session.uid}/trips/orphan-trip`)
      .set(toTripDocument({ uid: session.uid }, trip))

    const response = await getTrip(session.request(), context({ tripId: 'orphan-trip' }))
    expect(response.status).toBe(200)
    expect(TripResponseSchema.parse(await response.json()).trip.learningApplications).toEqual(
      trip.learningApplications,
    )
    expect((await listedBy(session)).learnings).toEqual([])
    expect(
      await codeOf(
        resolveSelectedLearnings(store, session.uid, region, [
          { id: 'missing-learning', version: 1 },
        ]),
      ),
    ).toBe('selection_changed')
  })
})

describe('破損・上限超過の保存データは、一部だけ採用せず安全に使わない', () => {
  // 書き込みの検証は120文字を超える本文を拒否する。上限導入前に保存された文書を再現するため、
  // 検証を通る文書を作ってから、本文だけを直接差し替えて保存する。
  async function seedLearning(session: Session, id: string, content: string, version = 1) {
    const document = toLearningDocument(
      { uid: session.uid },
      { version, learning: { ...sampleApprovedLearning, id, scope: allTrips } },
    )
    if (document.state !== 'approved') throw new Error('テストの文書が承認済みではありません')
    await getAdminFirestore()
      .doc(`users/${session.uid}/learnings/${id}`)
      .set({ ...document, learning: { ...document.learning, content } })
  }

  it('破損した文書があると、一覧は不完全として返り、画面の取得は拒否し、サーバー採用は unavailable にする', async () => {
    const session = await createSession('reuse-broken')
    await saveTrip(session, 'broken-source')
    await approve(session, 'healthy-learning', 'broken-source', '壊れていない学び')
    await getAdminFirestore()
      .doc(`users/${session.uid}/learnings/broken-learning`)
      .set({ ownerUid: session.uid, state: 'approved', version: 1, learning: { content: 1 } })

    const { listInfo } = await listedBy(session)
    expect(listInfo.skippedInvalid).toBe(1)
    const { loadApprovedLearningOptions } = await import('@/features/learning-reuse/api-client')
    const { createSessionScope } = await import('@/lib/auth/session-scope')
    const loaded = await loadApprovedLearningOptions({
      scope: createSessionScope(session.uid, 0),
      fetchFn: viaRoute,
      getHeaders: async () => session.headers(),
      beginOperation: isolatedSessionOperation,
    })
    expect(loaded).toMatchObject({ ok: false, kind: 'incomplete' })

    // 壊れていない学びを選んでいても、一覧の一部だけを採用しない。
    expect(
      await codeOf(
        resolveSelectedLearnings(store, session.uid, region, [
          { id: 'healthy-learning', version: 1 },
        ]),
      ),
    ).toBe('unavailable')
  })

  it('本文が120文字を超える保存済みの文書は、保存層が不正として除外し、画面の取得もサーバー採用も使わない', async () => {
    const session = await createSession('reuse-too-long')
    await seedLearning(session, 'too-long-learning', 'あ'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1))

    // 保存層の読み取りも上限を確かめる。上限超過の文書は一覧に含めず、不完全な一覧として知らせる。
    const listed = await listedBy(session)
    expect(listed.learnings).toEqual([])
    expect(listed.listInfo.skippedInvalid).toBe(1)
    const { loadApprovedLearningOptions } = await import('@/features/learning-reuse/api-client')
    const { createSessionScope } = await import('@/lib/auth/session-scope')
    const loaded = await loadApprovedLearningOptions({
      scope: createSessionScope(session.uid, 0),
      fetchFn: viaRoute,
      getHeaders: async () => session.headers(),
      beginOperation: isolatedSessionOperation,
    })
    expect(loaded).toMatchObject({ ok: false, kind: 'incomplete' })
    expect(
      await codeOf(
        resolveSelectedLearnings(store, session.uid, region, [
          { id: 'too-long-learning', version: 1 },
        ]),
      ),
    ).toBe('unavailable')
  })
})

describe('実クライアントの認証セッション切替（Emulator）', () => {
  beforeEach(async () => {
    vi.resetModules()
    const { getClientAuth } = await import('../../src/lib/firebase/client')
    await getClientAuth().authStateReady()
    await signOut(getClientAuth())
    await Promise.all(
      getApps()
        .filter((app) => app.name === 'groundtrip-client')
        .map(deleteApp),
    )
    vi.resetModules()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(
      getApps()
        .filter((app) => app.name === 'groundtrip-client')
        .map(async (app) => {
          await signOut(getAuth(app))
          await deleteApp(app)
        }),
    )
  })

  // 現在の実クライアントのセッションとして、旅程と学びを保存する。
  async function seedAsCurrentUser(
    client: typeof import('../../src/lib/auth/client'),
    content: string,
  ) {
    const headers = await client.getAuthHeaders()
    const authorized = (method: string, body: unknown) =>
      new Request('http://localhost/api', {
        method,
        headers: {
          Authorization: headers.get('authorization') ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    const tripId = 'switch-trip'
    expect(
      (
        await createTrip(
          authorized('POST', { ...sampleTrip, id: tripId, learningApplications: [] }),
        )
      ).status,
    ).toBe(201)
    const approved = await approveLearning(
      authorized('POST', {
        sourceTripId: tripId,
        expectedVersion: 0,
        content,
        category: 'preference',
        scope: allTrips,
      }),
      context({ learningId: 'switch-learning' }),
    )
    expect(approved.status).toBe(200)
  }

  it('AからBへ切り替えると、Aで取得した選択はBのトークンでも送れず、Bの本文へ置き換わらない', async () => {
    const client = await import('../../src/lib/auth/client')
    const { captureSessionScope, getAuthHeadersForScope } =
      await import('../../src/lib/auth/session-scope')
    const { loadApprovedLearningOptions } = await import('@/features/learning-reuse/api-client')
    const { resolveSelectionForRequest } = await import('@/features/learning-reuse/selection-scope')

    // Aが「Aだけが見える本文」を取得して選ぶ。
    const userA = await client.startNewAnonymousSession()
    await seedAsCurrentUser(client, 'Aだけが見える本文')
    const scopeA = await captureSessionScope()
    expect(scopeA.uid).toBe(userA.uid)
    const loadedA = await loadApprovedLearningOptions({ scope: scopeA, fetchFn: viaRoute })
    if (!loadedA.ok) throw new Error('Aの学びを取得できませんでした')
    expect(loadedA.learnings.value[0]).toMatchObject({
      version: 1,
      learning: { id: 'switch-learning', content: 'Aだけが見える本文' },
    })
    const selectedByA = {
      scope: loadedA.learnings.scope,
      value: loadedA.learnings.value.map(({ version, learning }) => ({ id: learning.id, version })),
    }

    // 同じ端末で、別の匿名ユーザーBに切り替わる。Bにも同じIDと版で、本文だけ違う学びがある。
    const { getClientAuth } = await import('../../src/lib/firebase/client')
    await signOut(getClientAuth())
    const userB = await client.startNewAnonymousSession()
    expect(userB.uid === userA.uid).toBe(false)
    await seedAsCurrentUser(client, 'Bだけが見える本文')
    const scopeB = await captureSessionScope()

    // 1. Aのスコープでは、Bのトークンを渡さずに失敗する。
    await expect(getAuthHeadersForScope(scopeA)).rejects.toMatchObject({ code: 'session_changed' })
    // 2. Aのスコープでの取得は、Bのトークンで通信せずに失敗する。
    const spy = vi.fn(viaRoute)
    expect(await loadApprovedLearningOptions({ scope: scopeA, fetchFn: spy })).toMatchObject({
      ok: false,
      kind: 'session_changed',
    })
    expect(spy).not.toHaveBeenCalled()
    // 3. Aで選んだ選択は、Bのセッションでは取り出せない。
    expect(() => resolveSelectionForRequest(selectedByA, scopeB)).toThrow(
      expect.objectContaining({ code: 'session_changed' }),
    )
    // 4. もし取り出せたとして、Bのトークンで解決すると、Bの本文になってしまう（防ぐべき取り違え）。
    const swapped = await resolveSelectedLearnings(store, userB.uid, region, selectedByA.value)
    expect(swapped[0].content).toBe('Bだけが見える本文')
    // 5. Bは自分のセッションで取得し直すと、Bの本文を見る。
    const loadedB = await loadApprovedLearningOptions({ scope: scopeB, fetchFn: viaRoute })
    expect(loadedB).toMatchObject({
      ok: true,
      learnings: {
        scope: scopeB,
        value: [{ version: 1, learning: { content: 'Bだけが見える本文' } }],
      },
    })
  })

  it('セッションが終了した後は、前のスコープでヘッダーを作らず、取得もせず、匿名アカウントも作らない', async () => {
    const client = await import('../../src/lib/auth/client')
    const { captureSessionScope, getAuthHeadersForScope } =
      await import('../../src/lib/auth/session-scope')
    const { loadApprovedLearningOptions } = await import('@/features/learning-reuse/api-client')

    await client.startNewAnonymousSession()
    const scope = await captureSessionScope()
    const { getClientAuth } = await import('../../src/lib/firebase/client')
    await signOut(getClientAuth())
    const count = (await getAdminAuth().listUsers(1000)).users.length

    await expect(getAuthHeadersForScope(scope)).rejects.toMatchObject({ code: 'session_ended' })
    const spy = vi.fn(viaRoute)
    expect(await loadApprovedLearningOptions({ scope, fetchFn: spy })).toMatchObject({
      ok: false,
      kind: 'session',
    })
    expect(spy).not.toHaveBeenCalled()
    expect((await getAdminAuth().listUsers(1000)).users.length).toBe(count)
  })
})
