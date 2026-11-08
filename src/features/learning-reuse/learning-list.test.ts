import { describe, expect, it } from 'vitest'

import { sampleApprovedLearning } from '@/domain/samples'
import { MAX_LEARNING_CONTENT_LENGTH } from '@/lib/learnings/lifecycle'

import { isSelectableLearningList, ReusableLearningListResponseSchema } from './learning-list'

const record = (content: string, id = sampleApprovedLearning.id, version = 1) => ({
  version,
  learning: { ...sampleApprovedLearning, id, content },
})
const body = (learnings: ReturnType<typeof record>[]) => ({
  learnings,
  listInfo: { returned: learnings.length, skippedInvalid: 0, truncated: false },
})

describe('取得スキーマの本文の長さ', () => {
  it('上限ちょうどは通し、上限を1文字でも超える本文は取得の段階で拒否する', () => {
    const exact = body([record('あ'.repeat(MAX_LEARNING_CONTENT_LENGTH))])
    const over = body([record('あ'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1))])
    expect(ReusableLearningListResponseSchema.safeParse(exact).success).toBe(true)
    const result = ReusableLearningListResponseSchema.safeParse(over)
    expect(result.success).toBe(false)
    // どの項目が理由かを、本文の長さとして示す。
    expect(result.error?.issues[0].path).toEqual(['learnings', 0, 'learning', 'content'])
  })

  it('一部の項目だけが上限を超えていても、一覧全体を拒否する', () => {
    const mixed = body([
      record('短い本文', 'learning-short'),
      record('い'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1), 'learning-long'),
    ])
    expect(ReusableLearningListResponseSchema.safeParse(mixed).success).toBe(false)
  })

  it('既存の形式の検証（版・余分なキー）は緩めない', () => {
    expect(
      ReusableLearningListResponseSchema.safeParse(body([record('本文', 'x', 0)])).success,
    ).toBe(false)
    expect(
      ReusableLearningListResponseSchema.safeParse({ ...body([record('本文')]), extra: 1 }).success,
    ).toBe(false)
  })
})

describe('表示してよい一覧か', () => {
  it('上限以内でIDが重複しない一覧だけを許可する', () => {
    expect(isSelectableLearningList([])).toBe(true)
    expect(isSelectableLearningList([record('本文', 'a'), record('本文', 'b')])).toBe(true)
    expect(isSelectableLearningList([record('あ'.repeat(MAX_LEARNING_CONTENT_LENGTH), 'a')])).toBe(
      true,
    )
  })

  it('上限を超える本文を含む一覧を許可しない', () => {
    expect(
      isSelectableLearningList([
        record('本文', 'a'),
        record('あ'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1), 'b'),
      ]),
    ).toBe(false)
  })

  it('IDが重複する一覧は、版が違っても許可しない', () => {
    expect(isSelectableLearningList([record('本文', 'a', 1), record('本文', 'a', 2)])).toBe(false)
  })
})
