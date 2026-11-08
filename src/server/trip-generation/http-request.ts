import { z } from 'zod'

import { GenerateTripRequestSchema } from '../../domain'
import { LearningSelectionSchema, type LearningSelection } from '../persistence/contracts'
import { LEARNING_LIMIT } from '../persistence/limits'

// POST /api/trips/generate が受け付ける本文（HTTPの契約）。
//
// 旅行条件は内部の GenerateTripRequest と同じ。違いは学びの渡し方だけで、
// 承認済みの学びの本文（learnings）は受け付けない。クライアントが申告した本文は信用できないため、
// 利用者が画面で選んだ { id, version } だけを受け取り、サーバーが本人の保存済みデータと照合して解決する
// （src/server/learning-reuse/selection.ts の resolveSelectedLearnings）。
// strictObject なので、旧形式の learnings が付いた本文は 400（invalid_request）で拒否される。
const { date, region, timeZone, preferences, fixedStops } = GenerateTripRequestSchema.shape

export const GenerateTripHttpRequestSchema = z
  .strictObject({
    date,
    region,
    timeZone,
    preferences,
    fixedStops,
    learningSelections: z.array(LearningSelectionSchema).max(LEARNING_LIMIT),
  })
  .superRefine((request, ctx) => {
    if (new Set(request.fixedStops.map((stop) => stop.id)).size !== request.fixedStops.length) {
      ctx.addIssue({ code: 'custom', path: ['fixedStops'], message: '固定Stop IDが重複しています' })
    }
    if (
      new Set(request.learningSelections.map((selection) => selection.id)).size !==
      request.learningSelections.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['learningSelections'],
        message: '選択した学びのIDが重複しています',
      })
    }
  })

export type GenerateTripHttpRequest = z.infer<typeof GenerateTripHttpRequestSchema>
// 画面が組み立てる旅行条件。学びの選択は送信直前に（認証セッションと照合して）加える。
export type GenerateTripConditions = Omit<GenerateTripHttpRequest, 'learningSelections'>
export type { LearningSelection }
