'use client'

import { getAuthSnapshot, isAuthSessionCurrent, registerAuthSessionOperation } from './client'

export type SessionDeliveryOutcome = 'not_sent' | 'unknown'
const sessionGenerationByScope = new WeakMap<SessionScope, number>()

// データを取得・表示・編集した時点の認証セッションを表す不変の値。
// 取得した画面は、この値を結果と一緒に保持し、保存・生成の送信前に現在のセッションと照合する。
// Firebaseのトークンやユーザーオブジェクトは持たない。UIDだけで識別する。
export type SessionScope = Readonly<{ uid: string }>

// 取得したデータに、それを取得したセッションを結び付けて保持するための型。
// 同じIDとversionでも、別UIDのスコープのデータとは別物として扱える。
export type ScopedValue<T> = Readonly<{ scope: SessionScope; value: T }>

// 取得時と現在でUIDが違う。前のセッションのデータを新しいUIDで使ってはいけない。
// 利用側は表示・編集・選択・進行中の読み込みを破棄し、操作を失敗として扱う。
export class SessionChangedError extends Error {
  readonly code = 'session_changed' as const

  constructor(readonly outcome: SessionDeliveryOutcome = 'not_sent') {
    super(
      '認証セッションが変わりました。前のセッションのデータは使えません。読み込み直してください',
    )
    this.name = 'SessionChangedError'
  }
}

// UIDからスコープを作る。作成後は変更できない。
export function createSessionScope(uid: string, generation: number): SessionScope {
  const scope = Object.freeze({ uid })
  sessionGenerationByScope.set(scope, generation)
  return scope
}

// 現在のセッションのスコープを取る。復元失敗・セッション終了では匿名アカウントを作らず、ClientAuthErrorで失敗する。
export async function captureSessionScope(): Promise<SessionScope> {
  const { uid, generation } = await getAuthSnapshot()
  return createSessionScope(uid, generation)
}

export function isSameScope(a: SessionScope, b: SessionScope): boolean {
  if (a.uid !== b.uid) return false
  const aGeneration = sessionGenerationByScope.get(a)
  const bGeneration = sessionGenerationByScope.get(b)
  // 未束縛のUID-only値は、取得時に世代を束縛したscopeとは一致しない。
  return aGeneration === bGeneration
}

// 取得時のスコープが現在のスコープと同じであることを確認する。違えばSessionChangedErrorを投げる。
export function assertSameScope<T>(scoped: ScopedValue<T>, current: SessionScope): void {
  if (!isSameScope(scoped.scope, current)) throw new SessionChangedError()
}

function assertSnapshotMatchesScope(
  scope: SessionScope,
  snapshot: Awaited<ReturnType<typeof getAuthSnapshot>>,
  outcome: SessionDeliveryOutcome,
): void {
  const expectedGeneration = sessionGenerationByScope.get(scope)
  if (
    snapshot.uid !== scope.uid ||
    expectedGeneration === undefined ||
    snapshot.generation !== expectedGeneration
  ) {
    throw new SessionChangedError(outcome)
  }
}

// 同期区間で、現在の認証境界が取得時の世代と同じか確認する。
// fetch呼び出しの直前や、Reactへ状態更新を渡す直前に使う。
export function assertCurrentSessionScopeSync(
  scope: SessionScope,
  outcome: SessionDeliveryOutcome = 'not_sent',
): void {
  const expectedGeneration = sessionGenerationByScope.get(scope)
  if (expectedGeneration === undefined || !isAuthSessionCurrent(scope.uid, expectedGeneration)) {
    throw new SessionChangedError(outcome)
  }
}

export type SessionScopeOperation = Readonly<{
  signal: AbortSignal
  assertCurrent(outcome?: SessionDeliveryOutcome): void
  dispose(): void
}>

// 進行中のI/Oを認証世代に登録する。境界通知時にAbortControllerを同期中断し、
// 外部signalも同じ通信へ伝える。すでに送信された書き込みは取り消せない。
export function beginSessionScopeOperation(
  scope: SessionScope,
  externalSignal?: AbortSignal,
): SessionScopeOperation {
  assertCurrentSessionScopeSync(scope)
  const controller = new AbortController()
  const expectedGeneration = sessionGenerationByScope.get(scope)
  if (expectedGeneration === undefined) throw new SessionChangedError()
  const unregister = registerAuthSessionOperation(scope.uid, expectedGeneration, controller)
  if (!unregister) throw new SessionChangedError()
  const onExternalAbort = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true })

  let disposed = false
  return {
    signal: controller.signal,
    assertCurrent(outcome = 'not_sent') {
      assertCurrentSessionScopeSync(scope, outcome)
    },
    dispose() {
      if (disposed) return
      disposed = true
      unregister()
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

// 応答を画面へ反映する直前にも、取得時点のUser世代を確認する。
// POST後に呼ぶ場合は、世代変更を「結果不明」として扱う（サーバーで保存済みの可能性がある）。
export async function assertCurrentSessionScope(
  scope: SessionScope,
  outcome: SessionDeliveryOutcome = 'not_sent',
): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof getAuthSnapshot>>
  try {
    snapshot = await getAuthSnapshot()
  } catch (error) {
    // GET後の認証復元失敗は元の認証エラーとして示す。POST後は保存済みの可能性があるため結果不明にする。
    if (outcome === 'unknown') throw new SessionChangedError('unknown')
    throw error
  }
  assertSnapshotMatchesScope(scope, snapshot, outcome)
  assertCurrentSessionScopeSync(scope, outcome)
}

// 取得時のスコープと同じセッションのときだけ、認証ヘッダーを返す（失敗時は閉じる）。
// UIDとトークンは同じUserから同時に取るため、UIDの確認とトークンが食い違わない。
// UIDが違えばSessionChangedErrorを投げ、新しいUIDのトークンを呼び出し側へ渡さない。
// セッション終了・取得失敗はClientAuthErrorのまま伝え、匿名アカウントの再作成も再送もしない。
export async function getAuthHeadersForScope(scope: SessionScope): Promise<Headers> {
  const snapshot = await getAuthSnapshot()
  assertSnapshotMatchesScope(scope, snapshot, 'not_sent')
  assertCurrentSessionScopeSync(scope)
  return new Headers({ Authorization: `Bearer ${snapshot.token}` })
}
