import { isSameScope, type ScopedValue, type SessionScope } from '@/lib/auth/session-scope'

// 画面が結び付いている認証セッション。UIDと、UIDが別のUIDへ変わるたびに増える世代（scopeEpoch）の組。
// 旅行・履歴・保存済みの一覧・入力中の承認・進行中の保存は、すべてこのセッションの中のものとして扱う。
export type HeldSession = Readonly<{ scope: SessionScope; epoch: number }>

// 取得した結果と、取得したセッションの組。別のセッションの画面では、見えない。
export type Bound<T> = ScopedValue<T> & Readonly<{ epoch: number }>

export function bind<T>(session: HeldSession, value: T): Bound<T> {
  return { scope: session.scope, epoch: session.epoch, value }
}

// いまのセッションで取得した結果だけを返す。UIDまたは世代が違えば、無かったものとして扱う。
// 世代も比べるのは、A→B→Aと戻ったとき、最初のAで取得した結果を復活させないため。
export function valueIn<T>(bound: Bound<T> | null, session: HeldSession | null): T | undefined {
  if (!bound || !session) return undefined
  return bound.epoch === session.epoch && isSameScope(bound.scope, session.scope)
    ? bound.value
    : undefined
}
