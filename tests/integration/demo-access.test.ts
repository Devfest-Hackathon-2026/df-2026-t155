import { createHash } from 'node:crypto'
import { deleteApp, getApps, initializeApp } from 'firebase/app'
import {
  connectAuthEmulator,
  deleteUser,
  EmailAuthProvider,
  getAuth,
  linkWithCredential,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
} from 'firebase/auth'
import { afterAll, expect, it, vi } from 'vitest'

import { POST as exchange } from '@/app/api/access/exchange/route'
import { GET as session } from '@/app/api/auth/session/route'
import { POST as approveLearning } from '@/app/api/learnings/[learningId]/approve/route'
import { GET as listLearnings } from '@/app/api/learnings/route'
import { POST as generate } from '@/app/api/trips/generate/route'
import { GET as listTrips, POST as createTrip } from '@/app/api/trips/route'
import { POST as verify } from '@/app/api/trips/verify/route'
import { sampleGenerateTripRequest, sampleTrip } from '@/domain/samples'
import { startNewAnonymousSession } from '@/lib/auth/client'
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase/admin'
import { getClientAuth, getDemoClientAuth } from '@/lib/firebase/client'
import { DEFAULT_LIMITS } from '@/server/cost-control/policy'
import { CONTROL_DOCUMENT, createControlDocument } from '@/server/cost-control/store'
import { FirestoreTripStore } from '@/server/persistence/trips'

const { verifyToken, generateJson, searchPlaces, computeRoute } = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  generateJson: vi.fn(),
  searchPlaces: vi.fn(),
  computeRoute: vi.fn(),
}))
vi.mock('@/lib/firebase/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/firebase/admin')>()),
  getAdminAppCheck: () => ({ verifyToken }),
}))
vi.mock('@/server/gemini/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/gemini/client')>()),
  createLazyVertexGeminiClient: () => ({ generateJson }),
}))

vi.mock('@/server/maps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/maps')>()),
  createLazyMapsClient: () => ({ searchPlaces, computeRoute }),
}))

const origin = 'https://groundtrip-example.hosted.app'
const uid = 'demo-exchange-emulator-test'
const ticket = 'a'.repeat(43)
const gate = getAdminFirestore().doc(CONTROL_DOCUMENT)

afterAll(async () => {
  vi.unstubAllEnvs()
  await getAdminFirestore().recursiveDelete(gate)
  await Promise.all(getApps().map((app) => deleteApp(app)))
})

function exchangeRequest() {
  return new Request(origin + '/api/access/exchange', {
    method: 'POST',
    body: ticket,
    headers: {
      Origin: origin,
      'Content-Type': 'text/plain',
      'X-Firebase-AppCheck': 'mock.app.check',
    },
  })
}

function protectedRequest(path: string, token: string, body?: unknown) {
  return new Request(origin + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Firebase-AppCheck': 'mock.app.check',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
}

async function signIntoDemo(auth: ReturnType<typeof getAuth>) {
  const response = await exchange(exchangeRequest())
  expect(response.status).toBe(200)
  const { customToken } = await response.json()
  const { user } = await signInWithCustomToken(auth, customToken)
  expect(user.uid).toBe(uid)
  expect(user.isAnonymous).toBe(false)
  return user.getIdToken()
}

it('別々のクライアントで同じデモUIDを使い、匿名データと分離しながら#58の保護を通る', async () => {
  const anon = await startNewAnonymousSession()
  const anonToken = await getClientAuth().currentUser!.getIdToken()
  await getAdminAuth().createUser({ uid })
  const config = {
    sha256: createHash('sha256').update(ticket).digest('hex'),
    uid,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    revoked: false,
  }
  vi.stubEnv('DEMO_ACCESS_ENABLED', 'true')
  vi.stubEnv('DEMO_ACCESS_ORIGIN', origin)
  vi.stubEnv('DEMO_ACCESS_TICKET', JSON.stringify(config))
  vi.stubEnv('TRIP_GENERATION_ENABLED', 'true')
  vi.stubEnv('TRIP_VERIFICATION_ENABLED', 'true')
  vi.stubEnv('PERSISTENCE_ENABLED', 'true')
  vi.stubEnv('COSTLY_API_INVITED_UIDS', JSON.stringify([uid, anon.uid]))
  verifyToken.mockResolvedValue({ appId: 'demo-app-id' })
  generateJson.mockResolvedValue(
    JSON.stringify({
      failure: { status: 'no_candidates', reason: 'テスト用' },
      stops: [],
      learningApplications: [],
    }),
  )
  await getAdminFirestore().recursiveDelete(gate)
  await gate.create(
    createControlDocument({
      ...DEFAULT_LIMITS,
      enabled: true,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: config.expiresAt,
      paid: { ...DEFAULT_LIMITS.paid, uid: { perMinute: 1, perPeriod: 1, concurrent: 1 } },
      storage: {
        ...DEFAULT_LIMITS.storage,
        uid: { ...DEFAULT_LIMITS.storage.uid, perPeriod: 5 },
      },
    }),
  )

  const secondApp = initializeApp(
    { projectId: 'demo-groundtrip', apiKey: 'demo-api-key' },
    'demo-exchange-second-browser',
  )
  const secondAuth = getAuth(secondApp)
  connectAuthEmulator(secondAuth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const demoAuth = getDemoClientAuth()
  const [, demoB] = await Promise.all([signIntoDemo(demoAuth), signIntoDemo(secondAuth)])
  const firstUser = demoAuth.currentUser
  const demoA = await signIntoDemo(demoAuth)
  expect(demoAuth.currentUser).not.toBe(firstUser)
  expect(getClientAuth().currentUser?.uid).toBe(anon.uid)

  const anonTrip = { ...sampleTrip, id: 'demo-test-anon-trip', learningApplications: [] }
  const demoTrip = { ...sampleTrip, id: 'demo-test-shared-trip', learningApplications: [] }
  expect((await createTrip(protectedRequest('/api/trips', anonToken, anonTrip))).status).toBe(201)
  expect((await createTrip(protectedRequest('/api/trips', demoA, demoTrip))).status).toBe(201)
  const learningPath = '/api/learnings/demo-test-anon-learning/approve'
  const learning = {
    sourceTripId: anonTrip.id,
    expectedVersion: 0,
    category: 'preference',
    content: '休憩を確保したい',
    scope: { kind: 'all_trips' },
  }
  expect(
    (
      await approveLearning(protectedRequest(learningPath, anonToken, learning), {
        params: Promise.resolve({ learningId: 'demo-test-anon-learning' }),
      })
    ).status,
  ).toBe(200)
  const demoTrips = await listTrips(protectedRequest('/api/trips', demoB))
  expect(demoTrips.status).toBe(200)
  expect((await demoTrips.json()).trips.map(({ id }: { id: string }) => id)).toEqual([demoTrip.id])
  const demoLearnings = await listLearnings(protectedRequest('/api/learnings', demoB))
  expect(demoLearnings.status).toBe(200)
  expect((await demoLearnings.json()).learnings).toEqual([])

  // 審査運用では共有UIDだけを招待し、通常の匿名認証自体は引き続き使える。
  vi.stubEnv('COSTLY_API_INVITED_UIDS', JSON.stringify([uid]))
  expect((await session(protectedRequest('/api/auth/session', anonToken))).status).toBe(200)
  const notInvited = await listTrips(protectedRequest('/api/trips', anonToken))
  expect(notInvited.status).toBe(403)
  expect(await notInvited.json()).toMatchObject({ error: { code: 'invite_required' } })

  const withoutAppCheck = protectedRequest('/api/trips', demoA)
  withoutAppCheck.headers.delete('X-Firebase-AppCheck')
  expect(await (await listTrips(withoutAppCheck)).json()).toMatchObject({
    error: { code: 'app_check_invalid' },
  })
  expect((await gate.get()).get('counts.storage.total')).toBe(5)

  const { date, region, timeZone, preferences, fixedStops } = sampleGenerateTripRequest
  const gen = (token: string) =>
    protectedRequest('/api/trips/generate', token, {
      date,
      region,
      timeZone,
      preferences,
      fixedStops,
      learningSelections: [],
    })
  expect((await generate(gen(demoA))).status).toBe(422)
  const overQuota = await generate(gen(demoB))
  expect(overQuota.status).toBe(429)
  const mapsOverQuota = await verify(
    protectedRequest('/api/trips/verify', demoB, { trip: sampleTrip }),
  )
  expect(mapsOverQuota.status).toBe(429)
  expect(generateJson).toHaveBeenCalledTimes(1)
  expect(searchPlaces).not.toHaveBeenCalled()
  expect(computeRoute).not.toHaveBeenCalled()

  vi.stubEnv('DEMO_ACCESS_TICKET', JSON.stringify({ ...config, revoked: true }))
  expect((await exchange(exchangeRequest())).status).toBe(403)
  expect((await listTrips(protectedRequest('/api/trips', demoB))).status).toBe(200)

  vi.stubEnv('DEMO_ACCESS_TICKET', JSON.stringify(config))
  vi.stubEnv('DEMO_ACCESS_ENABLED', 'false')
  expect((await exchange(exchangeRequest())).status).toBe(503)
  expect((await listTrips(protectedRequest('/api/trips', demoB))).status).toBe(200)
  const create = vi.spyOn(FirestoreTripStore.prototype, 'createTrip')
  try {
    const denied = await createTrip(
      protectedRequest('/api/trips', demoA, { ...demoTrip, id: 'demo-test-over-quota' }),
    )
    expect(denied.status).toBe(429)
    expect(await denied.json()).toMatchObject({ error: { code: 'uid_limit' } })
    expect(create).not.toHaveBeenCalled()
  } finally {
    create.mockRestore()
  }

  vi.stubEnv('COSTLY_API_INVITED_UIDS', '[]')
  const removed = await listTrips(protectedRequest('/api/trips', demoB))
  expect(removed.status).toBe(403)
  expect(await removed.json()).toMatchObject({ error: { code: 'invite_required' } })
  vi.stubEnv('COSTLY_API_INVITED_UIDS', JSON.stringify([uid]))
  await getAdminAuth().updateUser(uid, { disabled: true })
  await getAdminAuth().revokeRefreshTokens(uid)
  expect((await listTrips(protectedRequest('/api/trips', demoB))).status).toBe(401)
  expect((await session(protectedRequest('/api/auth/session', anonToken))).status).toBe(200)
})

it('デモを終了したクライアントだけサインアウトし、通常認証と共有データ・利用枠を保持する', async () => {
  const sharedUid = 'demo-session-exit-emulator-test'
  const admin = getAdminAuth()
  await admin.createUser({ uid: sharedUid })
  const regular = getClientAuth()
  const anonymous = regular.currentUser ?? (await signInAnonymously(regular)).user
  const demo = getDemoClientAuth()
  const peer = getAuth(
    initializeApp(
      { projectId: 'demo-groundtrip', apiKey: 'demo-api-key' },
      'demo-session-exit-peer',
    ),
  )
  connectAuthEmulator(peer, 'http://127.0.0.1:9099', { disableWarnings: true })
  await Promise.all(
    [demo, peer].map(async (auth) =>
      signInWithCustomToken(auth, await admin.createCustomToken(sharedUid)),
    ),
  )

  const db = getAdminFirestore()
  const owner = db.doc(`users/${sharedUid}`)
  const trip = owner.collection('trips').doc('trip')
  const revision = trip.collection('revisions').doc('revision')
  const learning = owner.collection('learnings').doc('learning')
  await Promise.all(
    [trip, revision, learning].map((ref) => ref.set({ ownerUid: sharedUid, id: ref.id })),
  )
  await gate.set({
    ...createControlDocument({
      ...DEFAULT_LIMITS,
      enabled: true,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 600_000).toISOString(),
    }),
    counts: { paid: { minute: [], total: 3 }, storage: { minute: [], total: 4 } },
  })
  const before = await db.getAll(trip, revision, learning, gate)

  // Auth SDKを保ったまま新しいブラウザ文書のモジュール状態を再現する。
  const marker = 'groundtrip-demo-session'
  const storage = new Map([[marker, 'demo-marker']])
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      location: { pathname: '/' },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    }),
  )
  try {
    vi.resetModules()
    const current = await import('@/lib/auth/client')
    await expect(current.getAuthSnapshot()).resolves.toMatchObject({ uid: sharedUid })
    await current.endDemoSession()

    expect(storage.has(marker)).toBe(false)
    expect(demo.currentUser).toBeNull()
    expect(regular.currentUser).toBe(anonymous)
    expect(peer.currentUser?.uid).toBe(sharedUid)
    const peerToken = await peer.currentUser?.getIdToken(true)
    expect(peerToken).toBeTruthy()
    await expect(admin.verifyIdToken(peerToken ?? '', true)).resolves.toMatchObject({
      uid: sharedUid,
    })
    await expect(admin.getUser(sharedUid)).resolves.toMatchObject({ disabled: false })
    const after = await db.getAll(trip, revision, learning, gate)
    expect(after.map((snapshot) => snapshot.data())).toEqual(
      before.map((snapshot) => snapshot.data()),
    )
    expect(after.map((snapshot) => snapshot.updateTime)).toEqual(
      before.map((snapshot) => snapshot.updateTime),
    )

    vi.resetModules()
    const normalEntry = await import('@/lib/auth/client')
    await expect(normalEntry.initializeAnonymousSession()).resolves.toEqual({
      uid: anonymous.uid,
      isAnonymous: true,
    })
  } finally {
    vi.unstubAllGlobals()
    await db.recursiveDelete(owner)
  }
})

// Auth Emulatorは本番のdisabledUserDeletionを強制しない。公開前に止めるべき操作を再現する。
it('共有UIDは自己削除でき、有効なプロバイダを連携すると同じUIDに別経路で入れる', async () => {
  const sharedUid = 'demo-self-service-risk'
  const email = 'demo-self-service@example.test'
  const password = 'emulator-test-password'
  await getAdminAuth().createUser({ uid: sharedUid })
  const client = getDemoClientAuth()
  const custom = await signInWithCustomToken(
    client,
    await getAdminAuth().createCustomToken(sharedUid),
  )
  const linked = await linkWithCredential(
    custom.user,
    EmailAuthProvider.credential(email, password),
  )
  expect(linked.user.uid).toBe(sharedUid)

  const otherApp = initializeApp(
    { projectId: 'demo-groundtrip', apiKey: 'demo-api-key' },
    'demo-self-service-peer',
  )
  const other = getAuth(otherApp)
  connectAuthEmulator(other, 'http://127.0.0.1:9099', { disableWarnings: true })
  const second = await signInWithEmailAndPassword(other, email, password)
  expect(second.user.uid).toBe(sharedUid)
  const secondToken = await second.user.getIdToken()
  await deleteUser(linked.user)
  await expect(getAdminAuth().getUser(sharedUid)).rejects.toMatchObject({
    code: 'auth/user-not-found',
  })
  await expect(getAdminAuth().verifyIdToken(secondToken, true)).rejects.toMatchObject({
    code: 'auth/user-not-found',
  })
})
