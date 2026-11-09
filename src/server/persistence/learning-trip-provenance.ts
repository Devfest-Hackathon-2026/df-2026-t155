import 'server-only'

import { createHmac } from 'node:crypto'
import type { Transaction } from 'firebase-admin/firestore'

import type { ApprovedLearning, GenerateTripResponse, Trip } from '@/domain'
import { LEARNING_TRIP_ID_PATTERN, LEARNING_TRIP_ID_PREFIX } from '@/domain/learning-trip-protocol'
import { TRIP_SAVE_MAX_BYTES } from '@/domain/trip-write-limits'
import type { Actor } from '@/lib/auth/server'
import { isLearningApplicableToRegion } from '@/lib/learnings/lifecycle'

import {
  CreateTripBodySchema,
  requiresLearningSaveProof,
  type CreateTripBody,
  type LearningSelection,
} from './contracts'
import { fromLearningDocument, toTripDocument } from './dto'
import { PersistenceError } from './errors'
import { isLearningTripSaveEnabled } from './learning-trip-rollout'
import { ownedCollection, readOwned, recordKey } from './paths'
import { getProvenanceSigningKey, matchesMac } from './provenance-key'

const TTL_MS = 60 * 60 * 1000
type TripDocument = ReturnType<typeof toTripDocument>
type VerifiedProof = { key: Buffer; snapshot: string; expiresAt: number }

function snapshotMac(key: Buffer, learnings: readonly ApprovedLearning[]) {
  return createHmac('sha256', key)
    .update(JSON.stringify(['learning-trip-snapshot-v1', learnings]))
    .digest()
}

function signature(key: Buffer, document: TripDocument, expiresAt: string, snapshot: string) {
  const { stops, ...trip } = document.trip
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        'learning-trip-save-v1',
        expiresAt,
        snapshot,
        document.ownerUid,
        trip,
        // 保存前に照合で Place ID が、本人操作で固定状態が変わりうる。どちらも学びの適用の証明には使わない。
        stops.map((stop) => ({ ...stop, placeId: null, isFixed: false })),
      ]),
    )
    .digest()
}

export function attachLearningSaveProof(
  actor: Actor,
  response: GenerateTripResponse,
  selections: readonly LearningSelection[],
  learnings: readonly ApprovedLearning[],
  acceptsProtocol: boolean,
): GenerateTripResponse {
  if (response.status !== 'proposed') return response
  if (response.trip.learningApplications.length === 0) {
    return checkSavableProposal(response, response.trip)
  }
  // resolver が本人の現行版と照合した選択だけを渡す。AI出力や保存リクエストは版の出所にしない。
  const versions = new Map(selections.map(({ id, version }) => [id, version]))
  const byId = new Map(learnings.map((learning) => [learning.id, learning]))
  const applied: ApprovedLearning[] = []
  const trip: Trip = {
    ...response.trip,
    id: LEARNING_TRIP_ID_PREFIX + response.trip.id,
    learningApplications: response.trip.learningApplications.map((application) => {
      const learningVersion = versions.get(application.learningId)
      const learning = byId.get(application.learningId)
      if (!learning || learningVersion === undefined) {
        throw new Error('Unresolved learning application')
      }
      applied.push(learning)
      return { ...application, learningVersion }
    }),
  }
  if (!acceptsProtocol || !isLearningTripSaveEnabled()) {
    const preview = {
      ...response,
      trip: LEARNING_TRIP_ID_PATTERN.test(trip.id)
        ? { ...response.trip, id: trip.id }
        : response.trip,
    }
    return checkSavableProposal(
      acceptsProtocol ? { ...preview, learningSaveUnavailable: 'disabled' } : preview,
      trip,
    )
  }
  if (!LEARNING_TRIP_ID_PATTERN.test(trip.id)) return invalidProposal()
  const key = getProvenanceSigningKey()
  if (!key)
    return checkSavableProposal(
      { status: 'proposed', trip, learningSaveUnavailable: 'signing_unavailable' },
      trip,
    )
  if (!CreateTripBodySchema.safeParse(trip).success) return invalidProposal()
  const document = toTripDocument(actor, trip)
  const expiresAt = String(Date.now() + TTL_MS)
  const snapshot = snapshotMac(key, applied).toString('base64url')
  const mac = signature(key, document, expiresAt, snapshot).toString('base64url')
  const learningSaveProof = `v1.${expiresAt}.${snapshot}.${mac}`
  return checkSavableProposal(
    { status: 'proposed', trip, learningSaveProof },
    { ...trip, learningSaveProof },
  )
}

function invalidProposal(): GenerateTripResponse {
  return {
    status: 'no_candidates',
    message: '保存できる形式の旅程を作れませんでした。旅行条件を確認してから作り直してください。',
  }
}

function checkSavableProposal(response: GenerateTripResponse, body: unknown): GenerateTripResponse {
  const checked = CreateTripBodySchema.safeParse(body)
  return checked.success && Buffer.byteLength(JSON.stringify(checked.data)) <= TRIP_SAVE_MAX_BYTES
    ? response
    : invalidProposal()
}

export function verifyLearningSaveProof(
  document: TripDocument,
  proof?: string,
): VerifiedProof | undefined {
  const trip = document.trip
  if (!requiresLearningSaveProof(trip)) {
    if (proof !== undefined) throw new PersistenceError('learning_provenance_invalid')
    return
  }
  if (trip.learningApplications.length === 0) {
    throw new PersistenceError('learning_provenance_invalid')
  }
  if (!isLearningTripSaveEnabled()) throw new PersistenceError('learning_trip_save_disabled')
  if (proof === undefined) throw new PersistenceError('learning_provenance_missing')
  const key = getProvenanceSigningKey()
  if (!key) throw new PersistenceError('learning_provenance_unavailable')
  const [, expiresAt, snapshot, mac] = proof.split('.')
  if (!matchesMac(mac, signature(key, document, expiresAt, snapshot))) {
    throw new PersistenceError('learning_provenance_invalid')
  }
  const expiration = Number(expiresAt)
  requireUnexpiredLearningSaveProof(expiration)
  return { key, snapshot, expiresAt: expiration }
}

function requireUnexpiredLearningSaveProof(expiresAt: number) {
  if (Date.now() >= expiresAt) throw new PersistenceError('learning_provenance_expired')
}

export async function requireCurrentLearningApplications(
  transaction: Transaction,
  collection: ReturnType<typeof ownedCollection>,
  actor: Actor,
  { region, learningApplications }: Pick<CreateTripBody, 'region' | 'learningApplications'>,
  proof: VerifiedProof,
): Promise<void> {
  const refs = learningApplications.map(({ learningId }) => collection.doc(recordKey(learningId)))
  const snapshots = await transaction.getAll(...refs)
  const learnings = snapshots.map((snapshot, index) => {
    const record = readOwned(actor, snapshot, fromLearningDocument)
    if (
      !record ||
      snapshot.id !== refs[index].id ||
      record.version !== learningApplications[index].learningVersion ||
      !isLearningApplicableToRegion(record.learning, region)
    ) {
      throw new PersistenceError('learning_changed')
    }
    return record.learning
  })
  requireUnexpiredLearningSaveProof(proof.expiresAt)
  if (!matchesMac(proof.snapshot, snapshotMac(proof.key, learnings))) {
    throw new PersistenceError('learning_changed')
  }
}
