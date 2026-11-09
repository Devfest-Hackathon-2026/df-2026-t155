'use client'

import { useEffect, useState } from 'react'

import {
  LearningReusePicker,
  type LearningReuseSelection,
  type LoadLearningOptions,
} from '@/features/learning-reuse/learning-reuse-picker'
import type { SessionScopeState } from '@/lib/auth/use-session-scope'
import { normalizeLearningRegion } from '@/lib/learnings/lifecycle'

// 入力が落ち着いてから値を返す。1文字ごとに保存済みの学びを読みに行かないため。
function useSettled(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

// 旅行先の入力欄の下に置く、前の旅の学びの選択。
// 旅行先が入るまでは案内だけを出し、読み込みも失敗表示もしない。
// 旅行先は入力が落ち着いてから反映する。選んだ学びは地域ごとに有効なため、旅行先が変わると選択は解除される。
export function HomeLearningPicker({
  region,
  session,
  load,
  delayMs,
  onSelectionChange,
}: {
  region: string
  session: SessionScopeState
  load?: LoadLearningOptions
  delayMs: number
  onSelectionChange: (selection: LearningReuseSelection | null) => void
}) {
  const normalizedRegion = normalizeLearningRegion(region)
  const settledRegion = useSettled(normalizedRegion, delayMs)

  if (normalizedRegion === '') {
    return (
      <p className="text-sm text-gt-muted">
        旅行先を入れると、前の旅で保存した学びを選べます（使わなくても旅程は作れます）。
      </p>
    )
  }
  // 次の読み込みを待つ間も、前の地域の選択はPickerのアンマウントで解除する。
  if (settledRegion !== normalizedRegion) {
    return (
      <p role="status" className="text-sm text-gt-muted">
        旅行先が変わりました。学びを使う場合は、新しい一覧が表示されてから選んでください。
      </p>
    )
  }
  return (
    <LearningReusePicker
      region={settledRegion}
      session={session}
      load={load}
      onSelectionChange={onSelectionChange}
    />
  )
}
