import 'server-only'

import type { CollectionReference, Transaction } from 'firebase-admin/firestore'
import { z } from 'zod'

import { parseStored, PersistenceError } from './errors'

export const TRIP_LIMIT = 20
export const REVISION_LIMIT = 12
export const LEARNING_LIMIT = 40

const CountSchema = z.strictObject({ count: z.int().nonnegative() })

// コレクションに初めて枠を設定するときだけ、先行文書を上限まで数える。
// カウンターと新規文書を同じトランザクションで確定し、並行作成で枠が増えないようにする。
export async function reserveDocumentSlot(
  transaction: Transaction,
  collection: CollectionReference,
  limit: number,
): Promise<void> {
  const parent = collection.parent
  if (!parent) throw new Error('保存枠には親文書が必要です')
  const ref = parent.collection('persistenceLimits').doc(collection.id)
  const snapshot = await transaction.get(ref)
  const count = snapshot.exists
    ? parseStored(CountSchema, snapshot.data()).count
    : (await transaction.get(collection.limit(limit))).size
  if (count >= limit) throw new PersistenceError('storage_limit_reached')
  transaction.set(ref, { count: count + 1 })
}
