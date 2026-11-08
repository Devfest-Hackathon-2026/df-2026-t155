import { ApprovedLearningSchema, type ApprovedLearning } from '../../domain'
import { selectApplicableLearnings } from '../../lib/learnings/lifecycle'
import type { VersionedLearning } from '../persistence/contracts'

// 承認済みの学びの保存先。保存できるのは承認済みだけで、利用者ごとに分離する。
// ownerUidは、認証済みの利用者のUID（サーバーが検証した値）だけを渡す。リクエスト本文の値は渡さない。
export interface LearningStore {
  // 本人の承認操作から作った学びを保存する。新規は期待版0、再承認には現在の版を渡す。
  saveApproved(ownerUid: string, learning: ApprovedLearning, expectedVersion: number): Promise<void>
  // 内容と適用範囲を含めて、利用者の承認済みの学びを取得する。
  listApproved(ownerUid: string): Promise<ApprovedLearning[]>
  // 本人が学びを削除する（撤回）。存在しなければfalse。
  remove(ownerUid: string, learningId: string, expectedVersion: number): Promise<boolean>
}

export class LearningStoreError extends Error {
  constructor(
    readonly code: 'not_approved' | 'invalid_owner' | 'version_conflict',
    message: string,
  ) {
    super(message)
    this.name = 'LearningStoreError'
  }
}

const requireOwner = (ownerUid: string) => {
  if (ownerUid.trim().length === 0) {
    throw new LearningStoreError('invalid_owner', '利用者を特定できません')
  }
}

// 撤回済みは本文を消し、版だけを残す。同じIDを再保存しても、過去に発行した版を再利用しない。
type LearningRecords = Map<string, { learning: ApprovedLearning | null; version: number }>

// 開発・テスト・デモ用のメモリ実装。プロセスが終われば消える。永続化ではない。
export class InMemoryLearningStore implements LearningStore {
  private readonly byOwner = new Map<string, LearningRecords>()

  async saveApproved(
    ownerUid: string,
    learning: ApprovedLearning,
    expectedVersion?: number,
  ): Promise<void> {
    requireOwner(ownerUid)
    // 型だけでなく実行時にも、承認済みであることを契約で確かめる。
    const approved = ApprovedLearningSchema.safeParse(learning)
    if (!approved.success) {
      throw new LearningStoreError('not_approved', '承認済みの学びだけを保存できます')
    }
    const owned: LearningRecords = this.byOwner.get(ownerUid) ?? new Map()
    const current = owned.get(approved.data.id)
    const version = current?.version ?? 0
    // デモの直接呼び出しは従来どおり。LearningStore経由では期待版が必須。
    if (
      expectedVersion !== undefined &&
      (current?.learning === null || version !== expectedVersion)
    ) {
      throw new LearningStoreError('version_conflict', '保存内容の版が変わりました')
    }
    owned.set(approved.data.id, { learning: structuredClone(approved.data), version: version + 1 })
    this.byOwner.set(ownerUid, owned)
  }

  async listApproved(ownerUid: string): Promise<ApprovedLearning[]> {
    return (await this.listVersionedApproved(ownerUid)).map(({ learning }) => learning)
  }

  // 保存のたびに加算される版つきで返す。画面で見た版との照合に使う。
  async listVersionedApproved(ownerUid: string): Promise<VersionedLearning[]> {
    requireOwner(ownerUid)
    return [...(this.byOwner.get(ownerUid)?.values() ?? [])].flatMap((item) =>
      item.learning ? [{ version: item.version, learning: structuredClone(item.learning) }] : [],
    )
  }

  async remove(ownerUid: string, learningId: string, expectedVersion?: number): Promise<boolean> {
    requireOwner(ownerUid)
    const owned = this.byOwner.get(ownerUid)
    const current = owned?.get(learningId)
    if (!owned || !current || current.learning === null) return false
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new LearningStoreError('version_conflict', '保存内容の版が変わりました')
    }
    owned.set(learningId, { learning: null, version: current.version })
    return true
  }
}

// 次回の旅程生成に渡す学び。サーバーが自分でストアから取り出し、クライアントの自己申告を信用しない。
export async function getApplicableLearnings(
  store: Pick<LearningStore, 'listApproved'>,
  ownerUid: string,
  region: string,
): Promise<ApprovedLearning[]> {
  return selectApplicableLearnings(await store.listApproved(ownerUid), region)
}
