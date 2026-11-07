import { LearningSchema, type Learning } from '@/domain'

// 学びの候補を、画面の状態へ取り込む前の検証。通常のAPIの経路でも、差し替えた取得関数の応答でも、
// 同じ条件を適用する（不正な候補群は、一部だけでも採用しない）。
//
// 条件：候補は1〜3件／契約に合う／すべて未承認（pending）／IDが、候補どうし・既存の候補と重複しない
// （同じIDの候補があると、承認の操作が、意図しない候補にも作用する）／対象の旅程から作られた候補／
// 適用する地域が、対象の旅程の地域と一致する。

export const MAX_CANDIDATES = 3

export type IntakeResult = { ok: true; learnings: Learning[] } | { ok: false; reason: string }

export function validateIncomingCandidates(
  incoming: readonly unknown[],
  context: { tripId: string; region: string; existingIds: ReadonlySet<string> },
): IntakeResult {
  if (incoming.length < 1 || incoming.length > MAX_CANDIDATES) {
    return { ok: false, reason: `候補の数が正しくありません（1〜${MAX_CANDIDATES}件）。` }
  }
  const learnings: Learning[] = []
  const seen = new Set<string>()
  for (const item of incoming) {
    const parsed = LearningSchema.safeParse(item)
    if (!parsed.success) return { ok: false, reason: '候補の形式が正しくありません。' }
    const learning = parsed.data
    if (learning.approval.status !== 'pending') {
      return { ok: false, reason: '承認済み・却下済みの候補は、取り込めません。' }
    }
    if (seen.has(learning.id) || context.existingIds.has(learning.id)) {
      return { ok: false, reason: '同じIDの候補が含まれているため、取り込めません。' }
    }
    seen.add(learning.id)
    if (learning.sourceTripId !== context.tripId) {
      return { ok: false, reason: '別の旅程の候補が含まれているため、取り込めません。' }
    }
    if (learning.scope.kind === 'region' && learning.scope.region !== context.region) {
      return { ok: false, reason: '旅程の地域と一致しない候補が含まれているため、取り込めません。' }
    }
    learnings.push(learning)
  }
  return { ok: true, learnings }
}
