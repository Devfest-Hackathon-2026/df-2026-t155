import type { Revision } from '../../domain'

// 学びの材料にできる変更履歴の判定。画面とサーバーで、同じ判定を使う（純粋ロジック）。
// 画面の「材料があるか」の判定と、サーバーの候補作成・プロンプト生成が、食い違わないようにする。

// 本人が承認した変更だけ（未承認・却下は、実際には起きていない）。
export function approvedRevisions(revisions: readonly Revision[]): Revision[] {
  return revisions.filter((revision) => revision.approval.status === 'approved')
}

// 模擬報告（デモ用の想定）は、実際に起きた出来事ではない。学びの事実にしない。
export function isSimulated(revision: Revision): boolean {
  return revision.context.phase === 'on_site' && revision.context.report.kind === 'simulated'
}

// 学びの材料にできる変更履歴：本人が承認した、実際の報告に基づくものだけ。
// AIへの指示だけに頼らず、アプリケーション側で確実に除外する（材料判定とプロンプト生成で共通に使う）。
export function usableRevisions(revisions: readonly Revision[]): Revision[] {
  return approvedRevisions(revisions).filter((revision) => !isSimulated(revision))
}

// 変更履歴1件の、学びの材料としての扱い。履歴の表示で、区別して案内する。
export type RevisionMaterialStatus = 'usable' | 'simulated' | 'not_approved'

export function revisionMaterialStatus(revision: Revision): RevisionMaterialStatus {
  if (revision.approval.status !== 'approved') return 'not_approved'
  return isSimulated(revision) ? 'simulated' : 'usable'
}

// 材料があるか（感想か、学びの材料にできる変更のどちらか）。無ければ、候補を作れない。
export function hasMaterial(input: { revisions: readonly Revision[]; feedback: string }): boolean {
  return input.feedback.length > 0 || usableRevisions(input.revisions).length > 0
}
