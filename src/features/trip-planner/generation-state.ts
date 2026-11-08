import type { Trip } from '@/domain'

import type { GenerationFailure } from './api-client'

// 旅程生成の操作状態。完了応答（proposed／失敗）とは別に、クライアントだけが持つ
// 「生成中」を含む。生成された旅程は提案であり、承認・確定・保存はしない。
export type GenerationState =
  | { phase: 'idle' }
  | { phase: 'generating' }
  | { phase: 'failed'; failure: GenerationFailure }
  | { phase: 'succeeded'; trip: Trip }

export type GenerationAction =
  | { type: 'start' }
  | { type: 'succeed'; trip: Trip }
  | { type: 'fail'; failure: GenerationFailure }
  // 認証セッションが変わったとき、前のセッションで得た結果・失敗を捨てて最初の状態に戻す。
  | { type: 'reset' }

export const initialGenerationState: GenerationState = { phase: 'idle' }

export function generationReducer(
  state: GenerationState,
  action: GenerationAction,
): GenerationState {
  switch (action.type) {
    case 'start':
      // 生成中の再送信は無視する（二重にAPIを呼ばない）。
      // 新しく生成を始めるときは、前の条件の結果を表示し続けない。
      return state.phase === 'generating' ? state : { phase: 'generating' }
    case 'reset':
      return initialGenerationState
    case 'succeed':
      return state.phase === 'generating' ? { phase: 'succeeded', trip: action.trip } : state
    case 'fail':
      return state.phase === 'generating' ? { phase: 'failed', failure: action.failure } : state
  }
}
