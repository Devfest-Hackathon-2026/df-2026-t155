import { ApprovedLearningSchema, type ApprovedLearning, type Learning } from '../../domain'

// 学び（Learning）の編集・承認・却下と、次回の旅程生成へ渡せる学びの選択。純粋ロジックで、
// 画面とサーバーの両方から使う。学びは本人が編集・承認したものだけが次回に反映される。
// 基盤モデルの再学習ではなく、本人のパーソナライズ設定の保存である。

export const MAX_LEARNING_CONTENT_LENGTH = 120

export type LearningEdit = { content?: string; scope?: Learning['scope'] }

export type EditResult = { ok: true; learning: Learning } | { ok: false; reason: string }

// 内容や適用範囲を編集した学びは、承認済みでも必ず未承認（pending）に戻す。再承認が必要。
// 元の学びは変更しない。内容が空・長すぎる場合は拒否する。
export function editLearning(learning: Learning, edit: LearningEdit): EditResult {
  const content = edit.content === undefined ? learning.content : edit.content.trim()
  if (content.length === 0) return { ok: false, reason: '学びの内容を入力してください' }
  if (content.length > MAX_LEARNING_CONTENT_LENGTH) {
    return { ok: false, reason: `学びの内容は${MAX_LEARNING_CONTENT_LENGTH}文字以内にしてください` }
  }
  const scope = edit.scope ?? learning.scope
  if (scope.kind === 'region' && scope.region.trim().length === 0) {
    return { ok: false, reason: '適用する地域を入力してください' }
  }
  return {
    ok: true,
    learning: { ...learning, content, scope, approval: { status: 'pending' } },
  }
}

// 本人が承認する。承認日時はタイムゾーン付きで必須。承認はクライアントの自己申告ではなく、
// サーバー側の本人確認の後に呼ぶこと（認可は別途必要）。
export function approveLearning(learning: Learning, decidedAt: string): ApprovedLearning {
  return ApprovedLearningSchema.parse({
    ...learning,
    approval: { status: 'approved', decidedAt },
  })
}

export function rejectLearning(learning: Learning, decidedAt: string): Learning {
  return { ...learning, approval: { status: 'rejected', decidedAt } }
}

// 次回の旅程生成に渡せるのは、承認済みで、適用範囲が合うものだけ。
// 各要素を契約で検証し直す（承認状態の申告を信用しない）。未承認・却下済み・地域違いは除く。
export function selectApplicableLearnings(
  learnings: readonly Learning[],
  region: string,
): ApprovedLearning[] {
  const applicable: ApprovedLearning[] = []
  for (const learning of learnings) {
    const approved = ApprovedLearningSchema.safeParse(learning)
    if (!approved.success) continue
    const { scope } = approved.data
    if (scope.kind === 'all_trips' || scope.region === region) applicable.push(approved.data)
  }
  return applicable
}
