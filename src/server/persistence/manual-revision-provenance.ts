import 'server-only'

import { createHmac } from 'node:crypto'
import { z } from 'zod'

import {
  RevisionContextSchema,
  RevisionReasonSchema,
  type ReviseTripRequest,
  type ReviseTripResponse,
  type Trip,
} from '@/domain'
import { isRevisionEvidenceConflict, revisionReportUncertainty } from '@/domain/revision-evidence'
import { ManualRevisionGrantSchema } from '@/domain/manual-revision'
import { IdSchema } from '@/domain/primitives'
import { TripRecordIdSchema, TripStopNameSchema } from '@/domain/trip-write-limits'
import type { Actor } from '@/lib/auth/server'

import { toTripDocument } from './dto'
import { PersistenceError } from './errors'
import { getProvenanceSigningKey, matchesMac } from './provenance-key'
import { requireUnexpiredProposal } from './revision-provenance'

const TTL_MS = 15 * 60 * 1000

const GrantPayloadSchema = z.strictObject({
  id: ManualRevisionGrantSchema.shape.id,
  targetStopId: TripRecordIdSchema,
  name: TripStopNameSchema,
  placeId: IdSchema.max(1024).nullable(),
  reason: RevisionReasonSchema,
  context: RevisionContextSchema,
  reportVersion: z.int().nonnegative(),
  epoch: z.int().nonnegative(),
  expiresAt: z.int().positive(),
})

function sign(key: Buffer, actor: Actor, trip: Trip, payload: string) {
  return createHmac('sha256', key)
    .update(JSON.stringify(['manual-revision-v2', toTripDocument(actor, trip), payload]))
    .digest()
}

export function issueManualRevisionGrants(
  actor: Actor,
  request: ReviseTripRequest,
  response: ReviseTripResponse,
  reportVersion: number,
  epoch = 0,
): ReviseTripResponse {
  const key = getProvenanceSigningKey()
  if (
    !key ||
    response.status !== 'proposed' ||
    revisionReportUncertainty(request.context) ||
    (request.context.phase === 'on_site' && request.context.report.kind === 'simulated')
  )
    return response

  const expiresAt = Date.now() + TTL_MS
  const manualGrants = Object.fromEntries(
    response.revisions.flatMap((revision) => {
      // 隣接施設のPlace IDの不一致は候補側の矛盾として伝わる。
      const { before, after } = revision.diff
      if (
        revision.constraintCheck.status !== 'unknown' ||
        before.evidence.some((item) => isRevisionEvidenceConflict(item, 'original')) ||
        after.evidence.some((item) => isRevisionEvidenceConflict(item, 'candidate'))
      )
        return []
      const grant = GrantPayloadSchema.safeParse({
        id: `manual-${revision.id}`,
        targetStopId: revision.targetStopId,
        name: after.name,
        placeId: after.placeId,
        reason: revision.reason,
        context: revision.context,
        reportVersion,
        epoch,
        expiresAt,
      })
      if (!grant.success) return []
      const encoded = Buffer.from(JSON.stringify(grant.data)).toString('base64url')
      const token = `m2.${encoded}.${sign(key, actor, request.trip, encoded).toString('base64url')}`
      return [[revision.id, { id: grant.data.id, token }]]
    }),
  )
  return Object.keys(manualGrants).length ? { ...response, manualGrants } : response
}

export function verifyManualRevisionGrant(actor: Actor, trip: Trip, token: string) {
  const key = getProvenanceSigningKey()
  if (!key) throw new PersistenceError('revision_provenance_unavailable')
  const [version, encoded, mac] = token.split('.')
  if (version !== 'm2' || !matchesMac(mac, sign(key, actor, trip, encoded))) {
    throw new PersistenceError('revision_provenance_invalid')
  }
  const grant = GrantPayloadSchema.parse(
    JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
  )
  requireUnexpiredProposal(grant.expiresAt)
  return grant
}
