import { ApprovedLearningSchema, type ApprovedLearning, type Learning } from '@/domain'
import { approveLearning, editLearning, rejectLearning } from '@/lib/learnings/lifecycle'

// 学びの候補の確認画面の状態。承認・却下・編集の確定は、共通の純粋ロジック（lifecycle）を通して行い、
// 画面側で承認状態を書き換えない。承認済みの学びだけが、次回の旅程へ渡せる。
//
// 入力途中の内容（下書き）は、承認済みの内容とは別に保持する。
// - 承認済みの学びの内容・適用範囲に、編集を始めた時点で、再承認待ち（pending）として扱う
//   （承認済み一覧と通知から、すぐに外れる。古い内容の承認が、残らない）。
// - 入力途中の空欄などは、下書きとして保持し、承認するときに検証する。

export type ScopeKind = 'all_trips' | 'region'

export interface Draft {
  content: string
  scopeKind: ScopeKind
}

export interface ReviewItem {
  // 最後に確定した学び（承認・却下の状態と、確定した内容）。
  learning: Learning
  // 入力途中の内容。
  draft: Draft
}

export interface ReviewState {
  items: ReviewItem[]
  // 学びごとの直近の案内（承認時の入力不備・再承認の案内など）。操作が成功すれば消える。
  // IDは任意の文字列を取り得る（"__proto__" など）ため、オブジェクトではなく Map で持つ。
  messages: ReadonlyMap<string, string>
}

export type ReviewAction =
  | { type: 'reset' }
  // 新しい候補を、既存の候補・承認結果・編集中の内容を残したまま、追加する。
  // IDが重複するものは追加しない（呼び出し側で、取り込み前に検証すること）。
  | { type: 'append'; learnings: Learning[] }
  // 下書きを変更する。承認済みなら、その時点で再承認待ちにする。
  | { type: 'draft'; id: string; content?: string; scopeKind?: ScopeKind; region: string }
  | { type: 'approve'; id: string; decidedAt: string; region: string }
  | { type: 'reject'; id: string; decidedAt: string }
  // 却下を取り消し、未承認に戻す（承認はしない）。
  | { type: 'reopen'; id: string }

export const initialReviewState: ReviewState = { items: [], messages: new Map() }

const draftOf = (learning: Learning): Draft => ({
  content: learning.content,
  scopeKind: learning.scope.kind,
})

const scopeOf = (learning: Learning, scopeKind: ScopeKind, region: string): Learning['scope'] =>
  scopeKind === 'all_trips'
    ? { kind: 'all_trips' }
    : { kind: 'region', region: learning.scope.kind === 'region' ? learning.scope.region : region }

const setMessage = (
  messages: ReadonlyMap<string, string>,
  id: string,
  message?: string,
): ReadonlyMap<string, string> => {
  const next = new Map(messages)
  if (message) next.set(id, message)
  else next.delete(id)
  return next
}

const replaceItem = (state: ReviewState, id: string, item: ReviewItem, message?: string) => ({
  items: state.items.map((current) => (current.learning.id === id ? item : current)),
  messages: setMessage(state.messages, id, message),
})

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  if (action.type === 'reset') return initialReviewState
  if (action.type === 'append') {
    const known = new Set(state.items.map((item) => item.learning.id))
    const added = action.learnings.filter((learning) => !known.has(learning.id))
    return {
      ...state,
      items: [...state.items, ...added.map((learning) => ({ learning, draft: draftOf(learning) }))],
    }
  }

  const target = state.items.find((item) => item.learning.id === action.id)
  if (!target) return state
  const { learning, draft } = target

  switch (action.type) {
    case 'draft': {
      const nextDraft: Draft = {
        content: action.content ?? draft.content,
        scopeKind: action.scopeKind ?? draft.scopeKind,
      }
      // 承認済みの内容を編集し始めたら、その時点で、再承認待ち（pending）にする。
      const wasApproved = learning.approval.status === 'approved'
      return replaceItem(
        state,
        action.id,
        {
          learning: wasApproved ? { ...learning, approval: { status: 'pending' } } : learning,
          draft: nextDraft,
        },
        wasApproved
          ? '内容を変えたので、承認が取り消されました。もう一度、承認してください。'
          : undefined,
      )
    }
    case 'approve': {
      // 画面に見えている下書きを、承認の前に検証する（空欄・長すぎる内容・地域の不備は、承認しない）。
      const edited = editLearning(learning, {
        content: draft.content,
        scope: scopeOf(learning, draft.scopeKind, action.region),
      })
      if (!edited.ok) return replaceItem(state, action.id, target, edited.reason)
      const approved = approveLearning(edited.learning, action.decidedAt)
      return replaceItem(state, action.id, {
        learning: approved,
        draft: draftOf(approved),
      })
    }
    case 'reject':
      return replaceItem(state, action.id, {
        learning: rejectLearning(learning, action.decidedAt),
        draft,
      })
    case 'reopen':
      return replaceItem(state, action.id, {
        learning: { ...learning, approval: { status: 'pending' } },
        draft,
      })
  }
}

// 次回に使える（保存の対象になる）のは、承認済みだけ。
export function approvedOf(state: ReviewState): ApprovedLearning[] {
  const approved: ApprovedLearning[] = []
  for (const { learning } of state.items) {
    // 状態の申告を信用せず、契約で承認済みであることを確かめる。
    const result = ApprovedLearningSchema.safeParse(learning)
    if (result.success) approved.push(result.data)
  }
  return approved
}
