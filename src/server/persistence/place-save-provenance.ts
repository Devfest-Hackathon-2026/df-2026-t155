import 'server-only'

import { createHmac } from 'node:crypto'

import type { Trip } from '@/domain'
import { LEARNING_TRIP_ID_PATTERN } from '@/domain/learning-trip-protocol'
import type { Actor } from '@/lib/auth/server'

import { CreateTripBodySchema } from './contracts'
import { toTripDocument } from './dto'
import { PersistenceError } from './errors'
import { getProvenanceSigningKey, matchesMac } from './provenance-key'

const TTL_MS = 60 * 60 * 1000
type TripDocument = ReturnType<typeof toTripDocument>

function signature(key: Buffer, document: TripDocument, expiresAt: string) {
  const { trip, ownerUid } = document
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        'verified-place-save-v1',
        expiresAt,
        ownerUid,
        { ...trip, stops: trip.stops.map((stop) => ({ ...stop, isFixed: false })) },
      ]),
    )
    .digest()
}

// 照合サービスが検索から組み立て直した応答でだけ呼ぶ。
export function issuePlaceSaveProof(actor: Actor, trip: Trip): string | undefined {
  if (!LEARNING_TRIP_ID_PATTERN.test(trip.id) || !trip.stops.some(({ placeId }) => placeId)) return
  const key = getProvenanceSigningKey()
  // 一時的な根拠は保存用証跡にも含めない。
  const plan = CreateTripBodySchema.safeParse({
    ...trip,
    stops: trip.stops.map((stop) => ({ ...stop, evidence: [] })),
  })
  if (!key || !plan.success) return
  const expiresAt = String(Date.now() + TTL_MS)
  return `p1.${expiresAt}.${signature(key, toTripDocument(actor, plan.data), expiresAt).toString('base64url')}`
}

export function requireVerifiedPlaceIds(document: TripDocument, proof?: string): void {
  if (!document.trip.stops.some(({ placeId }) => placeId)) return
  const key = getProvenanceSigningKey()
  if (!proof || !key) throw new PersistenceError('learning_place_provenance_invalid')
  const [, expiresAt, mac] = proof.split('.')
  if (Date.now() >= Number(expiresAt) || !matchesMac(mac, signature(key, document, expiresAt))) {
    throw new PersistenceError('learning_place_provenance_invalid')
  }
}
