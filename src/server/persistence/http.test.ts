import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as approve } from '@/app/api/learnings/[learningId]/approve/route'
import { POST as saveRevision } from '@/app/api/trips/[tripId]/revisions/route'
import { PATCH as updateTrip } from '@/app/api/trips/[tripId]/route'
import { GET as listTrips, POST as createTrip } from '@/app/api/trips/route'
import { sampleLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import { getAdminFirestore } from '@/lib/firebase/admin'
import { FirebaseConfigurationError } from '@/lib/firebase/config'
import { LearningStoreError } from '@/server/learnings/store'

import { PersistenceError } from './errors'

const verifyIdToken = vi.hoisted(() => vi.fn())
vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken }),
  getAdminFirestore: vi.fn(),
}))

const trip = { ...sampleTrip, learningApplications: [] }

function request(body?: unknown, authorization = 'Bearer a.b.c') {
  return new Request('http://localhost/api/trips', {
    headers: { authorization, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('PERSISTENCE_ENABLED', 'true')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  verifyIdToken.mockResolvedValue({ uid: 'actor' })
  vi.mocked(getAdminFirestore).mockImplementation(() => {
    throw Object.assign(new Error('private credential and UID'), { code: 7 })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Firestore APIのHTTP境界', () => {
  it.each([undefined, 'false', '1'])(
    '明示的に有効化するまでは認証・本文・DBを処理しない (%s)',
    async (value) => {
      vi.stubEnv('PERSISTENCE_ENABLED', value)
      const incoming = request(trip)
      const response = await createTrip(incoming)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: 'persistence_disabled' } })
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(incoming.bodyUsed).toBe(false)
      expect(verifyIdToken).not.toHaveBeenCalled()
      expect(getAdminFirestore).not.toHaveBeenCalled()
      expect(console.error).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['auth/argument-error', 'invalid_token'],
    ['auth/id-token-revoked', 'session_revoked'],
    ['auth/id-token-expired', 'token_expired'],
  ])('認証失敗 %s は保存先への接続前に拒否する', async (code, expected) => {
    verifyIdToken.mockRejectedValue({ code })
    const response = await createTrip(request(trip))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: expected } })
    expect(verifyIdToken).toHaveBeenCalledWith('a.b.c', true)
    expect(getAdminFirestore).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('不正な入力・所有者・新しい版・承認の自己申告は入力エラーにする', async () => {
    const tripContext = { params: Promise.resolve({ tripId: trip.id }) }
    const learningContext = { params: Promise.resolve({ learningId: 'learning' }) }
    const responses = await Promise.all([
      createTrip(request({ ...trip, ownerUid: 'other' })),
      createTrip(request({ ...trip, version: 5 })),
      createTrip(
        request({
          ...trip,
          stops: [{ ...trip.stops[0], displayName: 'Places取得名' }, ...trip.stops.slice(1)],
        }),
      ),
      updateTrip(request({ expectedVersion: 0, version: 1, preferences: [] }), tripContext),
      updateTrip(request({ expectedVersion: 0, preferences: [], stops: trip.stops }), tripContext),
      approve(
        request({
          expectedVersion: 0,
          sourceTripId: trip.id,
          category: 'preference',
          content: '本人が確認する内容',
          scope: { kind: 'all_trips' },
          approval: { status: 'approved', decidedAt: '2026-11-07T00:00:00Z' },
        }),
        learningContext,
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400])
    expect(getAdminFirestore).not.toHaveBeenCalled()
  })

  it('ネストしたID・予定名・希望・現地報告・学びの不正UnicodeをDBに接続する前に拒否する', async () => {
    const high = String.fromCharCode(0xd800)
    const low = String.fromCharCode(0xdc00)
    const tripContext = { params: Promise.resolve({ tripId: trip.id }) }
    const learningContext = { params: Promise.resolve({ learningId: sampleLearning.id }) }
    const learning = {
      expectedVersion: 0,
      sourceTripId: trip.id,
      category: sampleLearning.category,
      content: sampleLearning.content,
      scope: sampleLearning.scope,
    }
    const responses = await Promise.all([
      createTrip(
        request({ ...trip, stops: [{ ...trip.stops[0], id: high }, ...trip.stops.slice(1)] }),
      ),
      createTrip(
        request({ ...trip, stops: [{ ...trip.stops[0], name: low }, ...trip.stops.slice(1)] }),
      ),
      updateTrip(request({ expectedVersion: 0, preferences: ['希望' + high] }), tripContext),
      saveRevision(
        request({
          ...sampleRevision,
          context: { phase: 'on_site', report: { kind: 'actual', description: low } },
        }),
        tripContext,
      ),
      approve(request({ ...learning, scope: { kind: 'region', region: high } }), learningContext),
      approve(request({ ...learning, content: low }), learningContext),
    ])
    for (const response of responses) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
    }
    expect(getAdminFirestore).not.toHaveBeenCalled()
  })

  it('413・415・予約ID・文字列と配列の上限・学びの自己申告をDBアクセス前に拒否する', async () => {
    const incoming = request(trip)
    incoming.headers.set('Content-Type', 'text/plain')
    const tripContext = { params: Promise.resolve({ tripId: trip.id }) }
    const learning = {
      expectedVersion: 0,
      sourceTripId: trip.id,
      category: sampleLearning.category,
      content: sampleLearning.content,
      scope: sampleLearning.scope,
    }
    const responses = await Promise.all([
      createTrip(incoming),
      createTrip(request({ ...trip, region: 'x'.repeat(65_536) })),
      ...['generate', 'verify', 'revise', '.', '..', 'x'.repeat(257)].map((id) =>
        createTrip(request({ ...trip, id })),
      ),
      createTrip(request({ ...trip, learningApplications: sampleTrip.learningApplications })),
      createTrip(request({ ...trip, region: '町'.repeat(121) })),
      createTrip(
        request({
          ...trip,
          stops: [{ ...trip.stops[0], name: '名'.repeat(201) }, ...trip.stops.slice(1)],
        }),
      ),
      updateTrip(request({ expectedVersion: 0, preferences: Array(17).fill('希望') }), tripContext),
      updateTrip(request({ expectedVersion: 0, preferences: ['希'.repeat(201)] }), tripContext),
      saveRevision(request({ ...sampleRevision, reason: '理'.repeat(1001) }), tripContext),
      approve(request({ ...learning, content: '学'.repeat(121) }), {
        params: Promise.resolve({ learningId: 'learning' }),
      }),
      approve(request(learning), { params: Promise.resolve({ learningId: 'candidates' }) }),
    ])
    expect(responses[0].status).toBe(415)
    expect(responses[1].status).toBe(413)
    expect(responses.slice(2).every(({ status }) => status === 400)).toBe(true)
    expect(getAdminFirestore).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([
    [new FirebaseConfigurationError(), 503, 'storage_unavailable', 'firebase_configuration'],
    [
      Object.assign(new Error('internal IAM path'), { code: 7 }),
      503,
      'storage_unavailable',
      'firestore_permission',
    ],
    [
      Object.assign(new Error('database path'), { code: 5 }),
      503,
      'storage_unavailable',
      'firestore_database',
    ],
    [
      Object.assign(
        new Error(
          '2 UNKNOWN: Getting metadata from plugin failed with error: Could not load the default credentials. internal path',
        ),
        { code: 2 },
      ),
      503,
      'storage_unavailable',
      'firestore_credentials',
    ],
    [new Error('private unexpected error'), 500, 'internal_error', 'unexpected'],
    [
      new LearningStoreError('not_approved', 'private draft'),
      500,
      'internal_error',
      'learning_not_approved',
    ],
    [
      new PersistenceError('invalid_stored_data'),
      500,
      'invalid_stored_data',
      'stored_document_invalid',
    ],
  ] as const)(
    '障害ケース %# を分類し、内部情報を応答・ログに渡さない',
    async (error, status, code, diagnostic) => {
      vi.mocked(getAdminFirestore).mockImplementationOnce(() => {
        throw error
      })
      const response = await listTrips(request())
      expect(response.status).toBe(status)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(await response.json()).toEqual({ error: { code, message: expect.any(String) } })
      expect(console.error).toHaveBeenCalledExactlyOnceWith('persistence_failure', {
        code: diagnostic,
      })
    },
  )

  it('同じ障害の診断ログを抑制し、別の障害と抑制期間後の再発は記録する', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.mocked(getAdminFirestore).mockImplementation(() => {
      throw Object.assign(new Error('private backend details'), { code: 14 })
    })
    await listTrips(request())
    await listTrips(request())
    vi.mocked(getAdminFirestore).mockImplementationOnce(() => {
      throw Object.assign(new Error('private limit details'), { code: 8 })
    })
    await listTrips(request())
    now += 60_000
    await listTrips(request())
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ['persistence_failure', { code: 'firestore_unavailable' }],
      ['persistence_failure', { code: 'firestore_capacity' }],
      ['persistence_failure', { code: 'firestore_unavailable' }],
    ])
  })

  it('版競合は500や障害ログに変換しない', async () => {
    vi.mocked(getAdminFirestore).mockImplementationOnce(() => {
      throw new LearningStoreError('version_conflict', 'internal version')
    })
    const response = await listTrips(request())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'version_conflict' } })
    expect(console.error).not.toHaveBeenCalled()
  })
})
