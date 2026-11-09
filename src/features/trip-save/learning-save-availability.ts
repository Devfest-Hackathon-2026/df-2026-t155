'use client'

import { useEffect, useState } from 'react'

import type { Trip } from '@/domain'
import { learningSaveExpiresAt } from '@/domain/learning-trip-protocol'
import { requiresLearningSaveProof } from '@/server/persistence/contracts'

export type LearningSaveUnavailable = 'disabled' | 'signing_unavailable'
export const REGENERATE_NOTICE =
  '旅程を作り直すと提案が変わることがあり、生成のAPI利用枠を使います。現在の旅程は再生成に成功するまで確認できます。'

const WARNING_MS = 5 * 60 * 1000

export function useSaveClock(learningProof?: string, placeProof?: string) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const update = () => setNow(Date.now())
    const deadlines = [learningProof, placeProof].flatMap((proof) => {
      if (!proof) return []
      const expiresAt = learningSaveExpiresAt(proof)
      return [expiresAt - WARNING_MS, expiresAt]
    })
    const timers = deadlines
      .filter((deadline) => deadline > Date.now())
      .map((deadline) => window.setTimeout(update, Math.min(deadline - Date.now(), 2_147_483_647)))
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [learningProof, placeProof])
  return now
}

export function learningSaveAvailability(
  trip: Trip,
  now: number,
  learningProof?: string,
  placeProof?: string,
  unavailable?: LearningSaveUnavailable,
): { blocked?: string; warning?: string; regenerate?: boolean } {
  if (!requiresLearningSaveProof(trip)) return {}
  if (!learningProof) {
    if (unavailable === 'disabled') {
      return {
        blocked: '学び付きの旅程保存は現在停止中です。再開後に旅程を作り直してください。',
        regenerate: true,
      }
    }
    return {
      blocked:
        unavailable === 'signing_unavailable'
          ? '保存用の証跡を発行できませんでした。時間をおいて旅程を作り直してください。'
          : '保存用の証跡がありません。ページを再読み込みして更新した後、旅程を作り直してください。',
      regenerate: true,
    }
  }
  const remaining = learningSaveExpiresAt(learningProof) - now
  if (remaining <= 0) {
    return {
      blocked: '学びの保存用証跡の期限が切れました。旅行条件に戻って旅程を作り直してください。',
      regenerate: true,
    }
  }
  if (
    trip.stops.some(({ placeId }) => placeId) &&
    (!placeProof || learningSaveExpiresAt(placeProof) <= now)
  ) {
    return {
      blocked:
        '場所の識別子を保存するには、上の「根拠を確認する」から照合し直してください。照合にはAPI利用枠を使います。',
    }
  }
  if (remaining <= WARNING_MS) {
    return {
      warning:
        '学びの保存用証跡はまもなく期限切れになります。期限が切れたら旅程を作り直してください。',
      regenerate: true,
    }
  }
  return {}
}
