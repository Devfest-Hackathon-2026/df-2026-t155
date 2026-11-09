import { deleteApp, initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { FieldValue } from 'firebase-admin/firestore'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 適用・生成・保存の業務ロジック単独の検証。課金・保存の共通の保護は revision-guards.test.ts で実ストアを使って確かめる。
import '../helpers/mock-cost-control-commit'

import { POST as applyRevision } from '@/app/api/trips/[tripId]/revisions/[revisionId]/apply/route'
import {
  GET as getReport,
  POST as resolveReport,
} from '@/app/api/trips/[tripId]/revision-reports/[stopId]/route'
import { GET as getRevision } from '@/app/api/trips/[tripId]/revisions/[revisionId]/route'
import {
  GET as listRevisions,
  POST as saveRevision,
} from '@/app/api/trips/[tripId]/revisions/route'
import { GET as getTrip, PATCH as updateTrip } from '@/app/api/trips/[tripId]/route'
import { POST as createTrip } from '@/app/api/trips/route'
import { POST as generateRevision } from '@/app/api/trips/revise/route'
import { ReviseTripResponseSchema, type ReviseTripRequest, type Stop, type Trip } from '@/domain'
import { sampleRevision, sampleTrip } from '@/domain/samples'
import {
  confirmedTrip,
  readRevisionApplyResponse,
  readRevisionProposal,
} from '@/features/revision-review/api-client'
import { getAdminFirestore } from '@/lib/firebase/admin'
import type { MapsClient, OpeningHours, PlaceSearchResult, RouteResult } from '@/server/maps'
import {
  ApplyRevisionResponseSchema,
  PendingRevisionResponseSchema,
  PendingRevisionSchema,
  RevisionListResponseSchema,
  RevisionResponseSchema,
  TripResponseSchema,
  type SaveRevisionBody,
} from '@/server/persistence/contracts'
import * as provenance from '@/server/persistence/revision-provenance'
import * as revisionChecks from '@/server/revision/revise-trip'

const maps = vi.hoisted(() => ({
  searchPlaces: vi.fn<MapsClient['searchPlaces']>(),
  computeRoute: vi.fn<MapsClient['computeRoute']>(),
}))
const generateJson = vi.hoisted(() => vi.fn<() => Promise<string>>())
vi.mock(import('@/server/gemini/client'), async (importOriginal) => ({
  ...(await importOriginal()),
  createLazyVertexGeminiClient: () => ({ generateJson }),
}))
vi.mock(import('@/server/maps'), async (importOriginal) => ({
  ...(await importOriginal()),
  createLazyMapsClient: () => maps,
}))

const params = { tripId: 'apply-trip', revisionId: 'revision-b' }
const context = { params: Promise.resolve(params) }
const approval = { expectedVersion: 0, confirm: true }
const address = '京都府京都市東山区清水1丁目294'
const open: OpeningHours = {
  status: 'available',
  periods: [{ open: { day: 0, hour: 8, minute: 0 }, close: { day: 0, hour: 20, minute: 0 } }],
}
const tripInput: Trip = {
  ...sampleTrip,
  id: params.tripId,
  learningApplications: [],
  stops: sampleTrip.stops.map((stop, index) => ({
    ...stop,
    placeId: `place-${index + 1}`,
    kind: index === 1 ? 'meal' : 'sight',
  })),
}
const candidateB = { name: '昼食店B', placeId: 'place-b' }
const candidateC = { name: '昼食店C', placeId: 'place-c' }
const places = [...tripInput.stops, candidateB, candidateC]
const foundPlace = (
  name: string,
  placeId: string,
  openingHours: OpeningHours = open,
): PlaceSearchResult => ({
  status: 'found',
  candidates: [{ name, placeId, address, openingHours }],
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

async function session() {
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
      request(method = 'GET', body?: unknown) {
        return new Request('http://localhost/api', {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      },
    }
  } finally {
    await deleteApp(app)
  }
}

let owner: Awaited<ReturnType<typeof session>>
let other: typeof owner
const db = () => getAdminFirestore()
const tripRef = () => db().doc(`users/${owner.uid}/trips/${params.tripId}`)
const revisionRef = () => tripRef().collection('revisions').doc(params.revisionId)
const apply = (input: unknown = approval) => applyRevision(owner.request('POST', input), context)

beforeAll(async () => {
  other = await session()
})
beforeEach(async () => {
  owner = await session()
  vi.stubEnv('TRIP_REVISION_APPLY_ENABLED', 'true')
  vi.stubEnv('TRIP_REVISION_ENABLED', 'true')
  vi.stubEnv('REVISION_PROPOSAL_SIGNING_KEY', Buffer.alloc(32, 42).toString('base64url'))
  generateJson.mockReset().mockResolvedValue(draft(candidateB.name))
  maps.searchPlaces.mockReset().mockImplementation(normalSearch)
  maps.computeRoute.mockReset().mockResolvedValue(route(10))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function seedTrip(input = tripInput) {
  const response = await createTrip(owner.request('POST', input))
  expect(response.status).toBe(201)
  return TripResponseSchema.parse(await response.json()).trip
}

async function seedRevision(trip: Trip, overrides: Partial<SaveRevisionBody> = {}) {
  const target = trip.stops[1]
  const { travelModes, proposalToken, ...changes } = overrides
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
    // 保存時の申告は、再照合の結果として利用できない。
    constraintCheck: { status: 'satisfied', explanation: 'クライアントの申告' },
    ...changes,
  })
  const index = trip.stops.findIndex(({ id }) => id === revision.targetStopId)
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
      travelModes,
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
            previousPlaceId: trip.stops[index - 1]?.placeId ?? null,
            nextPlaceId: trip.stops[index + 1]?.placeId ?? null,
          },
        },
      ],
    },
  )
  if (proposed.status !== 'proposed') throw new Error('Expected proposal')
  const response = await saveRevision(
    owner.request('POST', {
      ...revision,
      travelModes,
      proposalToken: proposalToken ?? proposed.proposalTokens?.[revision.id],
    }),
    context,
  )
  expect(response.status).toBe(201)
  return PendingRevisionResponseSchema.parse(await response.json()).revision
}

const draft = (...names: string[]) =>
  JSON.stringify({
    failure: null,
    candidates: names.map((name) => ({ name, summary: '旅程に合う候補' })),
  })

async function generate(
  trip: Trip,
  reportContext: ReviseTripRequest['context'],
  travelModes?: ReviseTripRequest['travelModes'],
) {
  const request = {
    trip,
    context: reportContext,
    targetStopId: trip.stops[1].id,
    reason: '現地の報告を踏まえる',
    travelModes,
  }
  const response = await generateRevision(owner.request('POST', request))
  expect(response.status).toBe(200)
  const data = ReviseTripResponseSchema.parse(await response.json())
  const proposal = readRevisionProposal(data, request)
  if (!proposal) throw new Error('Expected proposal accepted by UI')
  const [revision] = proposal.revisions
  const proposalToken = proposal.proposalTokens?.[revision.id]
  expect(proposalToken).toBeDefined()
  return {
    request,
    data,
    proposal,
    revision,
    body: { ...revision, travelModes, proposalToken },
    context: { params: Promise.resolve({ tripId: trip.id, revisionId: revision.id }) },
  }
}

async function fixture(overrides?: Partial<SaveRevisionBody>) {
  const trip = await seedTrip()
  return { trip, revision: await seedRevision(trip, overrides) }
}

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
}

const actualContext = (category: 'closed' | 'crowded' | 'delayed' | 'other' = 'closed') => ({
  phase: 'on_site' as const,
  report: {
    kind: 'actual' as const,
    category,
    targetStopId: tripInput.stops[1].id,
    description: '本人の現地報告',
  },
})

async function readTrip() {
  return TripResponseSchema.parse(await (await getTrip(owner.request(), context)).json()).trip
}

async function readRevision() {
  return RevisionResponseSchema.parse(await (await getRevision(owner.request(), context)).json())
    .revision
}

async function expectUnchanged(trip: Trip) {
  expect(await readTrip()).toEqual(trip)
  expect((await readRevision()).approval).toEqual({ status: 'pending' })
}

function holdMaps(expected = 1) {
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let waiting = 0
  maps.searchPlaces.mockImplementation(async (options) => {
    if (options.includeOpeningHours) {
      if (++waiting === expected) started.resolve()
      await released.promise
    }
    return normalSearch(options)
  })
  return { started: started.promise, release: released.resolve }
}

describe('Revision適用 API＋Firestore Emulator', () => {
  it('連続した営業時間を生成・適用時に再照合する', async () => {
    const trip = await seedTrip()
    maps.searchPlaces.mockImplementation(async (options) => {
      if (options.includeOpeningHours) {
        return foundPlace(candidateB.name, candidateB.placeId, {
          status: 'available',
          periods: [
            { open: { day: 0, hour: 9, minute: 0 }, close: { day: 0, hour: 13, minute: 0 } },
            { open: { day: 0, hour: 13, minute: 0 }, close: { day: 0, hour: 17, minute: 0 } },
          ],
        })
      }
      return normalSearch(options)
    })
    const { revision, body, context } = await generate(trip, { phase: 'planning' })
    expect(revision.constraintCheck.status).toBe('satisfied')
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    expect(await readTrip()).toEqual(trip)
    const response = await applyRevision(owner.request('POST', approval), context)
    expect(response.status).toBe(200)
    expect((await readTrip()).stops).toEqual(
      trip.stops.with(1, { ...trip.stops[1], ...candidateB }),
    )
    expect(maps.searchPlaces).toHaveBeenCalledTimes(8)
    expect(maps.computeRoute).toHaveBeenCalledTimes(6)
  })

  it('営業時間が食い違う施設には署名を発行せず、別施設だけを再照合して適用できる', async () => {
    const trip = await seedTrip()
    const closedAlias = '昼食店Bの別名'
    const closedAtVisit: OpeningHours = {
      status: 'available',
      periods: [{ open: { day: 0, hour: 16, minute: 0 }, close: { day: 0, hour: 20, minute: 0 } }],
    }
    generateJson.mockResolvedValue(draft(candidateB.name, closedAlias, candidateC.name))
    maps.searchPlaces.mockImplementation(async (options) =>
      options.query.startsWith(`${closedAlias} `)
        ? foundPlace(closedAlias, candidateB.placeId, closedAtVisit)
        : normalSearch(options),
    )

    const { proposal, body, context, revision } = await generate(trip, { phase: 'planning' })
    expect(revision).toMatchObject({
      diff: { after: { placeId: candidateC.placeId } },
      constraintCheck: { status: 'satisfied' },
    })
    expect(proposal.revisions).toHaveLength(2)
    const conflicting = proposal.revisions[1]
    expect(conflicting).toMatchObject({
      diff: { after: { placeId: candidateB.placeId } },
      constraintCheck: { status: 'unknown', explanation: expect.stringContaining('食い違') },
    })
    expect(Object.keys(proposal.proposalTokens ?? {})).toEqual([revision.id])
    expect(maps.searchPlaces).toHaveBeenCalledTimes(6)
    expect(maps.computeRoute).toHaveBeenCalledTimes(6)

    const conflictingContext = {
      params: Promise.resolve({ tripId: trip.id, revisionId: conflicting.id }),
    }
    await expectCode(
      await saveRevision(
        owner.request('POST', { ...conflicting, proposalToken: body.proposalToken }),
        conflictingContext,
      ),
      422,
      'revision_provenance_invalid',
    )
    expect(
      (await saveRevision(owner.request('POST', conflicting), conflictingContext)).status,
    ).toBe(201)
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    maps.searchPlaces.mockClear()
    maps.computeRoute.mockClear()
    await expectCode(
      await applyRevision(owner.request('POST', approval), conflictingContext),
      409,
      'revision_provenance_missing',
    )
    expect(maps.searchPlaces).not.toHaveBeenCalled()
    expect(maps.computeRoute).not.toHaveBeenCalled()
    expect(await readTrip()).toEqual(trip)

    maps.searchPlaces.mockImplementation(async (options) =>
      options.query.startsWith(`${candidateC.name} `)
        ? foundPlace(candidateC.name, candidateC.placeId, closedAtVisit)
        : normalSearch(options),
    )
    await expectCode(
      await applyRevision(owner.request('POST', approval), context),
      422,
      'revision_not_applicable',
    )
    expect(await readTrip()).toEqual(trip)

    maps.searchPlaces.mockImplementation(normalSearch)
    expect((await applyRevision(owner.request('POST', approval), context)).status).toBe(200)
    expect((await readTrip()).stops).toEqual(
      trip.stops.with(1, { ...trip.stops[1], ...candidateC }),
    )
  })

  it.each(['生成時', '適用時'] as const)(
    '%sに判明した同名支店の曖昧さを、通常保存のPlace IDでは解消しない',
    async (ambiguousFrom) => {
      // 通常のTrip保存APIに、予約先ではない支店のIDを渡す。
      const trip = await seedTrip()
      const fixed = trip.stops[2]
      const wrongBranch = 'place-3'
      const reservedBranch = 'reserved-branch'
      expect(fixed).toMatchObject({
        isFixed: true,
        plannedStartTime: '14:00',
        placeId: wrongBranch,
      })
      expect((await readTrip()).stops[2].placeId).toBe(wrongBranch)

      let ambiguous = ambiguousFrom === '生成時'
      maps.searchPlaces.mockImplementation(async (options) => {
        const result = await normalSearch(options)
        if (!ambiguous || !options.query.startsWith(fixed.name) || result.status !== 'found') {
          return result
        }
        const [wrong] = result.candidates
        return { status: 'found', candidates: [wrong, { ...wrong, placeId: reservedBranch }] }
      })
      // 候補の終了は13:15。誤った支店なら10分、予約先なら46分かかる。
      maps.computeRoute.mockImplementation(async ({ destinationPlaceId }) =>
        route(destinationPlaceId === reservedBranch ? 46 : 10),
      )
      const { revision, proposal, body, context } = await generate(trip, { phase: 'planning' })
      const comparison = proposal.comparisons?.[0]
      if (ambiguous) {
        expect(revision.constraintCheck.status).toBe('unknown')
        expect(comparison?.routeEndpoints?.nextPlaceId).toBeNull()
        expect(comparison?.after.toNext).toMatchObject({
          presence: 'segment',
          segment: { status: 'unknown', reason: 'not_queried' },
        })
        expect(maps.computeRoute.mock.calls.map(([options]) => options.destinationPlaceId)).toEqual(
          [trip.stops[1].placeId, candidateB.placeId],
        )
      } else {
        // 比較時に一意だった端点を署名した場合も、適用時に新たに見つかった曖昧さを優先する。
        expect(revision.constraintCheck.status).toBe('satisfied')
        expect(comparison?.routeEndpoints?.nextPlaceId).toBe(wrongBranch)
      }
      expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)

      ambiguous = true
      maps.searchPlaces.mockClear()
      maps.computeRoute.mockClear()
      await expectCode(
        await applyRevision(owner.request('POST', approval), context),
        422,
        'revision_unverified',
      )
      expect(
        maps.searchPlaces.mock.calls.some(([options]) => options.query.startsWith(fixed.name)),
      ).toBe(true)
      expect(maps.computeRoute.mock.calls.map(([options]) => options.destinationPlaceId)).toEqual([
        candidateB.placeId,
      ])
      expect(await readTrip()).toEqual(trip)
      const stored = await getRevision(owner.request(), context)
      expect(RevisionResponseSchema.parse(await stored.json()).revision.approval).toEqual({
        status: 'pending',
      })
    },
  )

  it.each([true, false])(
    '通常施設は、保存済みPlace IDの有無（%s）にかかわらず再同定できれば承認・適用できる',
    async (hasPlaceIds) => {
      await seedTrip({
        ...tripInput,
        stops: tripInput.stops.map((stop) => ({
          ...stop,
          placeId: hasPlaceIds ? stop.placeId : null,
        })),
      })
      const trip = await readTrip()
      generateJson.mockResolvedValue(draft(candidateB.name, candidateC.name))
      const { request, proposal, revision, body, context } = await generate(trip, {
        phase: 'planning',
      })
      expect(proposal.revisions.map(({ constraintCheck }) => constraintCheck.status)).toEqual([
        'satisfied',
        'satisfied',
      ])
      expect(proposal.comparisons?.[0].routeEndpoints).toEqual({
        previousPlaceId: 'place-1',
        nextPlaceId: 'place-3',
      })
      expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
      const response = await applyRevision(owner.request('POST', approval), context)
      expect(response.status).toBe(200)
      const result = readRevisionApplyResponse(await response.json(), request, revision)
      expect(result).toMatchObject({
        status: 'applied',
        trip: { version: trip.version + 1 },
        receipt: { revision: { approval: { status: 'approved' } } },
      })
      const updated = await readTrip()
      expect(updated.stops).toEqual(trip.stops.with(1, { ...trip.stops[1], ...candidateB }))
    },
  )

  it.each([
    ['前が乗車・乗換', 'fromPrevious', 'not_queried', 'revision_unverified', 0],
    ['次が乗車・乗換', 'toNext', 'not_queried', 'revision_unverified', 2],
    ['次の施設が未同定', 'toNext', 'not_queried', 'revision_unverified'],
    ['次の施設の検索が失敗', 'toNext', 'not_queried', 'external_service_error'],
    ['候補の営業時間データが欠落', 'toNext', 'known', 'revision_unverified'],
    ['経路が見つからない', 'toNext', 'no_route', 'revision_unverified'],
    ['Routesの通信が失敗', 'toNext', 'api_error', 'external_service_error'],
  ] as const)(
    '保存済み旅程で全候補を比較できるが適用できない（%s）',
    async (scenario, side, expectedSegment, code, transportIndex?: number) => {
      const stops =
        transportIndex === undefined
          ? tripInput.stops
          : tripInput.stops.with(transportIndex, {
              ...tripInput.stops[transportIndex],
              kind: 'transport',
              placeId: null,
            })
      await seedTrip({ ...tripInput, stops })
      const trip = await readTrip()
      generateJson.mockResolvedValue(draft(candidateB.name, candidateC.name))
      maps.searchPlaces.mockImplementation(async (options) => {
        if (options.query.startsWith(trip.stops[2].name)) {
          if (scenario === '次の施設が未同定') return { status: 'no_candidates' }
          if (scenario === '次の施設の検索が失敗') throw new Error('injected Places outage')
        }
        if (options.includeOpeningHours && expectedSegment === 'known') {
          const candidate = [candidateB, candidateC].find(({ name }) =>
            options.query.startsWith(name),
          )
          if (candidate) {
            return foundPlace(candidate.name, candidate.placeId, { status: 'unavailable' })
          }
        }
        return normalSearch(options)
      })
      if (expectedSegment === 'no_route')
        maps.computeRoute.mockResolvedValue({ status: 'no_route' })
      if (expectedSegment === 'api_error')
        maps.computeRoute.mockRejectedValue(new Error('injected Routes outage'))

      const { data, proposal, body, context } = await generate(trip, { phase: 'planning' })
      if (data.status !== 'proposed') throw new Error('Expected proposal')
      expect(data.revisions.map(({ constraintCheck }) => constraintCheck.status)).toEqual([
        'unknown',
        'unknown',
      ])
      expect(proposal.revisions.map(({ constraintCheck }) => constraintCheck.status)).toEqual([
        'unknown',
        'unknown',
      ])
      expect(proposal.comparisons).toHaveLength(2)
      for (const comparison of proposal.comparisons ?? []) {
        expect(comparison.after[side]).toMatchObject({
          presence: 'segment',
          segment:
            expectedSegment === 'known'
              ? { status: 'known' }
              : { status: 'unknown', reason: expectedSegment },
        })
      }
      if (expectedSegment === 'known') {
        expect(proposal.revisions[0].constraintCheck.explanation).toContain('営業時間')
      }

      // UIが承認を送信しない場合も、適用APIを直接呼べば再照合で拒否される。
      expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
      await expectCode(
        await applyRevision(owner.request('POST', approval), context),
        code === 'external_service_error' ? 502 : 422,
        code,
      )
      expect(await readTrip()).toEqual(trip)
      const stored = await getRevision(owner.request(), context)
      expect(RevisionResponseSchema.parse(await stored.json()).revision.approval).toEqual({
        status: 'pending',
      })
    },
  )

  it('候補の営業時間付きPlaces検索が全件失敗した場合は、比較候補を返さず502にする', async () => {
    const trip = await seedTrip()
    generateJson.mockResolvedValue(draft(candidateB.name, candidateC.name))
    maps.searchPlaces.mockImplementation(async (options) => {
      if (options.includeOpeningHours) throw new Error('injected candidate Places outage')
      return normalSearch(options)
    })

    const response = await generateRevision(
      owner.request('POST', {
        trip,
        context: { phase: 'planning' },
        targetStopId: trip.stops[1].id,
        reason: '昼食の候補を比較する',
      }),
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ status: 'external_service_error' })
    expect(await readTrip()).toEqual(trip)
  })

  it('適用時に徒歩経路の取得が失敗しても、指定済みの車で両区間が間に合えば適用する', async () => {
    await seedTrip()
    const trip = await readTrip()
    const { request, revision, body, context } = await generate(trip, { phase: 'planning' }, [
      'walk',
      'drive',
    ])
    expect(revision.constraintCheck.status).toBe('satisfied')
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    maps.computeRoute.mockClear().mockImplementation(async ({ mode }) => {
      if (mode === 'WALK') throw new Error('injected walking route outage')
      return route(10)
    })

    const response = await applyRevision(owner.request('POST', approval), context)

    expect(response.status).toBe(200)
    expect(readRevisionApplyResponse(await response.json(), request, revision)).toMatchObject({
      status: 'applied',
      trip: { version: trip.version + 1 },
      receipt: { revision: { approval: { status: 'approved' } } },
    })
    expect(maps.computeRoute.mock.calls.map(([{ mode }]) => mode).sort()).toEqual([
      'DRIVE',
      'DRIVE',
      'WALK',
      'WALK',
    ])
  })

  it('保存済みの本人報告を省いた再発行では候補を適用できない', async () => {
    const trip = await seedTrip()
    const conflict = {
      ...sampleTrip.stops[1].evidence[0],
      subject: 'place_identity' as const,
      source: { kind: 'user_report' as const, label: '本人報告' },
    }
    const flagged = {
      ...trip,
      stops: trip.stops.with(1, { ...trip.stops[1], evidence: [conflict] }),
    }
    const first = await generate(flagged, actualContext())
    expect((await saveRevision(owner.request('POST', first.body), first.context)).status).toBe(201)
    const reissued = await generateRevision(owner.request('POST', { ...first.request, trip }))
    if (reissued.status === 200) {
      const response = ReviseTripResponseSchema.parse(await reissued.json())
      if (response.status !== 'proposed') throw new Error('Expected proposal')
      const [candidate] = response.revisions
      const next = { params: Promise.resolve({ tripId: trip.id, revisionId: candidate.id }) }
      expect(
        (
          await saveRevision(
            owner.request('POST', {
              ...candidate,
              proposalToken: response.proposalTokens?.[candidate.id],
            }),
            next,
          )
        ).status,
      ).toBe(201)
      expect((await applyRevision(owner.request('POST', approval), next)).status).not.toBe(200)
    } else {
      expect(reissued.status).toBe(422)
    }
    expect(await readTrip()).toEqual(trip)
  })

  it('新しい報告は照合中の適用を止め、明示解消でも古い署名は復活しない', async () => {
    const trip = await seedTrip()
    const { body, context, request } = await generate(trip, actualContext())
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    const reportContext = { params: Promise.resolve({ tripId: trip.id, stopId: trip.stops[1].id }) }
    const gate = holdMaps()
    const inflight = applyRevision(owner.request('POST', approval), context)
    try {
      await gate.started
      // Geminiで候補が出なくても、報告の記録は残る。
      generateJson.mockResolvedValueOnce(
        JSON.stringify({
          candidates: [],
          failure: { status: 'insufficient_information', reason: '候補なし' },
        }),
      )
      const response = await generateRevision(
        owner.request('POST', { ...request, context: actualContext('delayed') }),
      )
      expect(response.status).toBe(422)
    } finally {
      gate.release()
    }
    await expectCode(await inflight, 422, 'revision_unverified')
    expect(await (await getReport(owner.request(), reportContext)).json()).toEqual({
      blocked: true,
      reportVersion: 1,
      tripVersion: 0,
    })
    expect((await getReport(other.request(), reportContext)).status).toBe(404)
    await expectCode(
      await resolveReport(
        owner.request('POST', {
          expectedVersion: 0,
          expectedReportVersion: 0,
          confirm: true,
        }),
        reportContext,
      ),
      409,
      'revision_report_changed',
    )
    expect(
      await (
        await resolveReport(
          owner.request('POST', {
            expectedVersion: 0,
            expectedReportVersion: 1,
            confirm: true,
          }),
          reportContext,
        )
      ).json(),
    ).toEqual({ blocked: false, reportVersion: 2, tripVersion: 0 })
    await expectCode(
      await applyRevision(owner.request('POST', approval), context),
      409,
      'revision_report_changed',
    )
    const fresh = await generate(trip, actualContext())
    expect((await saveRevision(owner.request('POST', fresh.body), fresh.context)).status).toBe(201)
    expect((await applyRevision(owner.request('POST', approval), fresh.context)).status).toBe(200)
  })

  it('比較後に未保存の隣接Place IDが変わった場合は再承認を要求する', async () => {
    const trip = await seedTrip({
      ...tripInput,
      stops: tripInput.stops.with(0, { ...tripInput.stops[0], placeId: null }),
    })
    const { body, context } = await generate(trip, actualContext())
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    maps.searchPlaces.mockImplementation(async (options) =>
      options.query.startsWith(trip.stops[0].name)
        ? foundPlace(trip.stops[0].name, 'changed-neighbor')
        : normalSearch(options),
    )
    maps.computeRoute.mockClear()
    await expectCode(
      await applyRevision(owner.request('POST', approval), context),
      409,
      'revision_endpoints_changed',
    )
    expect(maps.computeRoute).not.toHaveBeenCalled()
    expect(await readTrip()).toEqual(trip)
  })

  it('旧文書の候補から未解消報告を復元し、Tripの版更新でも解消しない', async () => {
    const trip = await seedTrip()
    await seedRevision(trip, {
      context: { phase: 'on_site', report: { kind: 'actual', description: '旧形式の本人報告' } },
    })
    await revisionRef().update({ 'revision.proposalContext': FieldValue.delete() })
    await tripRef().update({ revisionReports: FieldValue.delete() })
    await expectCode(await apply(), 409, 'revision_provenance_missing')
    const currentContext = {
      params: Promise.resolve({ tripId: trip.id, stopId: trip.stops[1].id }),
    }
    const report = await getReport(owner.request(), currentContext)
    expect(await report.json()).toMatchObject({ blocked: true, tripVersion: 0 })
    expect(
      (
        await updateTrip(
          owner.request('PATCH', { expectedVersion: 0, preferences: ['更新'] }),
          context,
        )
      ).status,
    ).toBe(200)
    const current = await readTrip()
    const regenerated = await generateRevision(
      owner.request('POST', {
        trip: current,
        context: { phase: 'planning' },
        targetStopId: current.stops[1].id,
        reason: '候補を更新',
      }),
    )
    expect(regenerated.status).toBe(422)
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('保存済みの隣接Place IDと検索結果が違うとき生成時も成立にしない', async () => {
    const trip = await seedTrip()
    maps.searchPlaces.mockImplementation(async (options) =>
      options.query.startsWith(trip.stops[0].name)
        ? foundPlace(trip.stops[0].name, 'wrong-neighbor')
        : normalSearch(options),
    )
    const response = await generateRevision(
      owner.request('POST', {
        trip,
        targetStopId: trip.stops[1].id,
        context: actualContext(),
        reason: '代替を探す',
      }),
    )
    const result = ReviseTripResponseSchema.parse(await response.json())
    expect(result.status).toBe('proposed')
    if (result.status === 'proposed')
      expect(result.revisions[0].constraintCheck.status).toBe('unknown')
  })

  it('生成時も保存時と同じ修正理由の上限を使い、超過時にGeminiを呼ばない', async () => {
    const trip = await seedTrip()
    const response = await generateRevision(
      owner.request('POST', {
        trip,
        targetStopId: trip.stops[1].id,
        context: actualContext(),
        reason: 'あ'.repeat(1001),
      }),
    )
    expect(response.status).toBe(400)
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('実報告の生成から保存・適用・再送まで通し、実際の200をUIが受理する', async () => {
    const trip = await seedTrip()
    const generated = await generate(trip, actualContext())
    const { request, revision, body, context } = generated
    expect(revision.constraintCheck.status).toBe('satisfied')
    expect(readRevisionProposal(generated.proposal, { ...request, reason: '違う理由' })).toBeNull()
    expect(
      readRevisionProposal(generated.proposal, { ...request, context: actualContext('crowded') }),
    ).toBeNull()
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    const response = await applyRevision(owner.request('POST', approval), context)
    expect(response.status).toBe(200)
    const result = ApplyRevisionResponseSchema.parse(await response.json())
    expect(confirmedTrip(trip, revision, result.trip)?.version).toBe(1)
    expect(readRevisionApplyResponse(result, request, revision).status).toBe('applied')
    expect((await readTrip()).stops[1].evidence).toEqual([])
    expect(result.trip.stops[1].evidence).toHaveLength(4)
    const replay = await applyRevision(owner.request('POST', approval), context)
    const receipt = ApplyRevisionResponseSchema.parse(await replay.json())
    expect(receipt).toMatchObject({
      status: 'already_applied',
      verification: 'not_available',
      appliedTripVersion: 1,
    })
    expect(readRevisionApplyResponse(receipt, request, revision).status).toBe('applied')
    expect((await readTrip()).version).toBe(1)
    expect(
      (
        await updateTrip(
          owner.request('PATCH', { expectedVersion: 1, preferences: ['後の編集'] }),
          context,
        )
      ).status,
    ).toBe(200)
    const later = ApplyRevisionResponseSchema.parse(
      await (await applyRevision(owner.request('POST', approval), context)).json(),
    )
    expect(later).toMatchObject({
      status: 'already_applied',
      appliedTripVersion: 1,
      trip: { version: 2 },
    })
    expect(confirmedTrip(trip, revision, later.trip, later)).toEqual(await readTrip())
  })

  it('本人報告の同定矛盾を保存・復元し、矛盾の削除や成立への書き換えで適用できない', async () => {
    const trip = await seedTrip()
    const original = trip.stops[1]
    const conflict = {
      ...sampleTrip.stops[1].evidence[0],
      subject: 'place_identity' as const,
      source: { kind: 'user_report' as const, label: '本人報告' },
    }
    const { body, context, revision } = await generate(
      { ...trip, stops: trip.stops.with(1, { ...original, evidence: [conflict] }) },
      actualContext(),
    )
    expect(revision.constraintCheck.status).toBe('unknown')
    await expectCode(
      await saveRevision(
        owner.request('POST', {
          ...body,
          diff: { ...body.diff, before: original },
        }),
        context,
      ),
      422,
      'revision_provenance_invalid',
    )
    expect(
      (
        await saveRevision(
          owner.request('POST', {
            ...body,
            constraintCheck: { status: 'satisfied', explanation: '改変' },
          }),
          context,
        )
      ).status,
    ).toBe(201)
    const saved = RevisionResponseSchema.parse(
      await (await getRevision(owner.request(), context)).json(),
    ).revision
    expect(saved.context).toEqual(actualContext())
    expect(saved.diff.before.evidence).toEqual([conflict])
    expect(saved.diff.after.evidence).toEqual([])
    await expectCode(
      await applyRevision(owner.request('POST', approval), context),
      422,
      'revision_unverified',
    )
    expect(await readTrip()).toEqual(trip)
  })

  it('候補側の本人報告の矛盾も復元し、外部照合の整合で上書きしない', async () => {
    const trip = await seedTrip()
    const target = trip.stops[1]
    const conflict = {
      ...sampleTrip.stops[1].evidence[0],
      subject: 'other' as const,
      source: { kind: 'user_report' as const, label: '本人報告' },
    }
    await seedRevision(trip, {
      context: actualContext(),
      diff: { before: target, after: { ...target, ...candidateB, evidence: [conflict] } },
    })
    const saved = await readRevision()
    expect(saved.diff.before.evidence).toEqual([])
    expect(saved.diff.after.evidence).toEqual([conflict])
    await expectCode(await apply(), 422, 'revision_unverified')
    await expectUnchanged(trip)
  })

  it('署名で模擬候補の改変・署名の移植・UIDの取り違えを拒否する', async () => {
    const trip = await seedTrip()
    const simulated = {
      ...actualContext(),
      report: { ...actualContext().report, kind: 'simulated' as const },
    }
    const { body, context, revision } = await generate(trip, simulated)
    const changed = { ...body, context: { phase: 'planning' } }
    await expectCode(
      await saveRevision(owner.request('POST', changed), context),
      422,
      'revision_provenance_invalid',
    )
    await expectCode(
      await saveRevision(owner.request('POST', { ...body, id: 'different-id' }), context),
      422,
      'revision_provenance_invalid',
    )
    const another = await session()
    expect((await createTrip(another.request('POST', tripInput))).status).toBe(201)
    await expectCode(
      await saveRevision(another.request('POST', body), context),
      422,
      'revision_provenance_invalid',
    )
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    await expectCode(
      await applyRevision(owner.request('POST', approval), context),
      422,
      'revision_simulated',
    )
    const unsignedId = `${revision.id}-unsigned`
    expect(
      (
        await saveRevision(
          owner.request('POST', {
            ...changed,
            id: unsignedId,
            proposalToken: undefined,
          }),
          context,
        )
      ).status,
    ).toBe(201)
    await expectCode(
      await applyRevision(owner.request('POST', approval), {
        params: Promise.resolve({ tripId: trip.id, revisionId: unsignedId }),
      }),
      409,
      'revision_provenance_missing',
    )
    expect(await readTrip()).toEqual(trip)
  })

  it.each(['delayed', 'other'] as const)(
    '現地報告 %s は再照合でも未確認のまま扱う',
    async (category) => {
      const trip = await seedTrip()
      const { revision, body, context } = await generate(trip, actualContext(category))
      expect(revision.constraintCheck.status).toBe('unknown')
      expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
      await expectCode(
        await applyRevision(owner.request('POST', approval), context),
        422,
        'revision_unverified',
      )
      expect(await readTrip()).toEqual(trip)
    },
  )

  it('報告対象の不一致とcontext欠落を生成・保存で拒否する', async () => {
    const trip = await seedTrip()
    const { request, body, context } = await generate(trip, actualContext())
    const mismatch = {
      ...actualContext(),
      report: { ...actualContext().report, targetStopId: 'wrong-stop' },
    }
    for (const changed of [mismatch, undefined]) {
      expect(
        (await generateRevision(owner.request('POST', { ...request, context: changed }))).status,
      ).toBe(400)
      await expectCode(
        await saveRevision(owner.request('POST', { ...body, context: changed }), context),
        400,
        'invalid_request',
      )
    }
    expect(generateJson).toHaveBeenCalledTimes(1)
    expect(await readTrip()).toEqual(trip)
  })

  it('署名の期限と、署名の対象となったTrip版を保存・適用で検査する', async () => {
    const trip = await seedTrip()
    const pending = await generate(trip, actualContext())
    expect((await saveRevision(owner.request('POST', pending.body), pending.context)).status).toBe(
      201,
    )
    // 署名発行だけの時刻を動かし、AuthとFirestore SDKの時計は実時間で動かす。
    const issue = provenance.issueRevisionProposalTokens
    vi.spyOn(provenance, 'issueRevisionProposalTokens').mockImplementationOnce((...args) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 16 * 60_000)
      try {
        return issue(...args)
      } finally {
        now.mockRestore()
      }
    })
    const notSaved = await generate(trip, actualContext())
    await expectCode(
      await saveRevision(owner.request('POST', notSaved.body), notSaved.context),
      409,
      'revision_proposal_expired',
    )
    const { revisionId } = await pending.context.params
    await tripRef()
      .collection('revisions')
      .doc(revisionId)
      .update({
        'revision.proposalExpiresAt': Date.now() - 1,
      })
    await expectCode(
      await applyRevision(owner.request('POST', approval), pending.context),
      409,
      'revision_proposal_expired',
    )
    expect(
      (
        await updateTrip(
          owner.request('PATCH', { expectedVersion: 0, preferences: ['更新'] }),
          context,
        )
      ).status,
    ).toBe(200)
    await expectCode(
      await saveRevision(owner.request('POST', notSaved.body), notSaved.context),
      409,
      'version_conflict',
    )
    await expectCode(
      await applyRevision(owner.request('POST', approval), pending.context),
      409,
      'version_conflict',
    )
  })

  it('別支店を生成・適用し、元施設の別名は生成時と再照合時の双方で除外する', async () => {
    const base = { ...tripInput.stops[1], name: '喫茶（本店）' }
    const branch = '喫茶（東店）'
    const alias = '珈琲店本店'
    const trip = await seedTrip({ ...tripInput, stops: tripInput.stops.with(1, base) })
    generateJson.mockResolvedValue(draft(alias, branch))
    let branchId = candidateB.placeId
    maps.searchPlaces.mockImplementation(async (options) => {
      const { query } = options
      if (query.startsWith(base.name)) return foundPlace(base.name, 'place-2')
      if (query.startsWith(alias)) return foundPlace(alias, 'place-2')
      if (query.startsWith(branch)) return foundPlace(branch, branchId)
      return normalSearch(options)
    })
    const { proposal, body, context } = await generate(trip, actualContext())
    expect(proposal.revisions.map(({ diff }) => diff.after.name)).toEqual([branch])
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    branchId = 'place-2'
    await expectCode(
      await applyRevision(owner.request('POST', approval), context),
      422,
      'revision_not_applicable',
    )
    expect(await readTrip()).toEqual(trip)
    branchId = candidateB.placeId
    expect((await applyRevision(owner.request('POST', approval), context)).status).toBe(200)
    expect((await readTrip()).stops[1]).toMatchObject({ name: branch, placeId: branchId })
  })

  it('適用直前に元の施設を特定できなくなったときは、別施設への変更を確認できない', async () => {
    const trip = await seedTrip()
    const { body, context } = await generate(trip, actualContext())
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    maps.searchPlaces.mockImplementation(async (options) =>
      options.query.startsWith(trip.stops[1].name)
        ? { status: 'no_candidates' }
        : normalSearch(options),
    )
    await expectCode(
      await applyRevision(owner.request('POST', approval), context),
      422,
      'revision_unverified',
    )
    expect(await readTrip()).toEqual(trip)
  })

  it('生成・適用の最大経路で両モードを使い、課金呼び出し数を超えない', async () => {
    const trip = await seedTrip()
    generateJson.mockResolvedValue(draft(candidateB.name, candidateC.name, '昼食店D'))
    maps.searchPlaces.mockImplementation(async (options) =>
      options.query.startsWith('昼食店D')
        ? foundPlace('昼食店D', 'place-d')
        : normalSearch(options),
    )
    maps.computeRoute.mockImplementation(async ({ mode }) => route(mode === 'WALK' ? 100 : 10))
    const { body, context, proposal } = await generate(trip, { phase: 'planning' }, [
      'walk',
      'drive',
    ])
    expect(proposal.revisions).toHaveLength(3)
    expect(generateJson).toHaveBeenCalledTimes(1)
    expect(maps.searchPlaces).toHaveBeenCalledTimes(6)
    expect(maps.computeRoute).toHaveBeenCalledTimes(16)
    maps.searchPlaces.mockClear()
    maps.computeRoute.mockClear()
    expect((await saveRevision(owner.request('POST', body), context)).status).toBe(201)
    expect((await applyRevision(owner.request('POST', approval), context)).status).toBe(200)
    expect(generateJson).toHaveBeenCalledTimes(1)
    expect(maps.searchPlaces).toHaveBeenCalledTimes(4)
    expect(maps.computeRoute).toHaveBeenCalledTimes(4)
  })

  it('対象だけを適用し、履歴・一覧・再送を同じ確定結果に揃える', async () => {
    const { trip, revision } = await fixture()
    const started = Date.now()
    const response = await apply()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const result = ApplyRevisionResponseSchema.parse(await response.json())
    expect(result).toMatchObject({
      status: 'applied',
      appliedTripVersion: 1,
      verification: 'fresh',
    })
    expect(result.trip.stops[1].evidence).toHaveLength(4)
    const storedTrip = await readTrip()
    expect(storedTrip).toEqual({
      ...trip,
      version: 1,
      stops: [trip.stops[0], { ...trip.stops[1], ...candidateB }, trip.stops[2]],
    })
    expect(result.revision).toMatchObject({
      ...revision,
      impactSummary: expect.any(String),
      diff: { before: trip.stops[1], after: storedTrip.stops[1] },
      approval: { status: 'approved' },
    })
    expect(Date.parse(result.revision.approval.decidedAt)).toBeGreaterThanOrEqual(started)
    expect(Date.parse(result.revision.approval.decidedAt)).toBeLessThanOrEqual(Date.now())
    expect(maps.searchPlaces).toHaveBeenCalledTimes(4)
    expect(maps.searchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(trip.stops[1].name),
        includeOpeningHours: false,
      }),
      // 有料の照会は計量済みclientを通り、操作の中断シグナルが渡る。
      expect.any(AbortSignal),
    )
    expect(maps.computeRoute.mock.calls.map(([options]) => options)).toEqual(
      expect.arrayContaining([
        { originPlaceId: 'place-1', destinationPlaceId: 'place-b', mode: 'WALK' },
        { originPlaceId: 'place-b', destinationPlaceId: 'place-3', mode: 'WALK' },
      ]),
    )

    expect(await readRevision()).toEqual(result.revision)
    const list = await listRevisions(owner.request(), context)
    expect(RevisionListResponseSchema.parse(await list.json()).revisions).toEqual([result.revision])
    const raw = (await db().getAll(tripRef(), revisionRef())).map((snapshot) => snapshot.data())
    expect(JSON.stringify(raw)).not.toMatch(
      /evidence|constraintCheck|impactSummary|openingHours|distanceMeters|checkedAt|クライアントの申告/,
    )

    // 応答を取り損ねた後に別の更新が入っても、元の確定版と現在のTripを区別できる。
    expect(
      (
        await updateTrip(
          owner.request('PATCH', { expectedVersion: 1, preferences: ['後の編集'] }),
          context,
        )
      ).status,
    ).toBe(200)
    const replay = await apply()
    expect(replay.status).toBe(200)
    expect(ApplyRevisionResponseSchema.parse(await replay.json())).toEqual({
      ...result,
      status: 'already_applied',
      verification: 'not_available',
      trip: await readTrip(),
    })
    expect((await readTrip()).version).toBe(2)
    expect(maps.searchPlaces).toHaveBeenCalledTimes(4)
    await expectCode(await apply({ ...approval, expectedVersion: 1 }), 409, 'version_conflict')
  })

  it('生成時に指定した移動手段を保存時に引き継ぎ、再照合で使用する', async () => {
    await fixture({ travelModes: ['drive'] })
    expect((await apply()).status).toBe(200)
    expect(maps.computeRoute).toHaveBeenCalledTimes(2)
    expect(maps.computeRoute.mock.calls.every(([options]) => options.mode === 'DRIVE')).toBe(true)
  })

  it('末尾の予定は前からの移動だけを照合し、対象外の旧形式のStopをそのまま保持する', async () => {
    const trip = await seedTrip({
      ...tripInput,
      stops: [
        { ...tripInput.stops[0], placeId: null },
        tripInput.stops[1],
        { ...tripInput.stops[2], isFixed: false },
      ],
    })
    const stops = (await tripRef().get()).get('trip.stops')
    const { planName, ...legacyStop } = stops[0]
    stops[0] = { ...legacyStop, name: planName }
    await tripRef().update({ 'trip.stops': stops })
    const before = trip.stops[2]
    await seedRevision(trip, {
      targetStopId: before.id,
      diff: { before, after: { ...before, ...candidateB } },
    })
    expect((await apply()).status).toBe(200)
    expect(maps.computeRoute.mock.calls).toEqual([
      [
        { originPlaceId: 'place-2', destinationPlaceId: 'place-b', mode: 'WALK' },
        expect.any(AbortSignal),
      ],
    ])
    expect((await tripRef().get()).get('trip.stops').slice(0, 2)).toEqual(stops.slice(0, 2))
    expect((await readTrip()).stops.slice(0, 2)).toEqual(trip.stops.slice(0, 2))
  })

  it('認証・所有者・存在・IDをMaps照合前に検査する', async () => {
    await fixture()
    const ownRequest = () => owner.request('POST', approval)
    await expectCode(
      await applyRevision(new Request('http://localhost/api', { method: 'POST' }), context),
      401,
      'unauthenticated',
    )
    await expectCode(
      await applyRevision(other.request('POST', approval), context),
      404,
      'not_found',
    )
    for (const missing of [
      { ...params, tripId: 'missing' },
      { ...params, revisionId: 'missing' },
    ]) {
      await expectCode(
        await applyRevision(ownRequest(), { params: Promise.resolve(missing) }),
        404,
        'not_found',
      )
    }
    for (const invalid of [
      { ...params, tripId: '..' },
      { ...params, tripId: 'generate' },
      { ...params, revisionId: 'a'.repeat(257) },
      { ...params, revisionId: '\ud800' },
    ]) {
      await expectCode(
        await applyRevision(ownRequest(), { params: Promise.resolve(invalid) }),
        400,
        'invalid_request',
      )
    }
    await revisionRef().update({ ownerUid: other.uid })
    await expectCode(await apply(), 404, 'not_found')
    await tripRef().update({ ownerUid: other.uid })
    await expectCode(await apply(), 404, 'not_found')
    expect(maps.searchPlaces).not.toHaveBeenCalled()
  })

  it('明示承認と期待版のみ受理し、機能フラグで停止できる', async () => {
    const { trip } = await fixture()
    for (const input of [
      { expectedVersion: 0 },
      { expectedVersion: 0, confirm: false },
      { ...approval, approval: { status: 'approved', decidedAt: new Date().toISOString() } },
      { ...approval, constraintCheck: { status: 'satisfied' } },
      { ...approval, evidence: [] },
      { ...approval, trip },
      { ...approval, travelModes: ['drive'] },
    ]) {
      await expectCode(await apply(input), 400, 'invalid_request')
    }
    vi.stubEnv('TRIP_REVISION_APPLY_ENABLED', 'false')
    await expectCode(await apply(), 503, 'revision_apply_disabled')
    expect(maps.searchPlaces).not.toHaveBeenCalled()
    await expectUnchanged(trip)
  })

  it.each([
    ['simulated', 'revision_simulated'],
    ['actual', 'revision_unverified'],
  ] as const)('現地報告 %s の適用を停止する', async (kind, code) => {
    const { trip } = await fixture({
      context: { phase: 'on_site', report: { kind, description: '休業' } },
    })
    await expectCode(await apply(), 422, code)
    if (kind === 'simulated') expect(maps.searchPlaces).not.toHaveBeenCalled()
    await expectUnchanged(trip)
  })

  it('却下済みRevisionは再承認できない', async () => {
    const { trip } = await fixture()
    const rejected = { status: 'rejected', decidedAt: new Date().toISOString() }
    await revisionRef().update({ 'revision.approval': rejected })
    await expectCode(await apply(), 409, 'revision_not_pending')
    expect(maps.searchPlaces).not.toHaveBeenCalled()
    expect(await readTrip()).toEqual(trip)
    expect((await readRevision()).approval).toEqual(rejected)
  })

  it('期待版・候補の基準版・現行版が一致しない場合と移動手段のない旧候補を拒否する', async () => {
    const { trip } = await fixture()
    await expectCode(await apply({ ...approval, expectedVersion: 1 }), 409, 'version_conflict')
    await revisionRef().update({ 'revision.travelModes': FieldValue.delete() })
    await expectCode(await apply(), 409, 'revision_travel_modes_missing')
    await expectUnchanged(trip)
    const updated = await updateTrip(
      owner.request('PATCH', { expectedVersion: 0, preferences: ['変更'] }),
      context,
    )
    expect(updated.status).toBe(200)
    await expectCode(await apply(), 409, 'version_conflict')
    await expectCode(await apply({ ...approval, expectedVersion: 1 }), 409, 'version_conflict')
    expect(maps.searchPlaces).not.toHaveBeenCalled()
  })

  it.each([
    ['開始時刻', { plannedStartTime: '12:10' }],
    ['滞在時間', { durationMinutes: 45 }],
    ['種別', { kind: 'sight' }],
  ] satisfies [string, Partial<Stop>][])('変更範囲を越える%sを拒否する', async (_label, change) => {
    const trip = await seedTrip()
    const before = trip.stops[1]
    await seedRevision(trip, { diff: { before, after: { ...before, ...candidateB, ...change } } })
    await expectCode(await apply(), 409, 'revision_mismatch')
    expect(maps.searchPlaces).not.toHaveBeenCalled()
    await expectUnchanged(trip)
  })

  it.each([
    ['固定状態', { isFixed: true }],
    ['変更前の予定', { planName: '保存後に書き換わった予定' }],
    ['対象ID', { id: 'missing-stop' }],
  ])('現行Tripの%sが候補と整合しないとき拒否する', async (_label, change) => {
    await fixture()
    const snapshot = await tripRef().get()
    const stops = snapshot.get('trip.stops')
    stops[1] = { ...stops[1], ...change }
    await tripRef().update({ 'trip.stops': stops })
    const current = await readTrip()
    await expectCode(await apply(), 409, 'revision_mismatch')
    expect(maps.searchPlaces).not.toHaveBeenCalled()
    await expectUnchanged(current)
  })

  it.each([
    [
      '営業時間が不明',
      'revision_unverified',
      () =>
        maps.searchPlaces.mockImplementation(async (options) =>
          options.includeOpeningHours
            ? foundPlace(candidateB.name, candidateB.placeId, { status: 'unavailable' })
            : normalSearch(options),
        ),
    ],
    [
      '営業時間が矛盾',
      'revision_not_applicable',
      () =>
        maps.searchPlaces.mockImplementation(async (options) =>
          options.includeOpeningHours
            ? foundPlace(candidateB.name, candidateB.placeId, {
                status: 'available',
                periods: [
                  { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 19, minute: 0 } },
                ],
              })
            : normalSearch(options),
        ),
    ],
    [
      '施設名が不一致',
      'revision_not_applicable',
      () =>
        maps.searchPlaces.mockImplementation(async (options) =>
          options.includeOpeningHours
            ? foundPlace('同定できない施設', candidateB.placeId)
            : normalSearch(options),
        ),
    ],
    [
      '候補のPlace IDが不一致',
      'revision_place_mismatch',
      () =>
        maps.searchPlaces.mockImplementation(async (options) =>
          options.includeOpeningHours
            ? foundPlace(candidateB.name, '別の施設')
            : normalSearch(options),
        ),
    ],
    [
      '固定予定のPlace IDが不一致',
      'revision_endpoints_changed',
      () =>
        maps.searchPlaces.mockImplementation(async (options) =>
          options.query.startsWith(tripInput.stops[2].name)
            ? foundPlace(tripInput.stops[2].name, '別の施設')
            : normalSearch(options),
        ),
    ],
    [
      '前後の施設を特定できない',
      'revision_unverified',
      () =>
        maps.searchPlaces.mockImplementation(async (options) =>
          options.includeOpeningHours ? normalSearch(options) : { status: 'no_candidates' },
        ),
    ],
    [
      '固定予定に間に合わない',
      'revision_not_applicable',
      () =>
        maps.computeRoute.mockImplementation(async (options) =>
          route(options.destinationPlaceId === 'place-3' ? 46 : 10),
        ),
    ],
    [
      '経路が不明',
      'revision_unverified',
      () => maps.computeRoute.mockResolvedValue({ status: 'no_route' }),
    ],
  ] as const)('%s場合は照合済みとみなさない', async (_label, code, mock) => {
    const { trip, revision } = await fixture()
    expect(revision.diff.after.evidence).toEqual([])
    expect(revision.constraintCheck.status).toBe('not_checked')
    mock()
    await expectCode(await apply(), code === 'revision_endpoints_changed' ? 409 : 422, code)
    expect(maps.searchPlaces).toHaveBeenCalled()
    await expectUnchanged(trip)
  })

  it.each(['Places', 'Routes'])(
    '%sの通信失敗を情報不足と区別し、元Tripを維持する',
    async (service) => {
      const { trip } = await fixture()
      const mock = service === 'Places' ? maps.searchPlaces : maps.computeRoute
      mock.mockRejectedValueOnce(new Error('injected Maps outage'))
      await expectCode(await apply(), 502, 'external_service_error')
      await expectUnchanged(trip)
    },
  )

  it.each([
    { label: '空', evidence: [] },
    {
      label: '矛盾',
      evidence: [
        {
          ...sampleRevision.diff.after.evidence[0],
          subject: 'other',
          source: { kind: 'user_report', label: '現地報告' },
          status: 'conflicting',
        },
      ],
    },
  ] satisfies { label: string; evidence: Stop['evidence'] }[])(
    'satisfiedでも新しい根拠が$labelなら適用しない',
    async ({ evidence }) => {
      const { trip, revision } = await fixture()
      vi.spyOn(revisionChecks, 'checkRevisionConstraints').mockResolvedValueOnce({
        status: 'checked',
        constraintCheck: { status: 'satisfied', explanation: '制約は成立' },
        after: { ...revision.diff.after, evidence },
      })
      await expectCode(await apply(), 422, 'revision_unverified')
      await expectUnchanged(trip)
    },
  )

  it.each([null, 'place-2'])('候補のPlace IDが %s ならMapsを呼ばず拒否する', async (placeId) => {
    const trip = await seedTrip()
    const before = trip.stops[1]
    await seedRevision(trip, { diff: { before, after: { ...before, ...candidateB, placeId } } })
    await expectCode(await apply(), 422, 'revision_place_mismatch')
    expect(maps.searchPlaces).not.toHaveBeenCalled()
    await expectUnchanged(trip)
  })

  it('保存済みの予定に時刻の重なりがあれば照合前に拒否する', async () => {
    await fixture()
    const stops = (await tripRef().get()).get('trip.stops')
    stops[0].durationMinutes = 125
    await tripRef().update({ 'trip.stops': stops })
    const trip = await readTrip()
    await expectCode(await apply(), 422, 'revision_not_applicable')
    expect(maps.searchPlaces).not.toHaveBeenCalled()
    await expectUnchanged(trip)
  })

  it.each(['same', 'different'])(
    '並行承認（%s Revision）で版を一度しか増やさない',
    async (kind) => {
      const { trip } = await fixture()
      const secondId = kind === 'same' ? params.revisionId : 'revision-c'
      const secondContext = { params: Promise.resolve({ ...params, revisionId: secondId }) }
      if (kind === 'different') {
        const before = trip.stops[1]
        await seedRevision(trip, {
          id: secondId,
          diff: { before, after: { ...before, ...candidateC } },
        })
      }
      const gate = holdMaps(2)
      const first = apply()
      const second = applyRevision(owner.request('POST', approval), secondContext)
      await gate.started
      gate.release()
      const responses = await Promise.all([first, second])
      const statuses = await Promise.all(
        responses.map(async (response) => {
          if (response.status === 200) {
            return ApplyRevisionResponseSchema.parse(await response.json()).status
          }
          await expectCode(response, 409, 'version_conflict')
          return 'conflict'
        }),
      )
      expect(statuses.sort()).toEqual(
        kind === 'same' ? ['already_applied', 'applied'] : ['applied', 'conflict'],
      )
      expect((await readTrip()).version).toBe(1)
      const list = await listRevisions(owner.request(), context)
      const { revisions } = RevisionListResponseSchema.parse(await list.json())
      expect(revisions.filter(({ approval }) => approval.status === 'approved')).toHaveLength(1)
    },
  )

  it('Maps照合中にTrip版が進んだ場合は新しいTripを保つ', async () => {
    const { trip } = await fixture()
    const gate = holdMaps()
    const pending = apply()
    try {
      await gate.started
      const updated = await updateTrip(
        owner.request('PATCH', { expectedVersion: 0, preferences: ['別の編集'] }),
        context,
      )
      expect(updated.status).toBe(200)
    } finally {
      gate.release()
    }
    await expectCode(await pending, 409, 'version_conflict')
    await expectUnchanged({ ...trip, version: 1, preferences: ['別の編集'] })
  })

  it('同じ版でも照合中にRevisionが書き換わった場合は適用しない', async () => {
    const { trip } = await fixture()
    const gate = holdMaps()
    const pending = apply()
    try {
      await gate.started
      await revisionRef().update({ 'revision.diff.after.planName': candidateC.name })
    } finally {
      gate.release()
    }
    await expectCode(await pending, 409, 'version_conflict')
    await expectUnchanged(trip)
    expect((await readRevision()).diff.after.name).toBe(candidateC.name)
  })

  it('Maps照合中にTripが元と同じ内容へ戻っても更新時刻のABAを検出する', async () => {
    const { trip } = await fixture()
    const gate = holdMaps()
    const pending = apply()
    try {
      await gate.started
      await tripRef().update({ 'trip.preferences': ['一時変更'] })
      await tripRef().update({ 'trip.preferences': trip.preferences })
    } finally {
      gate.release()
    }
    await expectCode(await pending, 409, 'version_conflict')
    await expectUnchanged(trip)
  })

  it('Firestoreがコミットを拒否した場合にTrip更新と承認のどちらも残さない', async () => {
    const { trip } = await fixture()
    const firestore = db()
    const run = firestore.runTransaction.bind(firestore)
    vi.spyOn(firestore, 'runTransaction').mockImplementation((operation, options) => {
      if (options?.readOnly) return run(operation, options)
      return run(async (transaction) => {
        const result = await operation(transaction)
        // Emulator側でALREADY_EXISTSにして、実際のコミット全体を拒否させる。
        transaction.create(tripRef().collection('revisions').doc(params.revisionId), {})
        return result
      }, options)
    })
    await expectCode(await apply(), 503, 'apply_result_unknown')
    expect(maps.computeRoute).toHaveBeenCalledTimes(2)
    await expectUnchanged(trip)
  })

  it.each([true, false])(
    '確定後にコミット応答が失われても再取得で照合できる（直後のDB読取 %s）',
    async (readable) => {
      await fixture()
      const firestore = db()
      const run = firestore.runTransaction.bind(firestore)
      let committed = false
      vi.spyOn(firestore, 'runTransaction').mockImplementation(async (operation, options) => {
        if (options?.readOnly) {
          if (committed && !readable) throw new Error('injected read-back outage')
          return run(operation, options)
        }
        await run(operation, options)
        committed = true
        throw Object.assign(new Error('injected lost commit acknowledgement'), { code: 14 })
      })
      const response = await apply()
      if (readable) {
        expect(response.status).toBe(200)
        expect(ApplyRevisionResponseSchema.parse(await response.json()).status).toBe(
          'already_applied',
        )
      } else {
        await expectCode(response, 503, 'apply_result_unknown')
      }
      vi.restoreAllMocks()
      const trip = await readTrip()
      const revision = await readRevision()
      expect(trip.version).toBe(1)
      expect(revision.approval.status).toBe('approved')
      expect(trip.stops[1]).toEqual(revision.diff.after)
      const replay = await apply()
      expect(replay.status).toBe(200)
      expect(ApplyRevisionResponseSchema.parse(await replay.json())).toMatchObject({
        status: 'already_applied',
        appliedTripVersion: 1,
        trip,
        revision,
      })
      expect(maps.searchPlaces).toHaveBeenCalledTimes(4)
    },
  )
})
