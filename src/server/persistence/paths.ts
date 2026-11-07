import 'server-only'

import type { CollectionReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore'

import { AuthError, requireOwner, type Actor } from '@/lib/auth/server'

import { RecordIdSchema } from './contracts'
import { reportPersistenceFailure } from './diagnostics'
import { parseInput, PersistenceError } from './errors'

// 通常のIDはそのまま使い、区切り文字や予約名を含むIDは同じドメインIDのまま安全なキーに変換する。
export function documentKey(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) && !/^__.*__$/.test(id)
    ? id
    : `~${Buffer.from(id, 'utf8').toString('base64url')}`
}

export function ownedCollection(db: Firestore, actor: Actor, name: 'trips' | 'learnings') {
  if (!actor.uid || actor.uid.length > 128 || !actor.uid.isWellFormed()) {
    throw new AuthError('invalid_token')
  }
  return db.collection('users').doc(documentKey(actor.uid)).collection(name)
}

export function recordKey(id: string): string {
  return documentKey(parseInput(RecordIdSchema, id))
}

export function readOwned<T>(
  actor: Actor,
  snapshot: DocumentSnapshot,
  decode: (data: unknown, key: string) => T,
): T | undefined {
  const data = snapshot.data()
  if (data === undefined) return undefined
  if (typeof data.ownerUid !== 'string') throw new PersistenceError('invalid_stored_data')
  requireOwner(actor, data.ownerUid)
  return decode(data, snapshot.id)
}

export function found<T>(record: T | null | undefined): T {
  if (record == null) throw new AuthError('not_found')
  return record
}

export async function listOwned<T>(
  actor: Actor,
  collection: CollectionReference,
  limit: number,
  decode: (data: unknown, key: string) => T | null,
) {
  const { docs } = await collection.limit(limit + 1).get()
  const items: T[] = []
  let skippedInvalid = 0
  for (const doc of docs.slice(0, limit)) {
    try {
      const item = readOwned(actor, doc, decode)
      if (item != null) items.push(item)
    } catch (error) {
      if (error instanceof AuthError && error.code === 'not_found') continue
      if (!(error instanceof PersistenceError) || error.code !== 'invalid_stored_data') throw error
      skippedInvalid += 1
    }
  }
  if (skippedInvalid > 0) reportPersistenceFailure('stored_document_invalid')
  return {
    items,
    listInfo: { returned: items.length, skippedInvalid, truncated: docs.length > limit },
  }
}
