import { describe, expect, it } from 'vitest'

import { sampleLearning } from '@/domain/samples'

import { approvedOf, initialReviewState, reviewReducer, type ReviewState } from './review-model'

const AT = '2026-11-08T10:00:00+09:00'
const REGION = sampleLearning.scope.kind === 'region' ? sampleLearning.scope.region : '京都'
const id = sampleLearning.id

const loaded = (): ReviewState =>
  reviewReducer(initialReviewState, { type: 'append', learnings: [sampleLearning] })
const approve = (state: ReviewState) =>
  reviewReducer(state, { type: 'approve', id, decidedAt: AT, region: REGION })
const edit = (state: ReviewState, content: string) =>
  reviewReducer(state, { type: 'draft', id, content, region: REGION })
const learningOf = (state: ReviewState) => state.items[0].learning

describe('reviewReducer: 基本の操作', () => {
  it('追加した候補は、すべて未承認で、承認済みには含まれない', () => {
    const state = loaded()
    expect(learningOf(state).approval).toEqual({ status: 'pending' })
    expect(approvedOf(state)).toEqual([])
  })

  it('承認すると承認済みになり、承認日時が付く', () => {
    const state = approve(loaded())
    expect(approvedOf(state)).toHaveLength(1)
    expect(approvedOf(state)[0].approval).toEqual({ status: 'approved', decidedAt: AT })
  })

  it('却下した学びは承認済みに含まれない。取り消すと未承認に戻る（承認にはならない）', () => {
    const rejected = reviewReducer(loaded(), { type: 'reject', id, decidedAt: AT })
    expect(learningOf(rejected).approval.status).toBe('rejected')
    expect(approvedOf(rejected)).toEqual([])

    const reopened = reviewReducer(rejected, { type: 'reopen', id })
    expect(learningOf(reopened).approval).toEqual({ status: 'pending' })
    expect(approvedOf(reopened)).toEqual([])
  })

  it('存在しないIDへの操作は何も変えない', () => {
    const state = loaded()
    expect(
      reviewReducer(state, { type: 'approve', id: 'none', decidedAt: AT, region: REGION }),
    ).toBe(state)
  })

  it('不正な承認日時（タイムゾーンなし）では承認できない', () => {
    expect(() =>
      reviewReducer(loaded(), { type: 'approve', id, decidedAt: '2026-11-08', region: REGION }),
    ).toThrow()
  })
})

describe('reviewReducer: 編集を始めた時点で、承認が取り消される', () => {
  it('承認済みの内容を1文字でも変えた時点で、再承認待ち（pending）になり、承認済みから外れる', () => {
    const edited = edit(approve(loaded()), `${sampleLearning.content}。`)

    expect(learningOf(edited).approval).toEqual({ status: 'pending' })
    expect(approvedOf(edited)).toEqual([])
    expect(edited.messages.get(id)).toContain('承認が取り消されました')
  })

  it('適用範囲だけを変えた場合も、その時点で再承認待ちになる', () => {
    const edited = reviewReducer(approve(loaded()), {
      type: 'draft',
      id,
      scopeKind: 'all_trips',
      region: REGION,
    })

    expect(learningOf(edited).approval).toEqual({ status: 'pending' })
    expect(approvedOf(edited)).toEqual([])
  })

  it('入力途中の空欄は、下書きとして保持する（確定した内容は、承認時まで変えない）', () => {
    const edited = edit(loaded(), '')

    expect(edited.items[0].draft.content).toBe('')
    expect(learningOf(edited).content).toBe(sampleLearning.content)
  })

  it('空欄のまま承認しようとすると、承認されず、理由を案内する（下書きは保持）', () => {
    const state = approve(edit(loaded(), '   '))

    expect(approvedOf(state)).toEqual([])
    expect(learningOf(state).approval).toEqual({ status: 'pending' })
    expect(state.messages.get(id)).toContain('入力')
    expect(state.items[0].draft.content).toBe('   ')
  })

  it('長すぎる内容は、承認時に拒否する', () => {
    const state = approve(edit(loaded(), 'あ'.repeat(121)))

    expect(approvedOf(state)).toEqual([])
    expect(state.messages.get(id)).toContain('文字以内')
  })

  it('下書きを直して承認すると、直した内容（前後の空白を除く）が承認される', () => {
    const state = approve(edit(loaded(), '  昼食の候補は2つ用意したい  '))

    expect(approvedOf(state)[0].content).toBe('昼食の候補は2つ用意したい')
    expect(state.items[0].draft.content).toBe('昼食の候補は2つ用意したい')
    expect(state.messages.get(id)).toBeUndefined()
  })

  it('適用範囲を「すべての旅行」に変えて承認できる。地域に戻すと、地域つきで承認される', () => {
    const toAll = approve(
      reviewReducer(loaded(), { type: 'draft', id, scopeKind: 'all_trips', region: REGION }),
    )
    expect(approvedOf(toAll)[0].scope).toEqual({ kind: 'all_trips' })

    const back = reviewReducer(
      reviewReducer(toAll, { type: 'draft', id, scopeKind: 'region', region: '別の地域' }),
      { type: 'approve', id, decidedAt: AT, region: '別の地域' },
    )
    expect(approvedOf(back)[0].scope).toEqual({ kind: 'region', region: '別の地域' })
  })

  it('未承認の候補を編集しても、案内は出ない', () => {
    expect(edit(loaded(), '別の内容').messages.get(id)).toBeUndefined()
  })
})

describe('reviewReducer: 追加（再生成）と、既存の状態の保持', () => {
  const second = { ...sampleLearning, id: 'learning-second', content: '2件目の学び' }

  it('追加しても、既存の候補・承認結果・編集中の内容を、消さない', () => {
    const approvedState = approve(loaded())
    const editing = reviewReducer(approvedState, {
      type: 'append',
      learnings: [second],
    })
    const withDraft = reviewReducer(editing, {
      type: 'draft',
      id: second.id,
      content: '編集中の内容',
      region: REGION,
    })
    const third = { ...sampleLearning, id: 'learning-third' }
    const result = reviewReducer(withDraft, { type: 'append', learnings: [third] })

    expect(result.items.map((item) => item.learning.id)).toEqual([id, second.id, third.id])
    expect(approvedOf(result).map((l) => l.id)).toEqual([id])
    expect(result.items[1].draft.content).toBe('編集中の内容')
  })

  it('IDが重複する候補は、追加しない（既存の候補を、上書きしない）', () => {
    const approvedState = approve(loaded())
    const result = reviewReducer(approvedState, {
      type: 'append',
      learnings: [{ ...sampleLearning, content: '別の内容' }],
    })

    expect(result.items).toHaveLength(1)
    expect(approvedOf(result)[0].content).toBe(sampleLearning.content)
  })

  it('resetで、すべての候補・案内を消す', () => {
    const state = reviewReducer(edit(approve(loaded()), 'x'), { type: 'reset' })

    expect(state).toEqual(initialReviewState)
  })
})

describe('reviewReducer: 任意のID', () => {
  it('"__proto__" などのIDでも、案内を保持・消去でき、他の候補に影響しない', () => {
    const odd = { ...sampleLearning, id: '__proto__' }
    const other = { ...sampleLearning, id: 'learning-other' }
    const state = reviewReducer(initialReviewState, { type: 'append', learnings: [odd, other] })

    const blank = reviewReducer(state, {
      type: 'draft',
      id: '__proto__',
      content: '',
      region: REGION,
    })
    const rejected = reviewReducer(blank, {
      type: 'approve',
      id: '__proto__',
      decidedAt: AT,
      region: REGION,
    })
    expect(rejected.messages.get('__proto__')).toContain('入力')
    expect(rejected.messages.get('learning-other')).toBeUndefined()
    expect(Object.getPrototypeOf(rejected.messages)).toBe(Map.prototype)

    const fixed = reviewReducer(rejected, {
      type: 'draft',
      id: '__proto__',
      content: '十分な内容です',
      region: REGION,
    })
    const approved = reviewReducer(fixed, {
      type: 'approve',
      id: '__proto__',
      decidedAt: AT,
      region: REGION,
    })
    expect(approved.messages.get('__proto__')).toBeUndefined()
    expect(approvedOf(approved).map((item) => item.id)).toEqual(['__proto__'])
  })
})
