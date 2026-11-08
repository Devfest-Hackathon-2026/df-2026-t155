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

// 地域は前後の空白を除いた文字列の完全一致で照合する。全角・半角などの表記揺れの
// 正規化は未決定（docs/DOMAIN_CONTRACTS.md）。画面とサーバーで同じ関数を使い、
// 画面で見えた学びとサーバーが採用する学びがずれないようにする。
export function normalizeLearningRegion(region: string): string {
  return region.trim()
}

// 次回の旅程づくりに使える本文の長さか。取得（クライアントのZod）・表示・サーバー採用の
// 3か所で同じ関数を使い、境界ごとに判定がずれないようにする。
// 既存文書の読み取り互換のため、ApprovedLearningSchemaは上限を持たない。上限はここで確かめる。
export function isLearningContentReusable(learning: Pick<Learning, 'content'>): boolean {
  return learning.content.length <= MAX_LEARNING_CONTENT_LENGTH
}

// 全地域向け、または適用地域が（正規化後に）一致する学びか。
export function isLearningApplicableToRegion(learning: Learning, region: string): boolean {
  const { scope } = learning
  return scope.kind === 'all_trips' || scope.region === normalizeLearningRegion(region)
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
    if (isLearningApplicableToRegion(approved.data, region)) applicable.push(approved.data)
  }
  return applicable
}
