'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'

import type { GenerateTripRequest } from '@/domain'

import type { GenerationOptions, GenerationResult } from './api-client'
import { requestTripGeneration } from './api-client'
import { generationReducer, initialGenerationState } from './generation-state'

export type GenerateTrip = (
  request: GenerateTripRequest,
  options?: GenerationOptions,
) => Promise<GenerationResult>

// 旅程生成の呼び出しと状態管理。生成中の二重送信を防ぎ、画面を離れたら通信を中止する。
export function useTripGeneration(generate: GenerateTrip = requestTripGeneration) {
  const [state, dispatch] = useReducer(generationReducer, initialGenerationState)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  const run = useCallback(
    async (request: GenerateTripRequest) => {
      // stateの更新は非同期のため、二重送信はrefで確実に止める。
      if (controllerRef.current) return
      const controller = new AbortController()
      controllerRef.current = controller
      dispatch({ type: 'start' })

      let result: GenerationResult
      try {
        result = await generate(request, { signal: controller.signal })
      } catch {
        // generateは失敗を戻り値で返す契約だが、例外でも操作不能にしない。
        result = {
          ok: false,
          failure: { kind: 'unexpected', message: '予期しないエラーが発生しました。' },
        }
      } finally {
        controllerRef.current = null
      }

      // 画面を離れて中止された通信の結果は反映しない。
      if (controller.signal.aborted) return
      dispatch(
        result.ok
          ? { type: 'succeed', trip: result.trip }
          : { type: 'fail', failure: result.failure },
      )
    },
    [generate],
  )

  return { state, run }
}
