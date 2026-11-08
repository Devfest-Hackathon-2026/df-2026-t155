import { z } from 'zod'

import type { ApprovedLearning } from '@/domain'
import {
  isLearningApplicableToRegion,
  isLearningContentReusable,
  normalizeLearningRegion,
} from '@/lib/learnings/lifecycle'
import {
  LearningSelectionSchema,
  VersionedLearningSchema,
  type VersionedLearning,
} from '@/server/persistence/contracts'
import { LEARNING_LIMIT } from '@/server/persistence/limits'

// 認証済みUIDは呼び出し側のサーバーで検証済みActorから渡す。
// クライアントはLearningの本文やapprovalを送らず、画面で見たIDと版だけを渡す。
const failures = {
  invalid_selection: [400, '学びの選択内容が正しくありません。'],
  selection_changed: [
    409,
    '選んだ学びが変更または撤回されました。最新の一覧を確認して選び直してください。',
  ],
  // 保存データの破損や保存先の障害。内部の詳細は含めない。学びを使わず旅程を作る道を案内する。
  unavailable: [
    503,
    '保存済みの学びを確認できません。学びを使わずに旅程を作るか、時間をおいて再試行してください。',
  ],
} as const

export class LearningSelectionError extends Error {
  constructor(readonly code: keyof typeof failures) {
    super(failures[code][1])
    this.name = 'LearningSelectionError'
  }

  // 統合側がHTTP応答へ変換するときの対応（PersistenceErrorと同じ考え方）。
  get status() {
    return failures[this.code][0]
  }
}

// 版つきで保存済みの学びを返せる、最小のストア。版を返せない実装は渡せない（型で拒否）。
// 実行時にも、返った値が版つきの承認済みでなければ採用しない。
export interface VersionedLearningSource {
  listVersionedApproved(ownerUid: string): Promise<VersionedLearning[]>
}

const SelectionsSchema = z
  .array(LearningSelectionSchema)
  .max(LEARNING_LIMIT)
  .refine((items) => new Set(items.map(({ id }) => id)).size === items.length)
const StoredSchema = z.array(VersionedLearningSchema)

// 利用者が画面で選んだ {id, version} を、サーバーが保存済みの本人の学びと照合して確定する。
// 画面で見た内容と違うものが黙って使われないよう、次のどれかに当てはまれば拒否する。
// - 他人の学び・存在しないID・撤回済み・適用地域が合わない（selection_changed）
// - 版が違う。再承認で内容が置き換わった可能性がある（selection_changed）
// - 保存済みの一覧を取得・検証できない、または本文が上限を超える（unavailable）
export async function resolveSelectedLearnings(
  store: VersionedLearningSource,
  ownerUid: string,
  region: string,
  selections: readonly { id: string; version: number }[],
): Promise<ApprovedLearning[]> {
  const parsed = SelectionsSchema.safeParse(selections)
  const normalizedRegion = normalizeLearningRegion(region)
  if (!ownerUid.trim() || !normalizedRegion || !parsed.success) {
    throw new LearningSelectionError('invalid_selection')
  }
  // 空選択なら、本人が学びを使わないと指定したものとして扱う。保存先は読まない。
  if (parsed.data.length === 0) return []

  let listed: unknown
  try {
    listed = await store.listVersionedApproved(ownerUid)
  } catch {
    // 破損文書や障害の詳細（例外の内容）は、利用者向けの応答に出さない。
    throw new LearningSelectionError('unavailable')
  }
  const stored = StoredSchema.safeParse(listed)
  if (!stored.success) throw new LearningSelectionError('unavailable')
  const byId = new Map(stored.data.map((record) => [record.learning.id, record]))
  // IDが重複する一覧は、どれが現行か判断できない。
  if (byId.size !== stored.data.length) throw new LearningSelectionError('unavailable')

  return parsed.data.map(({ id, version }) => {
    const record = byId.get(id)
    if (
      !record ||
      record.version !== version ||
      !isLearningApplicableToRegion(record.learning, normalizedRegion)
    ) {
      throw new LearningSelectionError('selection_changed')
    }
    // 保存時の上限を超える本文は、生成に渡さない（画面の取得・表示と同じ判定）。
    if (!isLearningContentReusable(record.learning)) {
      throw new LearningSelectionError('unavailable')
    }
    return record.learning
  })
}
