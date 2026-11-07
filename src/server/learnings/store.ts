import { ApprovedLearningSchema, type ApprovedLearning } from '../../domain'
import { selectApplicableLearnings } from '../../lib/learnings/lifecycle'

// 承認済みの学びの保存先。保存できるのは承認済みだけで、利用者ごとに分離する。
// ownerUidは、認証済みの利用者のUID（サーバーが検証した値）だけを渡す。リクエスト本文の値は渡さない。
// Firestore実装は、認証基盤（#10）が入ってから、このインターフェースに合わせて追加する。
export interface LearningStore {
  // 承認済みの学びだけを保存する（同じIDは上書き）。未承認・却下済みは拒否する。
  saveApproved(ownerUid: string, learning: ApprovedLearning): Promise<void>
  // 内容と適用範囲を含めて、利用者の承認済みの学びを取得する。
  listApproved(ownerUid: string): Promise<ApprovedLearning[]>
  // 本人が学びを削除する（撤回）。存在しなければfalse。
  remove(ownerUid: string, learningId: string): Promise<boolean>
}

export class LearningStoreError extends Error {
  constructor(
    readonly code: 'not_approved' | 'invalid_owner',
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

// 開発・テスト・デモ用のメモリ実装。プロセスが終われば消える。永続化ではない。
export class InMemoryLearningStore implements LearningStore {
  private readonly byOwner = new Map<string, Map<string, ApprovedLearning>>()

  async saveApproved(ownerUid: string, learning: ApprovedLearning): Promise<void> {
    requireOwner(ownerUid)
    // 型だけでなく実行時にも、承認済みであることを契約で確かめる。
    const approved = ApprovedLearningSchema.safeParse(learning)
    if (!approved.success) {
      throw new LearningStoreError('not_approved', '承認済みの学びだけを保存できます')
    }
    const owned = this.byOwner.get(ownerUid) ?? new Map<string, ApprovedLearning>()
    owned.set(approved.data.id, structuredClone(approved.data))
    this.byOwner.set(ownerUid, owned)
  }

  async listApproved(ownerUid: string): Promise<ApprovedLearning[]> {
    requireOwner(ownerUid)
    return [...(this.byOwner.get(ownerUid)?.values() ?? [])].map((item) => structuredClone(item))
  }

  async remove(ownerUid: string, learningId: string): Promise<boolean> {
    requireOwner(ownerUid)
    return this.byOwner.get(ownerUid)?.delete(learningId) ?? false
  }
}

// 次回の旅程生成に渡す学び。サーバーが自分でストアから取り出し、クライアントの自己申告を信用しない。
export async function getApplicableLearnings(
  store: LearningStore,
  ownerUid: string,
  region: string,
): Promise<ApprovedLearning[]> {
  return selectApplicableLearnings(await store.listApproved(ownerUid), region)
}
