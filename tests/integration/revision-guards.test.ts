import { deleteApp, initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as applyRevision } from '@/app/api/trips/[tripId]/revisions/[revisionId]/apply/route'
import {
  GET as getReport,
  POST as resolveReport,
} from '@/app/api/trips/[tripId]/revision-reports/[stopId]/route'
import { POST as saveRevision } from '@/app/api/trips/[tripId]/revisions/route'
import { POST as createTrip } from '@/app/api/trips/route'
import { POST as generateRevision } from '@/app/api/trips/revise/route'
import type { Trip } from '@/domain'
import { sampleRevision, sampleTrip } from '@/domain/samples'
import { getAdminFirestore } from '@/lib/firebase/admin'
import { COSTS } from '@/server/cost-control/costs'
import { DEFAULT_LIMITS, type Policy } from '@/server/cost-control/policy'
import { CONTROL_DOCUMENT, createControlDocument, reserveCost } from '@/server/cost-control/store'
import type { MapsClient, OpeningHours, PlaceSearchResult, RouteResult } from '@/server/maps'
import { PendingRevisionSchema, TripResponseSchema } from '@/server/persistence/contracts'
import * as provenance from '@/server/persistence/revision-provenance'
import { FirestoreTripStore } from '@/server/persistence/trips'

// 部分修正の3経路（生成・適用・本人報告）を、本物の共有利用枠（Firestore Emulator）に接続して検証する。
// 業務ロジック単独の検証は revision-apply.test.ts（共有枠は許可で固定）で行う。
const { verifyAppCheck, generateJson, searchPlaces, computeRoute } = vi.hoisted(() => ({
  verifyAppCheck: vi.fn(),
  generateJson: vi.fn<() => Promise<string>>(),
  searchPlaces: vi.fn<MapsClient['searchPlaces']>(),
  computeRoute: vi.fn<MapsClient['computeRoute']>(),
}))
vi.mock('@/lib/firebase/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/firebase/admin')>()),
  getAdminAppCheck: () => ({ verifyToken: verifyAppCheck }),
}))
vi.mock('@/server/gemini/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/gemini/client')>()),
  createLazyVertexGeminiClient: () => ({ generateJson }),
}))
vi.mock('@/server/maps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/maps')>()),
  createLazyMapsClient: () => ({ searchPlaces, computeRoute }),
}))
vi.mock('@/server/cost-control/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/cost-control/store')>()
  return { ...actual, reserveCost: vi.fn(actual.reserveCost) }
})

const db = getAdminFirestore()
const gate = db.doc(CONTROL_DOCUMENT)
const address = '京都府京都市東山区清水1丁目294'
const open: OpeningHours = {
  status: 'available',
  periods: [{ open: { day: 0, hour: 8, minute: 0 }, close: { day: 0, hour: 20, minute: 0 } }],
}
const tripInput: Trip = {
  ...sampleTrip,
  id: 'guard-trip',
  learningApplications: [],
  stops: sampleTrip.stops.map((stop, index) => ({
    ...stop,
    placeId: `place-${index + 1}`,
    kind: index === 1 ? 'meal' : 'sight',
  })),
}
const candidateB = { name: '昼食店B', placeId: 'place-b' }
const places = [...tripInput.stops, candidateB]
const foundPlace = (name: string, placeId: string): PlaceSearchResult => ({
  status: 'found',
  candidates: [{ name, placeId, address, openingHours: open }],
})
const normalSearch: MapsClient['searchPlaces'] = async ({ query }) => {
  const place = places.find(({ name }) => query.startsWith(`${name} `))
  return place?.placeId ? foundPlace(place.name, place.placeId) : { status: 'no_candidates' }
}
const route = (minutes: number): RouteResult => ({
  status: 'found',
  minutes,
  durationSeconds: minutes * 60,
})
const draft = (...names: string[]) =>
  JSON.stringify({
    failure: null,
    candidates: names.map((name) => ({ name, summary: '旅程に合う候補' })),
  })
const params = { tripId: tripInput.id, revisionId: 'guard-revision' }
const context = { params: Promise.resolve(params) }
const reportContext = {
  params: Promise.resolve({ tripId: tripInput.id, stopId: tripInput.stops[1].id }),
}
const approval = { expectedVersion: 0, confirm: true }

interface Session {
  uid: string
  request(method?: string, body?: unknown, options?: { appCheck?: boolean }): Request
}

async function session(): Promise<Session> {
  const app = initializeApp(
    { projectId: 'demo-groundtrip', apiKey: 'demo-api-key' },
    crypto.randomUUID(),
  )
  try {
    const auth = getAuth(app)
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    const { user } = await signInAnonymously(auth)
    const token = await user.getIdToken()
    return {
      uid: user.uid,
      request(method = 'GET', body, options) {
        return new Request('http://localhost/api', {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options?.appCheck === false ? {} : { 'X-Firebase-AppCheck': 'mock.app.check' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      },
    }
  } finally {
    await deleteApp(app)
  }
}

let owner: Session
let other: Session
let outsider: Session
let clockOffset = 0
const realPerformanceNow = performance.now.bind(performance)
const tripRef = () => db.doc(`users/${owner.uid}/trips/${tripInput.id}`)
const revisionRef = () => tripRef().collection('revisions').doc(params.revisionId)

// 招待UIDの全員が使える程度まで枠を緩め、各テストが確かめたい枠だけを絞る。
function policy(change?: (value: Policy) => void): Policy {
  const value: Policy = {
    ...structuredClone(DEFAULT_LIMITS),
    enabled: true,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
  }
  for (const scope of ['paid', 'storage'] as const) {
    for (const holder of ['uid', 'global'] as const) {
      value[scope][holder] = { perMinute: 1000, perPeriod: 1_000_000, concurrent: 100 }
    }
  }
  value.budget = { gemini: 1000, places: 1000, routes: 1000, reads: 1_000_000, writes: 1_000_000 }
  change?.(value)
  return value
}

async function seed(change?: (value: Policy) => void) {
  await gate.create(createControlDocument(policy(change)))
}

beforeAll(async () => {
  ;[other, outsider] = await Promise.all([session(), session()])
})
afterAll(async () => {
  await db.recursiveDelete(gate)
})
beforeEach(async () => {
  // 前テストの拒否キャッシュ（1秒）を期限切れにする。
  clockOffset += 2_000
  vi.spyOn(performance, 'now').mockImplementation(() => realPerformanceNow() + clockOffset)
  owner = await session()
  await db.recursiveDelete(gate)
  verifyAppCheck.mockResolvedValue({ appId: 'demo-app-id' })
  generateJson.mockReset().mockResolvedValue(draft(candidateB.name))
  searchPlaces.mockReset().mockImplementation(normalSearch)
  computeRoute.mockReset().mockResolvedValue(route(10))
  vi.stubEnv('COSTLY_API_INVITED_UIDS', JSON.stringify([owner.uid, other.uid]))
  vi.stubEnv('TRIP_REVISION_ENABLED', 'true')
  vi.stubEnv('TRIP_REVISION_APPLY_ENABLED', 'true')
  vi.stubEnv('PERSISTENCE_ENABLED', 'true')
  vi.stubEnv('REVISION_PROPOSAL_SIGNING_KEY', Buffer.alloc(32, 42).toString('base64url'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(reserveCost).mockClear()
})

async function seedTrip() {
  const response = await createTrip(owner.request('POST', tripInput))
  expect(response.status).toBe(201)
  return TripResponseSchema.parse(await response.json()).trip
}

// 署名付きの候補を保存済みにする（適用の前提）。
async function seedRevision(trip: Trip) {
  const target = trip.stops[1]
  const revision = PendingRevisionSchema.parse({
    ...sampleRevision,
    id: params.revisionId,
    tripId: trip.id,
    baseTripVersion: trip.version,
    context: { phase: 'planning' },
    diff: {
      before: target,
      after: { ...target, ...candidateB, evidence: sampleRevision.diff.after.evidence },
    },
    constraintCheck: { status: 'satisfied', explanation: 'クライアントの申告' },
  })
  const side = {
    fromPrevious: { presence: 'none', reason: 'first_stop' },
    toNext: { presence: 'none', reason: 'last_stop' },
  } as const
  const proposed = provenance.issueRevisionProposalTokens(
    owner,
    {
      trip,
      context: revision.context,
      targetStopId: revision.targetStopId,
      reason: revision.reason,
    },
    {
      status: 'proposed',
      revisions: [revision],
      comparisons: [
        {
          revisionId: revision.id,
          before: side,
          after: side,
          routeEndpoints: {
            previousPlaceId: trip.stops[0].placeId,
            nextPlaceId: trip.stops[2].placeId,
          },
        },
      ],
    },
  )
  if (proposed.status !== 'proposed') throw new Error('Expected proposal')
  const response = await saveRevision(
    owner.request('POST', { ...revision, proposalToken: proposed.proposalTokens?.[revision.id] }),
    context,
  )
  expect(response.status).toBe(201)
}

async function fixture() {
  const trip = await seedTrip()
  await seedRevision(trip)
  return trip
}

const reviseBody = (trip: Trip) => ({
  trip,
  context: { phase: 'planning' as const },
  targetStopId: trip.stops[1].id,
  reason: '代替を探す',
})
const revise = (who: Session, trip: Trip, options?: { appCheck?: boolean }) =>
  generateRevision(who.request('POST', reviseBody(trip), options))
const apply = (who: Session = owner, options?: { appCheck?: boolean }) =>
  applyRevision(who.request('POST', approval, options), context)

async function reserved() {
  return (await gate.get()).get('reserved')
}

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
}

// 下流（Gemini・Maps）が一度も呼ばれていないこと。
function expectNoPaidCalls() {
  expect(generateJson).not.toHaveBeenCalled()
  expect(searchPlaces).not.toHaveBeenCalled()
  expect(computeRoute).not.toHaveBeenCalled()
}

// 適用の前後で、Tripと候補の保存内容が同一であること（保存表現のまま比較する）。
async function snapshotApplyState() {
  const [tripSnapshot, revisionSnapshot] = await Promise.all([tripRef().get(), revisionRef().get()])
  return { trip: tripSnapshot.data(), revision: revisionSnapshot.data() }
}

async function expectApplyUntouched(before: Awaited<ReturnType<typeof snapshotApplyState>>) {
  expect(await snapshotApplyState()).toEqual(before)
  expect(before.revision?.revision.approval).toEqual({ status: 'pending' })
}

// 検証中のMaps照会を保留し、その間に共有制御文書を操作できるようにする。
function holdPlaces() {
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  searchPlaces.mockImplementation(async (options) => {
    if (options.includeOpeningHours) {
      started.resolve()
      await released.promise
    }
    return normalSearch(options)
  })
  return { started: started.promise, release: released.resolve }
}

// 保存層の入口で待機し、その間に共有制御文書を操作できるようにする。
function holdStore<K extends 'prepareRevisionGeneration' | 'resolveRevisionReport'>(method: K) {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const original = FirestoreTripStore.prototype[method] as (...args: unknown[]) => Promise<unknown>
  vi.spyOn(FirestoreTripStore.prototype, method).mockImplementationOnce(async function (
    this: FirestoreTripStore,
    ...args: unknown[]
  ) {
    entered.resolve()
    await resume.promise
    return original.apply(this, args)
  } as never)
  return { entered: entered.promise, resume: resume.resolve }
}

describe('POST /api/trips/revise（保存有効）の共通保護', () => {
  it('許可された生成は、生成と本人報告の保存分を最悪量で予約して進む', async () => {
    await seed()
    const trip = await seedTrip()
    const before = await gate.get()
    const response = await revise(owner, trip)

    expect(response.status).toBe(200)
    expect(verifyAppCheck).toHaveBeenCalledBefore(generateJson)
    expect(generateJson).toHaveBeenCalledTimes(1)
    const snapshot = await gate.get()
    const used = (key: string) => snapshot.get(key) - before.get(key)
    expect({
      gemini: used('reserved.gemini'),
      places: used('reserved.places'),
      routes: used('reserved.routes'),
      reads: used('reserved.reads'),
      writes: used('reserved.writes'),
    }).toEqual(COSTS.reviseWithReports)
    // 有料と保存の両方の枠を1回ずつ使う。
    expect(used('counts.paid.total')).toBe(1)
    expect(used('counts.storage.total')).toBe(1)
    expect(snapshot.get('leases')).toEqual([])
  })

  it.each([
    ['招待外のUID', () => revise(outsider, tripInput), 403, 'invite_required'],
    [
      'App Check拒否',
      () => revise(owner, tripInput, { appCheck: false }),
      403,
      'app_check_invalid',
    ],
  ])('%s では予約も下流もない', async (_name, call, status, code) => {
    await seed()
    await expectCode(await call(), status, code)

    expectNoPaidCalls()
    expect(await reserved()).toEqual({ gemini: 0, places: 0, routes: 0, reads: 0, writes: 0 })
  })

  it('共通の停止（policy.enabled=false）では下流に進まない', async () => {
    await seed((value) => {
      value.enabled = false
    })
    await expectCode(await revise(owner, tripInput), 503, 'protection_unavailable')
    expectNoPaidCalls()
  })

  it('機能フラグが無効なら、予約もせず停止する', async () => {
    await seed()
    vi.stubEnv('TRIP_REVISION_ENABLED', 'false')
    expect((await revise(owner, tripInput)).status).toBe(503)
    expect(reserveCost).not.toHaveBeenCalled()
    expectNoPaidCalls()
  })

  it.each([
    ['gemini', 0],
    ['routes', 15],
    ['reads', 69],
    ['writes', 4],
  ] as const)(
    '全体の%s予算が足りなければ、本人報告の保存にもGeminiにも進まない',
    async (key, left) => {
      await seed()
      const trip = await seedTrip()
      const consumed = await reserved()
      // 生成の予約量に足りない残りにする。
      await gate.update({ [`policy.budget.${key}`]: consumed[key] + left })
      const prepare = vi.spyOn(FirestoreTripStore.prototype, 'prepareRevisionGeneration')
      await expectCode(await revise(owner, trip), 429, 'global_limit')

      expectNoPaidCalls()
      expect(prepare).not.toHaveBeenCalled()
      expect(await reserved()).toEqual(consumed)
    },
  )

  it('全体の期間累計を超えた別UIDの生成は拒否される', async () => {
    await seed((value) => {
      value.paid.global.perPeriod = 1
    })
    const trip = await seedTrip()
    expect((await revise(owner, trip)).status).toBe(200)
    await expectCode(await revise(other, trip), 429, 'global_limit')
    expect(generateJson).toHaveBeenCalledTimes(1)
  })

  it('UID別の期間累計を超えた2回目は拒否され、別のUIDには影響しない', async () => {
    await seed((value) => {
      value.paid.uid.perPeriod = 1
    })
    const trip = await seedTrip()
    expect((await revise(owner, trip)).status).toBe(200)
    await expectCode(await revise(owner, trip), 429, 'uid_limit')
    expect(generateJson).toHaveBeenCalledTimes(1)
    // 別のUIDは自分の枠を使える（保存済みの旅程が無いので、本人報告の記録なしで進む）。
    expect((await revise(other, trip)).status).not.toBe(429)
  })

  it('同時枠が埋まっている間の2回目は拒否され、Geminiは1回だけ呼ばれる', async () => {
    await seed((value) => {
      value.paid.uid.concurrent = 1
    })
    const trip = await seedTrip()
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    generateJson.mockImplementationOnce(async () => {
      entered.resolve()
      await resume.promise
      return draft(candidateB.name)
    })
    const first = revise(owner, trip)
    await entered.promise
    try {
      await expectCode(await revise(owner, trip), 429, 'uid_limit')
    } finally {
      resume.resolve()
    }
    expect((await first).status).toBe(200)
    expect(generateJson).toHaveBeenCalledTimes(1)
  })

  it('本人報告の記録は書き込み権で確定し、リース失効後は確定せずGeminiも呼ばない', async () => {
    await seed()
    const trip = await seedTrip()
    const hold = holdStore('prepareRevisionGeneration')
    const pending = generateRevision(
      owner.request('POST', {
        ...reviseBody(trip),
        context: {
          phase: 'on_site',
          report: {
            kind: 'actual',
            category: 'closed',
            targetStopId: trip.stops[1].id,
            description: '本人の現地報告',
          },
        },
      }),
    )
    await hold.entered
    // リースが回収された（期限切れ・別予約による回収）状態を作る。
    await gate.update({ leases: [] })
    hold.resume()

    expect((await pending).status).toBe(503)
    expect(generateJson).not.toHaveBeenCalled()
    expect((await tripRef().get()).get('revisionReports')).toEqual([])
  })
})

describe('POST .../revisions/{revisionId}/apply の共通保護', () => {
  it('許可された適用は、検証のMaps照会と確定を最悪量で予約して進む', async () => {
    await seed()
    const trip = await fixture()
    const before = await reserved()
    const response = await apply()

    expect(response.status).toBe(200)
    expect(verifyAppCheck).toHaveBeenCalledBefore(searchPlaces)
    const after = await reserved()
    expect({
      places: after.places - before.places,
      routes: after.routes - before.routes,
      reads: after.reads - before.reads,
      writes: after.writes - before.writes,
    }).toEqual({
      places: COSTS.applyRevision.places,
      routes: COSTS.applyRevision.routes,
      reads: COSTS.applyRevision.reads,
      writes: COSTS.applyRevision.writes,
    })
    // 予約内の呼び出し回数に収まり、検証した施設で確定する。
    expect(searchPlaces.mock.calls.length).toBeLessThanOrEqual(COSTS.applyRevision.places)
    expect(computeRoute.mock.calls.length).toBeLessThanOrEqual(COSTS.applyRevision.routes)
    expect((await tripRef().get()).get('trip.version')).toBe(trip.version + 1)
    expect((await gate.get()).get('leases')).toEqual([])
  })

  it.each([
    ['招待外のUID', () => apply(outsider), 403, 'invite_required'],
    ['App Check拒否', () => apply(owner, { appCheck: false }), 403, 'app_check_invalid'],
  ])('%s ではMapsも業務DBの変更もない', async (_name, call, status, code) => {
    await seed()
    await fixture()
    const before = await snapshotApplyState()
    const consumed = await reserved()
    const applySpy = vi.spyOn(FirestoreTripStore.prototype, 'applyRevision')
    await expectCode(await call(), status, code)

    expectNoPaidCalls()
    expect(applySpy).not.toHaveBeenCalled()
    expect(await reserved()).toEqual(consumed)
    await expectApplyUntouched(before)
  })

  it('適用の機能フラグが無効なら、認証も予約もせず停止する', async () => {
    await seed()
    await fixture()
    const before = await snapshotApplyState()
    vi.mocked(reserveCost).mockClear()
    vi.stubEnv('TRIP_REVISION_APPLY_ENABLED', 'false')
    await expectCode(await apply(), 503, 'revision_apply_disabled')

    expect(reserveCost).not.toHaveBeenCalled()
    expectNoPaidCalls()
    await expectApplyUntouched(before)
  })

  it('共通の停止（policy.enabled=false）ではMapsにも業務DBにも進まない', async () => {
    await seed()
    await fixture()
    const before = await snapshotApplyState()
    await gate.update({ 'policy.enabled': false })
    await expectCode(await apply(), 503, 'protection_unavailable')

    expectNoPaidCalls()
    await expectApplyUntouched(before)
  })

  it.each([
    ['places', 3],
    ['routes', 3],
    ['reads', 13],
    ['writes', 9],
  ] as const)('全体の%s予算が足りなければ、Mapsにも業務DBにも進まない', async (key, left) => {
    await seed()
    await fixture()
    const before = await snapshotApplyState()
    const consumed = await reserved()
    // 候補の保存後に、適用の予約量に足りない残りにする。
    await gate.update({ [`policy.budget.${key}`]: consumed[key] + left })
    const applySpy = vi.spyOn(FirestoreTripStore.prototype, 'applyRevision')
    await expectCode(await apply(), 429, 'global_limit')

    expectNoPaidCalls()
    expect(applySpy).not.toHaveBeenCalled()
    expect(await reserved()).toEqual(consumed)
    await expectApplyUntouched(before)
  })

  it('UID別の枠を使い切った後の適用は拒否され、Mapsを呼ばない', async () => {
    await seed()
    await fixture()
    const before = await snapshotApplyState()
    // 候補の保存で保存枠を1回使った後、有料の期間累計を残り0にする。
    await gate.update({ 'policy.paid.uid.perPeriod': 1 })
    const uidDocs = await gate.collection('uids').get()
    await Promise.all(uidDocs.docs.map((doc) => doc.ref.update({ 'counts.paid.total': 1 })))
    await expectCode(await apply(), 429, 'uid_limit')

    expectNoPaidCalls()
    await expectApplyUntouched(before)
  })

  it('全体の同時枠が埋まっていれば、別UIDの適用も拒否される', async () => {
    await seed((value) => {
      value.paid.global.concurrent = 1
    })
    await fixture()
    const hold = holdPlaces()
    const first = apply()
    await hold.started
    try {
      const second = await applyRevision(other.request('POST', approval), context)
      await expectCode(second, 429, 'global_limit')
    } finally {
      hold.release()
    }
    expect((await first).status).toBe(200)
  })

  it('同じUIDの同時適用は、同時枠で2回目が拒否されMapsは1回分だけ呼ばれる', async () => {
    await seed((value) => {
      value.paid.uid.concurrent = 1
    })
    const trip = await fixture()
    const hold = holdPlaces()
    const first = apply()
    await hold.started
    const callsWhileHeld = searchPlaces.mock.calls.length
    try {
      await expectCode(await apply(), 429, 'uid_limit')
    } finally {
      hold.release()
    }
    expect(searchPlaces.mock.calls.length).toBe(callsWhileHeld)
    expect((await first).status).toBe(200)
    expect((await tripRef().get()).get('trip.version')).toBe(trip.version + 1)
  })

  it.each([
    ['リースが回収された', () => gate.update({ leases: [] })],
    ['共通の停止が入った', () => gate.update({ 'policy.enabled': false })],
    [
      '書き込み権が失効した',
      async () => {
        const snapshot = await gate.get()
        const leases = snapshot.get('leases').map((lease: object) => ({
          ...lease,
          writeRevoked: true,
        }))
        await gate.update({ leases })
      },
    ],
  ])('照合中に%s場合、古い適用は確定せずTripと候補を変えない', async (_name, invalidate) => {
    await seed()
    await fixture()
    const before = await snapshotApplyState()
    const hold = holdPlaces()
    const pending = apply()
    await hold.started
    await invalidate()
    hold.release()

    const response = await pending
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'protection_unavailable' } })
    await expectApplyUntouched(before)
  })
})

describe('GET/POST .../revision-reports/{stopId} の共通保護', () => {
  async function blockedReport() {
    await seedTrip()
    await tripRef().update({
      revisionReports: [{ stopId: tripInput.stops[1].id, blocked: true, reportVersion: 1 }],
    })
  }
  const resolveBody = { expectedVersion: 0, expectedReportVersion: 1, confirm: true }

  it.each([
    ['招待外のUID', () => getReport(outsider.request(), reportContext), 403, 'invite_required'],
    [
      'App Check拒否',
      () => getReport(owner.request('GET', undefined, { appCheck: false }), reportContext),
      403,
      'app_check_invalid',
    ],
  ])('GETは%sなら業務DBを読まない', async (_name, call, status, code) => {
    await seed()
    await blockedReport()
    const read = vi.spyOn(FirestoreTripStore.prototype, 'revisionReport')
    await expectCode(await call(), status, code)
    expect(read).not.toHaveBeenCalled()
  })

  it('GETは読取予算が足りなければ業務DBを読まない', async () => {
    await seed()
    await blockedReport()
    const consumed = await reserved()
    // 報告の読取（14）に1足りない残りにする。
    await gate.update({ 'policy.budget.reads': consumed.reads + COSTS.getRevisionReport.reads - 1 })
    const read = vi.spyOn(FirestoreTripStore.prototype, 'revisionReport')
    await expectCode(await getReport(owner.request(), reportContext), 429, 'global_limit')
    expect(read).not.toHaveBeenCalled()
  })

  it('POSTは書込予算が足りなければ、解消しない', async () => {
    await seed()
    await blockedReport()
    const consumed = await reserved()
    // 解消の予約量（書込5）に1足りない残りにする。
    await gate.update({ 'policy.budget.writes': consumed.writes + 4 })
    const resolve = vi.spyOn(FirestoreTripStore.prototype, 'resolveRevisionReport')
    await expectCode(
      await resolveReport(owner.request('POST', resolveBody), reportContext),
      429,
      'global_limit',
    )
    expect(resolve).not.toHaveBeenCalled()
    expect((await tripRef().get()).get('revisionReports')[0].blocked).toBe(true)
  })

  it('POSTの許可時は書き込み権で確定し、保存枠を1回使う', async () => {
    await seed()
    await blockedReport()
    const used = (await gate.get()).get('counts.storage.total')
    const response = await resolveReport(owner.request('POST', resolveBody), reportContext)

    expect(response.status).toBe(200)
    expect((await tripRef().get()).get('revisionReports')[0].blocked).toBe(false)
    expect((await gate.get()).get('counts.storage.total')).toBe(used + 1)
  })

  it('POSTはリース失効後の古い解消を確定しない', async () => {
    await seed()
    await blockedReport()
    const hold = holdStore('resolveRevisionReport')
    const pending = resolveReport(owner.request('POST', resolveBody), reportContext)
    await hold.entered
    await gate.update({ leases: [] })
    hold.resume()

    const response = await pending
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'protection_unavailable' } })
    expect((await tripRef().get()).get('revisionReports')[0]).toMatchObject({
      blocked: true,
      reportVersion: 1,
    })
  })
})
