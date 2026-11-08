import { z } from 'zod'

import { isLearningContentReusable } from '@/lib/learnings/lifecycle'
import {
  LearningListResponseSchema,
  VersionedLearningSchema,
  type VersionedLearning,
} from '@/server/persistence/contracts'

// 取得（クライアントのZod）でも、本文の上限を確かめる。
// サーバーの読み取りは既存文書との互換のため上限を持たないので、そのまま通すと、
// 画面に出せても生成には使えない（サーバーが採用を拒否する）学びを、選べる形で見せてしまう。
// 判定はサーバー採用（resolveSelectedLearnings）と同じ isLearningContentReusable。
export const ReusableLearningListResponseSchema = LearningListResponseSchema.safeExtend({
  learnings: z.array(
    VersionedLearningSchema.refine(({ learning }) => isLearningContentReusable(learning), {
      path: ['learning', 'content'],
      message: '次の旅に使える長さを超えています',
    }),
  ),
})

// 画面に出して選ばせてよい一覧か。取得経路（api-client）とは別に、表示の入口でも確かめる
// （読み込み関数は差し替えられるため、取得時の検証を前提にしない）。
// - 本文が上限を超える学びを含む一覧は、その学びが選べない理由を説明できないので、一覧ごと使わない。
// - IDが重複する一覧は、どの版を選んだのか曖昧になる。
export function isSelectableLearningList(items: readonly VersionedLearning[]): boolean {
  return (
    items.every(({ learning }) => isLearningContentReusable(learning)) &&
    new Set(items.map(({ learning }) => learning.id)).size === items.length
  )
}
