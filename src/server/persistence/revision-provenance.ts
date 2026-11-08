import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { ReviseTripRequest, ReviseTripResponse, Trip } from '@/domain'
import { isRevisionEvidenceConflict } from '@/domain/revision-evidence'
import type { Actor } from '@/lib/auth/server'

import { normalizeModes } from '../verification/segment'
import { RevisionProofContextSchema, SaveRevisionBodySchema } from './contracts'
import { toRevisionDocument, toTripDocument } from './dto'
import { PersistenceError } from './errors'

const TTL_MS = 15 * 60 * 1000
type Document = ReturnType<typeof toRevisionDocument>

function signingKey() {
  const value = process.env.REVISION_PROPOSAL_SIGNING_KEY
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return
  const key = Buffer.from(value, 'base64url')
  if (key.toString('base64url') === value) return key
}

function signature(
  key: Buffer,
  actor: Actor,
  trip: Trip,
  document: Document,
  expiresAt: string,
  scope: string,
) {
  // 保存と照合に使う項目だけを固定する。肯定的なEvidenceや候補の表示文は認可に使わない。
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        'revision-proposal-v2',
        expiresAt,
        scope,
        toTripDocument(actor, trip),
        document,
      ]),
    )
    .digest()
}

export function issueRevisionProposalTokens(
  actor: Actor,
  request: ReviseTripRequest,
  response: ReviseTripResponse,
  reportVersion = 0,
): ReviseTripResponse {
  const key = signingKey()
  if (!key || response.status !== 'proposed') return response
  const expiresAt = String(Date.now() + TTL_MS)
  const modes = normalizeModes(request.travelModes)
  const proposalTokens = Object.fromEntries(
    response.revisions.flatMap((revision) => {
      // 本人報告以外の重大な矛盾を保存時に落として適用可能にしない。
      const hasUnstoredConflict =
        revision.diff.before.evidence.some(
          (item) =>
            item.source.kind !== 'user_report' && isRevisionEvidenceConflict(item, 'original'),
        ) ||
        revision.diff.after.evidence.some(
          (item) =>
            item.source.kind !== 'user_report' && isRevisionEvidenceConflict(item, 'candidate'),
        )
      const parsed = SaveRevisionBodySchema.safeParse(revision)
      const routeEndpoints = response.comparisons?.find(
        ({ revisionId }) => revisionId === revision.id,
      )?.routeEndpoints
      if (hasUnstoredConflict || !parsed.success || !routeEndpoints) return []
      const document = toRevisionDocument(actor, parsed.data, modes)
      const scope = Buffer.from(JSON.stringify({ reportVersion, routeEndpoints })).toString(
        'base64url',
      )
      const mac = signature(key, actor, request.trip, document, expiresAt, scope)
      return [[revision.id, `v2.${expiresAt}.${scope}.${mac.toString('base64url')}`]]
    }),
  )
  return { ...response, proposalTokens }
}

export function verifyRevisionProposal(
  actor: Actor,
  trip: Trip,
  document: Document,
  token: string,
) {
  const key = signingKey()
  if (!key) throw new PersistenceError('revision_provenance_unavailable')
  const [, expiresAt, scope, encoded] = token.split('.')
  const presented = Buffer.from(encoded, 'base64url')
  const expected = signature(key, actor, trip, document, expiresAt, scope)
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new PersistenceError('revision_provenance_invalid')
  }
  const expiration = Number(expiresAt)
  requireUnexpiredProposal(expiration)
  const proposalContext = RevisionProofContextSchema.parse(
    JSON.parse(Buffer.from(scope, 'base64url').toString('utf8')),
  )
  return { proposalExpiresAt: expiration, proposalContext }
}

export function requireUnexpiredProposal(expiresAt?: number) {
  if (expiresAt === undefined) throw new PersistenceError('revision_provenance_missing')
  if (Date.now() >= expiresAt) throw new PersistenceError('revision_proposal_expired')
}
