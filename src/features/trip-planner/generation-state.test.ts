import { describe, expect, it } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import type { GenerationFailure } from './api-client'
import {
  generationReducer,
  initialGenerationState,
  type GenerationAction,
  type GenerationState,
} from './generation-state'

const failure: GenerationFailure = { kind: 'external_service_error', message: '失敗' }

const run = (actions: GenerationAction[], from: GenerationState = initialGenerationState) =>
  actions.reduce(generationReducer, from)

describe('generationReducer', () => {
  it('開始すると生成中になり、成功すると旅程（提案）を保持する', () => {
    expect(run([{ type: 'start' }])).toEqual({ phase: 'generating' })
    expect(run([{ type: 'start' }, { type: 'succeed', trip: sampleTrip }])).toEqual({
      phase: 'succeeded',
      trip: sampleTrip,
    })
  })

  it('失敗すると失敗の内容を保持する', () => {
    expect(run([{ type: 'start' }, { type: 'fail', failure }])).toEqual({
      phase: 'failed',
      failure,
    })
  })

  it('生成中の再開始は無視する（同じ状態のまま）', () => {
    const generating = run([{ type: 'start' }])

    expect(generationReducer(generating, { type: 'start' })).toBe(generating)
  })

  it('成功後に再生成を始めると、前の条件の旅程は消える', () => {
    const state = run([{ type: 'start' }, { type: 'succeed', trip: sampleTrip }, { type: 'start' }])

    expect(state).toEqual({ phase: 'generating' })
  })

  it('失敗後にやり直すと、失敗表示は消えて生成中になる', () => {
    const state = run([{ type: 'start' }, { type: 'fail', failure }, { type: 'start' }])

    expect(state).toEqual({ phase: 'generating' })
  })

  it('生成中でないときに届いた結果は反映しない', () => {
    expect(run([{ type: 'succeed', trip: sampleTrip }])).toEqual({ phase: 'idle' })
    expect(run([{ type: 'fail', failure }])).toEqual({ phase: 'idle' })

    const failed = run([{ type: 'start' }, { type: 'fail', failure }])
    expect(generationReducer(failed, { type: 'succeed', trip: sampleTrip })).toBe(failed)
  })
})
