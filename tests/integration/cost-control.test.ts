import { initializeApp as initializeClient, deleteApp as deleteClient } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as approveLearning } from '@/app/api/learnings/[learningId]/approve/route'
import {
  DELETE as revokeLearning,
  GET as getLearning,
} from '@/app/api/learnings/[learningId]/route'
import { GET as listLearnings } from '@/app/api/learnings/route'
import { GET as getRevision } from '@/app/api/trips/[tripId]/revisions/[revisionId]/route'
import {
  GET as listRevisions,
  POST as saveRevision,
} from '@/app/api/trips/[tripId]/revisions/route'
import { GET as getTrip, PATCH as patchTrip } from '@/app/api/trips/[tripId]/route'
import { POST as generate } from '@/app/api/trips/generate/route'
import { GET as listTrips, POST as createTrip } from '@/app/api/trips/route'
import { sampleRevision, sampleTrip } from '@/domain/samples'
import { sampleGenerateTripBody } from '../helpers/generate-request'
import { getAdminFirestore } from '@/lib/firebase/admin'
import { DEFAULT_LIMITS, type Policy } from '@/server/cost-control/policy'
import {
  CONTROL_DOCUMENT,
  createControlDocument,
  FirestoreCostStore,
  reserveCost,
  type Admission,
} from '@/server/cost-control/store'
import { toTripDocument } from '@/server/persistence/dto'
import { FirestoreTripStore } from '@/server/persistence/trips'

const { verifyAppCheck, generateJson } = vi.hoisted(() => ({
  verifyAppCheck: vi.fn(),
  generateJson: vi.fn(),
}))
// App Checkの署名検証サービスと有料アダプターに通信しない。
vi.mock('@/lib/firebase/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/firebase/admin')>()),
  getAdminAppCheck: () => ({ verifyToken: verifyAppCheck }),
}))
vi.mock('@/server/gemini/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/gemini/client')>()),
  createLazyVertexGeminiClient: () => ({ generateJson }),
}))

vi.mock('@/server/cost-control/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/cost-control/store')>()
  return { ...actual, reserveCost: vi.fn(actual.reserveCost) }
})

const db = getAdminFirestore()
const gate = db.doc(CONTROL_DOCUMENT)
const replicaApp = initializeApp({ projectId: 'demo-groundtrip' }, 'cost-replica')
const replica = getFirestore(replicaApp)
const client = initializeClient(
  { projectId: 'demo-groundtrip', apiKey: 'demo-api-key' },
  'cost-test',
)
let uid: string
let token: string
let clockOffset = 0
const realPerformanceNow = performance.now.bind(performance)

beforeAll(async () => {
  const auth = getAuth(client)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const session = await signInAnonymously(auth)
  uid = session.user.uid
  token = await session.user.getIdToken()
})

beforeEach(async () => {
  // 前テストのプロセス内拒否キャッシュは期限切れにする。
  clockOffset += 2_000
  vi.spyOn(performance, 'now').mockImplementation(() => realPerformanceNow() + clockOffset)
  await db.recursiveDelete(gate)
  verifyAppCheck.mockResolvedValue({ appId: 'demo-app-id' })
  generateJson.mockResolvedValue(
    JSON.stringify({
      failure: { status: 'no_candidates', reason: 'テスト用' },
      stops: [],
      learningApplications: [],
    }),
  )
  vi.stubEnv('COSTLY_API_INVITED_UIDS', JSON.stringify([uid]))
  vi.stubEnv('TRIP_GENERATION_ENABLED', 'true')
  vi.stubEnv('PERSISTENCE_ENABLED', 'true')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  verifyAppCheck.mockReset()
  generateJson.mockReset()
  vi.mocked(reserveCost).mockClear()
})

afterAll(async () => {
  await db.recursiveDelete(gate)
  await Promise.all([deleteApp(replicaApp), deleteClient(client)])
})

function policy(): Policy {
  return {
    ...structuredClone(DEFAULT_LIMITS),
    enabled: true,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
  }
}

async function seed(settings = policy()) {
  await gate.create(createControlDocument(settings))
}

function allowed(result: Admission) {
  expect(result.kind).toBe('allowed')
  if (result.kind !== 'allowed') throw new Error('予約に失敗しました')
  return result
}

function request(path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Firebase-AppCheck': 'mock.app.check',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
}

describe('分散枠のFirestoreトランザクション', () => {
  it('同時枠の拒否を短時間維持し、期限後は解放された枠を再確認する', async () => {
    await seed()
    const store = new FirestoreCostStore(db)
    const first = allowed(await store.reserve('cache-user', { gemini: 1 }))
    expect(await store.reserve('cache-user', { gemini: 1 })).toEqual({
      kind: 'limited',
      scope: 'uid',
    })
    await first.release()
    expect(await store.reserve('cache-user', { gemini: 1 })).toEqual({
      kind: 'limited',
      scope: 'uid',
    })
    clockOffset += 1_000
    await allowed(await store.reserve('cache-user', { gemini: 1 })).release()
  })

  it('異なるクライアントからの並行要求でUID別・全体の同時枠を超えない', async () => {
    await seed()
    const first = new FirestoreCostStore(db)
    const second = new FirestoreCostStore(replica)
    const results = await Promise.all([
      first.reserve('a', { gemini: 1 }),
      second.reserve('a', { gemini: 1 }),
    ])
    expect(results.map(({ kind }) => kind).sort()).toEqual(['allowed', 'limited'])
    expect(results).toContainEqual({ kind: 'limited', scope: 'uid' })
    const b = allowed(await second.reserve('b', { gemini: 1 }))
    expect(await first.reserve('c', { gemini: 1 })).toEqual({ kind: 'limited', scope: 'global' })

    const snapshot = await gate.get()
    expect(snapshot.get('leases')).toHaveLength(2)
    expect(snapshot.get('counts.paid.total')).toBe(2)
    expect(snapshot.get('reserved.gemini')).toBe(2)
    await b.release()
  })

  it('プロバイダー・Firestoreの費用と二種類の回数枠を一度に予約する', async () => {
    const settings = policy()
    settings.budget.places = 6
    await seed(settings)
    const store = new FirestoreCostStore(db)
    const lease = allowed(
      await store.reserve('a', { gemini: 1, places: 6, routes: 16, reads: 4, writes: 2 }),
    )
    await lease.release()
    expect(await new FirestoreCostStore(replica).reserve('b', { places: 1 })).toEqual({
      kind: 'limited',
      scope: 'global',
    })
    const snapshot = await gate.get()
    expect(snapshot.get('reserved')).toEqual({
      gemini: 1,
      places: 6,
      routes: 16,
      reads: 4,
      writes: 2,
    })
    expect(snapshot.get('counts.paid.total')).toBe(1)
    expect(snapshot.get('counts.storage.total')).toBe(1)
    expect(snapshot.get('leases')).toEqual([])
    expect((await gate.collection('uids').get()).size).toBe(1)
  })

  it('同時枠を解放しても、直近1分と期間の回数は消費済みのまま', async () => {
    const settings = policy()
    settings.storage.uid.perMinute = 1
    settings.storage.uid.perPeriod = 2
    await seed(settings)
    const store = new FirestoreCostStore(db)
    await allowed(await store.reserve('a', { reads: 1 })).release()
    expect(await store.reserve('a', { reads: 1 })).toEqual({ kind: 'limited', scope: 'uid' })

    const [person] = (await gate.collection('uids').get()).docs
    const lastMinute = person.readTime.toMillis() - 61_000
    await person.ref.update({ 'counts.storage.minute': [lastMinute] })
    clockOffset += 1_000
    await allowed(await store.reserve('a', { reads: 1 })).release()
    await person.ref.update({ 'counts.storage.minute': [lastMinute] })
    expect(await store.reserve('a', { reads: 1 })).toEqual({ kind: 'limited', scope: 'uid' })
    expect((await gate.get()).get('counts.storage.total')).toBe(2)
  })

  it('プロセス停止で残ったリースは期限で回復し、古い解放と二重解放は新しい枠を消さない', async () => {
    await seed()
    const first = new FirestoreCostStore(db)
    const previous = allowed(await first.reserve('a', { gemini: 1 }))
    const snapshot = await gate.get()
    const [expired] = snapshot.get('leases')
    await gate.update({ leases: [{ ...expired, until: snapshot.readTime.toMillis() - 1000 }] })

    const next = allowed(await new FirestoreCostStore(replica).reserve('a', { gemini: 1 }))
    const active = (await gate.get()).get('leases')
    expect(active).toHaveLength(1)
    expect(active[0].id).not.toBe(expired.id)
    await previous.release()
    await previous.release()
    expect((await gate.get()).get('leases')).toEqual(active)

    await next.release()
    await next.release()
    const done = await gate.get()
    expect(done.get('leases')).toEqual([])
    expect(done.get('reserved.gemini')).toBe(2)
  })

  it('停止・UID文書の更新・再開で同じUIDが新期間の枠を取得できる', async () => {
    const settings = policy()
    settings.storage.uid.perPeriod = 1
    await seed(settings)
    const store = new FirestoreCostStore(db)
    const old = allowed(await store.reserve(uid, { reads: 5, writes: 5 }))
    await old.release()
    expect(await store.reserve(uid, { reads: 1 })).toEqual({ kind: 'limited', scope: 'uid' })

    await gate.update({ 'policy.enabled': false })
    clockOffset += 1_000
    expect(await store.reserve(uid, { reads: 1 })).toEqual({ kind: 'unavailable' })
    expect((await gate.get()).get('leases')).toEqual([])
    await db.recursiveDelete(gate.collection('uids'))
    const next = {
      ...settings,
      enabled: false,
      startsAt: new Date(Date.parse(settings.startsAt) + 30_000).toISOString(),
    }
    await gate.set(createControlDocument(next))
    expect(await store.reserve(uid, { reads: 1 })).toEqual({ kind: 'unavailable' })
    await gate.update({ 'policy.enabled': true })

    const nextLease = allowed(
      await new FirestoreCostStore(replica).reserve(uid, { reads: 5, writes: 5 }),
    )
    const snapshot = await gate.get()
    expect(snapshot.get('counts.storage.total')).toBe(1)
    expect(snapshot.get('reserved.writes')).toBe(5)
    await old.release()
    expect((await gate.get()).get('leases')).toEqual(snapshot.get('leases'))
    const protectedDoc = db.doc('apiAbuseControl/old-period-probe')
    await expect(
      old.write(
        () => undefined,
        async (tx) => {
          tx.set(protectedDoc, { old: true })
        },
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' })
    expect((await protectedDoc.get()).exists).toBe(false)
    await nextLease.release()
  })

  it('競合の再試行は2試行までで、確定できなければ503相当になる', async () => {
    await seed()
    let attempts = 0
    vi.spyOn(db, 'runTransaction').mockImplementation(async () => {
      attempts += 1
      throw Object.assign(new Error('aborted'), { code: 10 })
    })
    expect(await new FirestoreCostStore(db, 10_000).reserve('a', { gemini: 1 })).toEqual({
      kind: 'unavailable',
    })
    expect(attempts).toBe(2)
    expect((await gate.get()).get('reserved.gemini')).toBe(0)
  })

  it.each([14, 9])(
    'コミット応答が不明な場合（%i）も許可せず、確定済みの消費とリースを戻さない',
    async (code) => {
      await seed()
      const run = db.runTransaction.bind(db)
      vi.spyOn(db, 'runTransaction').mockImplementationOnce(async (callback, options) => {
        await run(callback, options)
        throw Object.assign(new Error('commit response unavailable'), { code })
      })
      expect(await new FirestoreCostStore(db).reserve('a', { gemini: 1 })).toEqual({
        kind: 'unavailable',
      })
      const snapshot = await gate.get()
      expect(snapshot.get('reserved.gemini')).toBe(1)
      expect(snapshot.get('leases')).toHaveLength(1)
      expect(await new FirestoreCostStore(replica).reserve('a', { gemini: 1 })).toEqual({
        kind: 'limited',
        scope: 'uid',
      })
    },
  )
})

async function tripForPatch(id: string) {
  const trip = { ...sampleTrip, id, learningApplications: [] }
  await db.doc(`users/${uid}/trips/${trip.id}`).set(toTripDocument({ uid }, trip))
  const context = { params: Promise.resolve({ tripId: trip.id }) }
  const patch = (expectedVersion: number, value: string) =>
    patchTrip(
      new Request(request(`/api/trips/${id}`), {
        method: 'PATCH',
        body: JSON.stringify({ expectedVersion, preferences: [value] }),
      }),
      context,
    )
  return { trip, context, patch }
}

async function shortenNextOperation(revokeWrite?: () => Promise<void>) {
  const { reserveCost: reserveReal } = await vi.importActual<
    typeof import('@/server/cost-control/store')
  >('@/server/cost-control/store')
  vi.mocked(reserveCost).mockImplementationOnce(async (owner, cost) => {
    const admission = await reserveReal(owner, cost)
    return { ...allowed(admission), workAvailableMs: 400, ...(revokeWrite && { revokeWrite }) }
  })
}

describe('保存書き込みとリース交代', () => {
  it('HTTP 503の後で旧PATCHが再開しても、新リースのPATCHを上書きしない', async () => {
    const settings = policy()
    settings.storage.uid.concurrent = 1
    await seed(settings)
    const { trip, context, patch } = await tripForPatch('lease-fence-trip')
    await shortenNextOperation()

    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const update = FirestoreTripStore.prototype.updatePreferences
    vi.spyOn(FirestoreTripStore.prototype, 'updatePreferences').mockImplementationOnce(
      async function (this: FirestoreTripStore, ...args) {
        entered.resolve()
        await resume.promise
        try {
          return await update.apply(this, args)
        } finally {
          finished.resolve()
        }
      },
    )

    // 旧PATCHが再開時に版チェックを通過するよう、新PATCH後の版を指定して待機させる。
    const old = patch(trip.version + 1, '旧リースによる変更')
    try {
      await Promise.race([
        entered.promise,
        old.then(() => {
          throw new Error('旧PATCHが待機前に終了')
        }),
      ])
      expect((await old).status).toBe(503)
      const snapshot = await gate.get()
      const [oldLease] = snapshot.get('leases')
      await gate.update({ leases: [{ ...oldLease, until: snapshot.readTime.toMillis() - 1000 }] })

      expect((await patch(trip.version, '新リースによる変更')).status).toBe(200)
    } finally {
      resume.resolve()
    }
    await finished.promise
    const response = await getTrip(request('/api/trips/lease-fence-trip'), context)
    expect(await response.json()).toMatchObject({
      trip: { version: trip.version + 1, preferences: ['新リースによる変更'] },
    })
  })

  it.each([true, false])(
    '旧取引の準備後に書込権を失うと、原子的に拒否する（タイムアウト時の失効=%s）',
    async (revokesOnTimeout) => {
      const settings = policy()
      settings.storage.uid.concurrent = 1
      await seed(settings)
      const oldTrip = await tripForPatch(`queued-old-trip-${revokesOnTimeout}`)
      const nextTrip = await tripForPatch(`queued-new-trip-${revokesOnTimeout}`)
      await shortenNextOperation(
        revokesOnTimeout
          ? undefined
          : async () => {
              throw new Error('test revocation failure')
            },
      )

      const staged = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const completed = Promise.withResolvers<void>()
      const update = FirestoreTripStore.prototype.updatePreferences
      const run = db.runTransaction.bind(db)
      vi.spyOn(FirestoreTripStore.prototype, 'updatePreferences').mockImplementationOnce(
        async function (this: FirestoreTripStore, ...args) {
          vi.spyOn(db, 'runTransaction').mockImplementationOnce((callback, options) =>
            run(async (tx) => {
              const result = await callback(tx)
              staged.resolve()
              await resume.promise
              return result
            }, options),
          )
          try {
            return await update.apply(this, args)
          } finally {
            completed.resolve()
          }
        },
      )

      const old = oldTrip.patch(oldTrip.trip.version, '失効後の書き込み')
      try {
        await Promise.race([
          staged.promise,
          old.then(() => {
            throw new Error('旧PATCHが書き込みを準備できなかった')
          }),
        ])
        expect((await old).status).toBe(503)
        const snapshot = await gate.get()
        const [lease] = snapshot.get('leases')
        if (revokesOnTimeout) {
          expect(lease.writeRevoked).toBe(true)
        } else {
          expect(lease.writeRevoked).toBeUndefined()
          await gate.update({ leases: [{ ...lease, until: snapshot.readTime.toMillis() - 1000 }] })
          expect((await nextTrip.patch(nextTrip.trip.version, '有効な変更')).status).toBe(200)
        }
      } finally {
        resume.resolve()
      }
      await completed.promise
      const snapshot = await db.doc(`users/${uid}/trips/${oldTrip.trip.id}`).get()
      expect(snapshot.data()).toMatchObject({
        trip: { version: oldTrip.trip.version, preferences: oldTrip.trip.preferences },
      })
    },
  )

  it('保存の全11操作が共有枠内で動き、5種類の書き込みがfenceを通る', async () => {
    await seed()
    const tripId = 'fenced-all-routes'
    const tripPath = `/api/trips/${tripId}`
    const tripContext = { params: Promise.resolve({ tripId }) }
    const revisionId = 'fenced-revision'
    const revisionContext = { params: Promise.resolve({ tripId, revisionId }) }
    const learningId = 'fenced-learning'
    const learningPath = `/api/learnings/${learningId}`
    const learningContext = { params: Promise.resolve({ learningId }) }
    const listPath = `${tripPath}/revisions`

    const input = { ...sampleTrip, id: tripId, learningApplications: [] }
    expect((await createTrip(request('/api/trips', input))).status).toBe(201)
    expect((await listTrips(request('/api/trips'))).status).toBe(200)
    expect((await getTrip(request(tripPath), tripContext)).status).toBe(200)

    const patch = new Request(request(tripPath), {
      method: 'PATCH',
      body: JSON.stringify({ expectedVersion: input.version, preferences: ['更新後の希望'] }),
    })
    expect((await patchTrip(patch, tripContext)).status).toBe(200)
    const revision = {
      ...sampleRevision,
      id: revisionId,
      tripId,
      baseTripVersion: input.version + 1,
    }
    expect((await saveRevision(request(listPath, revision), tripContext)).status).toBe(201)
    expect((await listRevisions(request(listPath), tripContext)).status).toBe(200)
    expect((await getRevision(request(`${listPath}/${revisionId}`), revisionContext)).status).toBe(
      200,
    )

    const learning = {
      sourceTripId: tripId,
      expectedVersion: 0,
      category: 'preference',
      content: '休憩を確保したい',
      scope: { kind: 'all_trips' },
    }
    expect(
      (await approveLearning(request(`${learningPath}/approve`, learning), learningContext)).status,
    ).toBe(200)
    expect((await listLearnings(request('/api/learnings'))).status).toBe(200)
    expect((await getLearning(request(learningPath), learningContext)).status).toBe(200)
    const remove = new Request(request(`${learningPath}?expectedVersion=1`), { method: 'DELETE' })
    expect((await revokeLearning(remove, learningContext)).status).toBe(204)

    const state = await gate.get()
    expect(state.get('counts.storage.total')).toBe(11)
    expect(state.get('leases')).toEqual([])
  })

  it('業務コミットの応答喪失を区別し、同じ期待版の再送で二重に更新しない', async () => {
    await seed()
    const { trip, context, patch } = await tripForPatch('commit-response-trip')
    const update = FirestoreTripStore.prototype.updatePreferences
    const run = db.runTransaction.bind(db)
    let callbacks = 0
    vi.spyOn(FirestoreTripStore.prototype, 'updatePreferences').mockImplementationOnce(function (
      this: FirestoreTripStore,
      ...args
    ) {
      vi.spyOn(db, 'runTransaction').mockImplementationOnce(async (callback, options) => {
        expect(options).toEqual({ maxAttempts: 1 })
        await run(async (tx) => {
          callbacks += 1
          return callback(tx)
        }, options)
        throw Object.assign(new Error('lost commit response'), { code: 14 })
      })
      return update.apply(this, args)
    })

    const unknown = await patch(trip.version, '一度だけ反映')
    expect(unknown.status).toBe(503)
    expect(await unknown.json()).toMatchObject({ error: { code: 'write_result_unknown' } })
    expect(callbacks).toBe(1)
    expect((await gate.get()).get('leases')).toHaveLength(1)

    const replay = await patch(trip.version, '一度だけ反映')
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ error: { code: 'version_conflict' } })
    const response = await getTrip(request('/api/trips/commit-response-trip'), context)
    expect(await response.json()).toMatchObject({
      trip: { version: trip.version + 1, preferences: ['一度だけ反映'] },
    })
  })
})

describe('認証＋App Check＋分散枠を通る実Route', () => {
  it('認証済みの招待ユーザーだけが予約後にGeminiと業務Firestoreへ進む', async () => {
    await seed()
    const result = await generate(request('/api/trips/generate', sampleGenerateTripBody()))
    expect(result.status).toBe(422)
    expect(generateJson).toHaveBeenCalledTimes(1)
    expect(verifyAppCheck).toHaveBeenCalledBefore(generateJson)

    expect((await listTrips(request('/api/trips'))).status).toBe(200)
    const snapshot = await gate.get()
    expect(snapshot.get('reserved')).toMatchObject({ gemini: 1, reads: 21 })
    expect(snapshot.get('leases')).toEqual([])
  })

  it('App Check拒否と枠超過ではGeminiも業務Firestoreも呼ばない', async () => {
    const settings = policy()
    settings.budget.gemini = 0
    settings.budget.reads = 20
    await seed(settings)
    const read = vi.spyOn(FirestoreTripStore.prototype, 'listTrips')
    verifyAppCheck.mockResolvedValueOnce({ appId: 'wrong-app' })
    const forbidden = await generate(request('/api/trips/generate', sampleGenerateTripBody()))
    expect(forbidden.status).toBe(403)

    const denied = await generate(request('/api/trips/generate', sampleGenerateTripBody()))
    expect(denied.status).toBe(429)
    expect(await denied.json()).toMatchObject({ error: { code: 'global_limit' } })
    expect((await listTrips(request('/api/trips'))).status).toBe(429)
    expect(generateJson).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect((await gate.get()).get('reserved')).toMatchObject({ gemini: 0, reads: 0 })
  })

  it('緊急停止が予約の読み取り後に入っても旧い版で許可しない', async () => {
    await seed()
    const run = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementationOnce(async (callback, options) => {
      await gate.update({ 'policy.enabled': false })
      return run(callback, options)
    })
    const response = await generate(request('/api/trips/generate', sampleGenerateTripBody()))

    expect(response.status).toBe(503)
    expect(generateJson).not.toHaveBeenCalled()
    expect((await gate.get()).get('reserved.gemini')).toBe(0)
    expect((await gate.collection('uids').get()).empty).toBe(true)
  })

  it('制御文書未設定とストア例外では両ルートが503を返し下流を呼ばない', async () => {
    const read = vi.spyOn(FirestoreTripStore.prototype, 'listTrips')
    expect((await generate(request('/api/trips/generate', sampleGenerateTripBody()))).status).toBe(
      503,
    )
    await seed()
    vi.spyOn(db, 'runTransaction').mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { code: 14 }),
    )
    expect((await listTrips(request('/api/trips'))).status).toBe(503)
    expect(generateJson).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
})
