import 'server-only'

import type { ApprovedLearning } from '@/domain'
import { AuthError, type Actor } from '@/lib/auth/server'
import { getAdminFirestore } from '@/lib/firebase/admin'
import { approveLearning, editLearning } from '@/lib/learnings/lifecycle'

import type { LearningStore } from '../learnings/store'
import {
  ApproveLearningBodySchema,
  LearningIdSchema,
  VersionSchema,
  type ApproveLearningBody,
  type VersionedLearning,
} from './contracts'
import {
  fromLearningDocument,
  fromTripDocument,
  toLearningDocument,
  toRevokedLearningDocument,
} from './dto'
import { parseInput, PersistenceError } from './errors'
import { LEARNING_LIMIT, reserveDocumentSlot } from './limits'
import { found, listOwned, ownedCollection, readOwned, recordKey } from './paths'

export class FirestoreLearningStore implements Pick<LearningStore, 'listApproved' | 'remove'> {
  constructor(private readonly db = getAdminFirestore()) {}

  private learnings(actor: Actor) {
    return ownedCollection(this.db, actor, 'learnings')
  }

  async approve(actor: Actor, id: string, input: ApproveLearningBody): Promise<VersionedLearning> {
    const { expectedVersion, ...draft } = parseInput(ApproveLearningBodySchema, input)
    const edited = editLearning(
      { ...draft, id: parseInput(LearningIdSchema, id), approval: { status: 'pending' } },
      draft,
    )
    if (!edited.ok) throw new PersistenceError('invalid_request')
    // この専用操作を認証済み本人が送った時だけ、サーバーで承認を発行する。
    const learning = approveLearning(edited.learning, new Date().toISOString())
    await this.#saveApproved(actor, learning, expectedVersion)
    return { version: expectedVersion + 1, learning }
  }

  // 承認の発行はapproveに限定する。
  async #saveApproved(actor: Actor, approved: ApprovedLearning, version: number) {
    const collection = this.learnings(actor)
    const ref = collection.doc(recordKey(approved.id))
    const source = ownedCollection(this.db, actor, 'trips').doc(recordKey(approved.sourceTripId))
    const document = toLearningDocument(actor, { version: version + 1, learning: approved })

    await this.db.runTransaction(async (transaction) => {
      const [snapshot, tripSnapshot] = await transaction.getAll(ref, source)
      const trip = found(readOwned(actor, tripSnapshot, fromTripDocument))
      const current = readOwned(actor, snapshot, fromLearningDocument)
      if (current === null) throw new PersistenceError('learning_revoked')
      if (!current && version !== 0) throw new AuthError('not_found')
      if ((current?.version ?? 0) !== version) {
        throw new PersistenceError('version_conflict')
      }
      if (
        (current &&
          (current.learning.sourceTripId !== approved.sourceTripId ||
            current.learning.category !== approved.category)) ||
        (approved.scope.kind === 'region' && approved.scope.region !== trip.region)
      ) {
        throw new PersistenceError('invalid_request')
      }
      if (!current) await reserveDocumentSlot(transaction, collection, LEARNING_LIMIT)
      transaction.set(ref, document)
    })
  }

  async get(actor: Actor, id: string): Promise<VersionedLearning> {
    const snapshot = await this.learnings(actor).doc(recordKey(id)).get()
    return found(readOwned(actor, snapshot, fromLearningDocument))
  }

  async list(actor: Actor) {
    return listOwned(actor, this.learnings(actor), LEARNING_LIMIT, fromLearningDocument)
  }

  // 版つきで返す。次回の旅程に使う学びの選択は、画面で見た版と照合するためこちらを使う。
  // 破損・打ち切りで不完全な一覧は、一部だけ採用せず拒否する。
  async listVersionedApproved(ownerUid: string): Promise<VersionedLearning[]> {
    const { items, listInfo } = await this.list({ uid: ownerUid })
    if (listInfo.skippedInvalid || listInfo.truncated) {
      throw new PersistenceError('invalid_stored_data')
    }
    return items
  }

  async listApproved(ownerUid: string): Promise<ApprovedLearning[]> {
    const items = await this.listVersionedApproved(ownerUid)
    return items.map(({ learning }) => learning)
  }

  async remove(ownerUid: string, id: string, expectedVersion: number): Promise<boolean> {
    const actor = { uid: ownerUid }
    const ref = this.learnings(actor).doc(recordKey(id))
    const version = parseInput(VersionSchema, expectedVersion)
    const revoked = toRevokedLearningDocument(actor, id)
    return this.db.runTransaction(async (transaction) => {
      const current = readOwned(actor, await transaction.get(ref), fromLearningDocument)
      if (!current) return false
      if (current.version !== version) throw new PersistenceError('version_conflict')
      // 内容は消し、同じIDへの初回承認リクエストの再送による復活だけを防ぐ。
      transaction.set(ref, revoked)
      return true
    })
  }
}
