'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { Trip } from '@/domain'

import type { VerificationFailure, VerificationOptions, VerificationResult } from './api-client'
import { verifyTripWithProtectedApi } from './protected-verify'

export type VerifyTrip = (trip: Trip, options?: VerificationOptions) => Promise<VerificationResult>

// 確認の通信の状態。成功した結果は呼び出し側が受け取って持つ（ここでは持たない）。
export type VerificationPhase =
  { phase: 'idle' } | { phase: 'verifying' } | { phase: 'failed'; failure: VerificationFailure }

const idle: VerificationPhase = { phase: 'idle' }

// 旅程の照合APIの呼び出し。課金を伴うため、1回の操作で照合APIを1回だけ呼び、実行中の再送信は受け付けない。
// （サーバーは、予定の数に応じて外部APIを複数回呼ぶ。この二重送信の防止は、サーバー側の利用制限の代わりにならない。）
// 画面を離れたとき、または旅程の内容が変わったときは通信を中止し、その結果は反映しない。
export function useTripVerification(verify: VerifyTrip = verifyTripWithProtectedApi) {
  const [state, setState] = useState<VerificationPhase>(idle)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  // 成功したら照合結果の旅程を返す。失敗・中止・実行中の再送信は null（失敗の内容は state に出る）。
  const run = useCallback(
    async (
      trip: Trip,
      onPlaceSaveProof?: (proof: string | undefined) => void,
    ): Promise<Trip | null> => {
      // stateの更新は非同期のため、二重送信はrefで確実に止める。
      if (controllerRef.current) return null
      const controller = new AbortController()
      controllerRef.current = controller
      setState({ phase: 'verifying' })

      let result: VerificationResult
      try {
        result = await verify(trip, { signal: controller.signal })
      } catch {
        // verifyは失敗を戻り値で返す契約だが、例外でも操作不能にしない。
        result = {
          ok: false,
          failure: { kind: 'unexpected', message: '予期しないエラーが発生しました。' },
        }
      } finally {
        // 中止して別の確認が始まっている場合は、新しい方の印を消さない。
        if (controllerRef.current === controller) controllerRef.current = null
      }

      if (controller.signal.aborted) return null
      if (result.ok) {
        setState(idle)
        onPlaceSaveProof?.(result.placeSaveProof)
        return result.trip
      }
      setState({ phase: 'failed', failure: result.failure })
      return null
    },
    [verify],
  )

  // 進行中の確認を中止し、失敗の表示も消す（旅程の内容が変わったとき・別の旅程に切り替わったとき）。
  // 進行中の確認を中止したときだけ true を返す（呼び出し側が、中止した理由を利用者に伝えるため）。
  const cancel = useCallback((): boolean => {
    const wasRunning = controllerRef.current !== null
    controllerRef.current?.abort()
    controllerRef.current = null
    setState((current) => (current.phase === 'idle' ? current : idle))
    return wasRunning
  }, [])

  return { state, run, cancel }
}
