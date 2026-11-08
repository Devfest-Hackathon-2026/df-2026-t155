// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import type { GenerationResult } from './api-client'
import { useTripGeneration, type GenerateTrip } from './use-trip-generation'

afterEach(() => cleanup())

const request = {
  region: '京都市東山区',
  date: '2026-11-14',
  timeZone: 'Asia/Tokyo' as const,
  preferences: [],
  fixedStops: [],
}

const success: GenerationResult = { ok: true, trip: sampleTrip }

it('古い生成が遅れて完了しても、新しい生成のcontrollerを消さず、二重送信と旧結果採用を防ぐ', async () => {
  const pending: Array<{
    signal: AbortSignal | undefined
    resolve: (value: GenerationResult) => void
  }> = []
  const generate = vi.fn<GenerateTrip>(
    (_, options) =>
      new Promise<GenerationResult>((resolve) => {
        pending.push({ resolve, signal: options?.signal })
      }),
  )
  const { result } = renderHook(() => useTripGeneration(generate))

  act(() => {
    void result.current.run(request)
  })
  expect(pending).toHaveLength(1)
  expect(result.current.state.phase).toBe('generating')

  act(() => result.current.reset())
  expect(pending[0].signal?.aborted).toBe(true)
  expect(result.current.state.phase).toBe('idle')

  act(() => {
    void result.current.run(request)
  })
  expect(pending).toHaveLength(2)
  expect(pending[1].signal?.aborted).toBe(false)

  // 先に中止したAのfinallyが、進行中のBを見失う退行を検知する。
  await act(async () => pending[0].resolve(success))
  expect(result.current.state.phase).toBe('generating')
  act(() => {
    void result.current.run(request)
  })
  expect(generate).toHaveBeenCalledTimes(2)

  // 別の認証セッションへの切替に相当するresetで、Bも確実に止まる。
  act(() => result.current.reset())
  expect(pending[1].signal?.aborted).toBe(true)
  await act(async () => pending[1].resolve(success))
  expect(result.current.state.phase).toBe('idle')
})

it('A→B→Aのように連続してresetしても、途中の応答は最新の生成を上書きしない', async () => {
  const resolve: Array<(value: GenerationResult) => void> = []
  const generate = vi.fn<GenerateTrip>(
    () =>
      new Promise<GenerationResult>((finish) => {
        resolve.push(finish)
      }),
  )
  const { result } = renderHook(() => useTripGeneration(generate))

  act(() => {
    void result.current.run(request)
  })
  act(() => result.current.reset())
  act(() => {
    void result.current.run(request)
  })
  act(() => result.current.reset())
  act(() => {
    void result.current.run(request)
  })
  expect(resolve).toHaveLength(3)

  await act(async () => {
    resolve[0](success)
    resolve[1](success)
  })
  expect(result.current.state.phase).toBe('generating')
  await act(async () => resolve[2](success))
  expect(result.current.state.phase).toBe('succeeded')
})
