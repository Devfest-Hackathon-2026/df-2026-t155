import { describe, expect, it } from 'vitest'

import {
  sampleApprovedLearning,
  sampleLearning,
  sampleRevision,
  sampleTrip,
} from '@/domain/samples'

import { PendingRevisionSchema } from './contracts'
import {
  fromLearningDocument,
  fromRevisionDocument,
  fromTripDocument,
  toLearningDocument,
  toRevisionDocument,
  toRevokedLearningDocument,
  toTripDocument,
} from './dto'
import { documentKey } from './paths'

const actor = { uid: 'owner-a' }
const trip = { ...sampleTrip, learningApplications: [] }
const revision = PendingRevisionSchema.parse(sampleRevision)

describe('Firestore DTO', () => {
  it.each([
    { placeId: null, status: 'unverifiable' },
    { placeId: 'ChIJ-example', status: 'consistent' },
  ] as const)(
    'Place ID $placeId の場合も予定名を保持し、Placesの根拠を保存しない',
    ({ placeId, status }) => {
      const enriched = {
        ...trip.stops[0],
        placeId,
        evidence: [
          {
            ...trip.stops[0].evidence[0],
            source: { kind: 'places' as const, label: 'Places' },
            status,
            claim: 'Places表示名・営業時間 09:00〜17:00',
          },
        ],
      }
      const document = toTripDocument(actor, { ...trip, stops: [enriched, ...trip.stops.slice(1)] })
      expect(document.ownerUid).toBe(actor.uid)
      expect(document.trip.stops[0]).toMatchObject({ planName: enriched.name, placeId })
      expect(Object.keys(document.trip.stops[0]).sort()).toEqual([
        'durationMinutes',
        'id',
        'isFixed',
        'placeId',
        'planName',
        'plannedStartTime',
      ])
      expect(JSON.stringify(document)).not.toMatch(/evidence|Places表示名|営業時間|09:00/)
      const stored = fromTripDocument(document, trip.id)
      expect(stored).toMatchObject({ id: trip.id, version: 0 })
      expect(stored.stops[0]).toMatchObject({
        id: enriched.id,
        name: enriched.name,
        placeId,
        isFixed: true,
        evidence: [],
      })
    },
  )

  it('旧DTOの予定名とPlace IDも読み出せる', () => {
    const { trip: dto, ...document } = toTripDocument(actor, trip)
    const stops = dto.stops.map(({ planName, ...stop }, index) =>
      index === 0
        ? { ...stop, name: '場所（再確認が必要）', placeId: 'ChIJ-legacy' }
        : { ...stop, name: planName },
    )
    const restored = fromTripDocument({ ...document, trip: { ...dto, stops } }, trip.id)
    expect(restored.stops[0]).toMatchObject({
      name: '場所（再確認が必要）',
      placeId: 'ChIJ-legacy',
    })
    expect(restored.stops[1].name).toBe(trip.stops[1].name)
  })

  it('Revisionの前後差分と未承認状態を保持し、Routes由来の影響説明と判定は再確認扱いにする', () => {
    const document = toRevisionDocument(actor, {
      ...revision,
      impactSummary: 'Routesで所要13分',
      constraintCheck: { status: 'satisfied', explanation: 'Routesで所要13分' },
    })
    expect(JSON.stringify(document)).not.toMatch(/Routes|evidence|satisfied/)
    expect(fromRevisionDocument(document, revision.tripId, revision.id)).toMatchObject({
      id: revision.id,
      baseTripVersion: revision.baseTripVersion,
      diff: { before: { evidence: [] }, after: { evidence: [] } },
      constraintCheck: { status: 'not_checked' },
      approval: { status: 'pending' },
    })
  })

  it('共通契約に反する書き込み・読み取りとキーの食い違いを拒否する', () => {
    expect(() => toTripDocument(actor, { ...trip, version: -1 })).toThrow()
    const document = toTripDocument(actor, trip)
    document.trip.stops[1].id = document.trip.stops[0].id
    expect(() => fromTripDocument(document, trip.id)).toThrow()
    expect(() => fromTripDocument(toTripDocument(actor, trip), 'different-key')).toThrow()
    const revisionDoc = toRevisionDocument(actor, revision)
    revisionDoc.revision.diff.before.isFixed = true
    expect(() => fromRevisionDocument(revisionDoc, revision.tripId, revision.id)).toThrow()
  })

  it('承認済みLearningの往復と撤回を区別し、保存先に混入した未承認データを拒否する', () => {
    const record = { version: 1, learning: sampleApprovedLearning }
    const document = toLearningDocument(actor, record)
    expect(fromLearningDocument(document, record.learning.id)).toEqual(record)
    const revoked = toRevokedLearningDocument(actor, record.learning.id)
    expect(fromLearningDocument(revoked, record.learning.id)).toBeNull()
    expect(revoked).not.toHaveProperty('learning')
    expect(() =>
      fromLearningDocument({ ...document, learning: sampleLearning }, sampleLearning.id),
    ).toThrow()
  })

  it('区切り・予約名を含むIDでも衝突せず、元のIDを復元する', () => {
    const ids = ['a/b', 'a_b', '__proto__', '..', '~YS9i', '日本語']
    expect(new Set(ids.map(documentKey)).size).toBe(ids.length)
    for (const id of ids) {
      const document = toTripDocument(actor, { ...trip, id })
      expect(fromTripDocument(document, documentKey(id)).id).toBe(id)
    }
  })
})
