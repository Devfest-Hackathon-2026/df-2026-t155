import { z } from 'zod'

import { assertSameScope, type ScopedValue, type SessionScope } from '@/lib/auth/session-scope'
import { LearningSelectionSchema, type LearningSelection } from '@/server/persistence/contracts'

// 利用者が選んだ学び。{ id, version } を、選んだ時点の認証セッションと組にして保持する。
// 「どの認証セッションの利用者が、画面で見たどの版を選んだか」の対応を型で残す。
// 同じIDとversionでも、UIDまたは認証世代が違えば別の選択として扱う。
// サーバーはトークンのUIDで学びを引くため、別UIDのトークンで送ると、同じID・版の本文へ置き換わり得る。
export type ScopedLearningSelection = ScopedValue<LearningSelection[]>

// 選択の形式が不正（版のない旧形式のID、版が0・小数、重複ID、余分な項目）。
// 画面が作る値では起きない。起きたときは送信せず、利用者の選択を直す。
export class InvalidLearningSelectionError extends Error {
  readonly code = 'invalid_selection' as const

  constructor() {
    super('学びの選択内容が正しくありません。選び直してください')
    this.name = 'InvalidLearningSelectionError'
  }
}

// 件数の上限はサーバー側（LEARNING_LIMIT）で確かめる。ここでは形と重複だけを見る。
const SelectionsSchema = z
  .array(LearningSelectionSchema)
  .refine((items) => new Set(items.map(({ id }) => id)).size === items.length)

// 生成リクエストを送る直前に、選択を取り出す唯一の口。生成APIの呼び出し側は、これを通した値だけを送る。
// - 選択時と現在の認証セッションが同じ（UIDと認証世代が一致）ときだけ、{ id, version }[] を返す。
//   違えば SessionChangedError を投げる。選択を捨てて空で続けない（黙って学びを外さない）。
// - null / undefined は「学びを使わない」。選択UIが選択を取り消した（地域変更・認証変更・再読み込み）状態。
// 戻り値は複製で、保持している選択を後から書き換えても影響しない。
//
// 使い方（統合側）:
//   const scope = await captureSessionScope()
//   const selections = resolveSelectionForRequest(selected, scope)   // 違えばSessionChangedError
//   const headers = await getAuthHeadersForScope(scope)              // 送信側のトークンも同じUID
export function resolveSelectionForRequest(
  selection: ScopedLearningSelection | null | undefined,
  currentScope: SessionScope,
): LearningSelection[] {
  if (!selection) return []
  assertSameScope(selection, currentScope)
  const parsed = SelectionsSchema.safeParse(selection.value)
  if (!parsed.success) throw new InvalidLearningSelectionError()
  return parsed.data
}
