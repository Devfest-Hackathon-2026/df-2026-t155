'use client'

import { useEffect, useState, type ReactNode } from 'react'

import type { Trip } from '@/domain'
import { RevisionRouteView } from '@/features/revision-review/revision-route-view'

import { isFixedOnlyChange, mergeVerification } from './merge-verification'
import { useTripVerification, type VerifyTrip } from './use-trip-verification'
import { VerificationPanel, type PanelStatus } from './verification-panel'
import { summarizeVerification } from './verification-summary'
import { withdrawStaleVerification } from './withdraw-verification'

// 直近の照合の記録。withdrawn は、旅程の内容が変わって、照合結果の一部（または全部）を取り下げたこと。
// 取り下げずに戻す「照合前の状態」は持たない（再照合の結果を、古い結果で上書きしないため）。
interface VerifiedRecord {
  withdrawn: boolean
}

// 画面に出している旅程の状態。
// - source：親から渡された旅程（新しい生成に切り替わったかの判定に使う）。
// - prop：路線図へ渡す旅程。照合に成功したときだけ、照合結果を取り込んだ旅程に差し替える。
// - current：いま画面に出ている旅程（固定の切り替えや部分修正で変わる）。
// - verified：直近の照合の記録。取り下げていなければ「照合結果あり」とする。
// - interrupted：確認の最中に旅程の内容が変わって、確認を中止した（理由の通知を出す）。
interface View {
  source: Trip
  prop: Trip
  current: Trip
  verified: VerifiedRecord | null
  interrupted: boolean
}

const fresh = (source: Trip): View => ({
  source,
  prop: source,
  current: source,
  verified: null,
  interrupted: false,
})

// 生成された旅程の路線図と、根拠の確認（照合）の操作。
// 照合は利用者が「根拠を確認する」を押したときだけ、照合APIを1回呼んで行う。失敗しても旅程は変わらず、再試行できる。
// 固定の切り替えは、根拠（存在・営業・移動）に影響しないので、照合結果を取り下げず、確認中の通信も止めない。
// 旅程の内容が変わったとき（部分修正の適用など）は、変更の影響を受けた根拠だけを取り下げて未確認に戻し
// （影響を受けない予定の根拠と、本人の報告などは残す。withdraw-verification.ts）、
// 確認中だった場合は通信を中止して、その理由を通知する。
// 旅程の下に続く導線（保存・現地報告・振り返り）へ渡すもの。
export interface VerifiableTripAfterContext {
  // いま画面に出している旅程（固定の切り替えや部分修正を反映済み）。
  trip: Trip
  // 路線図の外（現地報告など）で旅程が変わったときに、画面へ採用する旅程を決める。
  // 路線図の中の変更と同じく、変更後の旅程に対して前回の照合結果の一部を取り下げ（変更後は未確認）、
  // 確認中の通信を止める。路線図にも採用した旅程を反映する。
  adoptExternalChange: (changed: Trip) => Trip
}

export function VerifiableTrip({
  trip: source,
  verify,
  renderAfter,
}: {
  trip: Trip
  verify?: VerifyTrip
  renderAfter?: (context: VerifiableTripAfterContext) => ReactNode
}) {
  const [stored, setStored] = useState<View>(() => fresh(source))
  const view = stored.source === source ? stored : fresh(source)
  const { state, run, cancel } = useTripVerification(verify)

  const update = (change: (current: View) => View) =>
    setStored((previous) => change(previous.source === source ? previous : fresh(source)))

  // 別の旅程に切り替わったら、進行中の確認を取り消す（古い旅程の結果を反映しない）。
  useEffect(() => {
    cancel()
  }, [source, cancel])

  const verifyNow = async () => {
    const sent = view.current
    // 押したら、前回の中止の通知は消す。
    update((previous) => ({ ...previous, interrupted: false }))
    const result = await run(sent)
    if (!result) return
    // 確認中に切り替えた固定は残し、結果の根拠だけを、その時点の最新の旅程へ取り込む。
    // 内容が変わっていれば取り込まず、中止の通知を出す（通常は adoptChange が先に通信を中止している）。
    update((previous) => {
      const merged = mergeVerification(sent, previous.current, result)
      if (!merged) return { ...previous, interrupted: true }
      return {
        source,
        prop: merged,
        current: merged,
        verified: { withdrawn: false },
        interrupted: false,
      }
    })
  }

  // 固定の切り替え・部分修正の適用で旅程が変わったとき、画面に採用する旅程を返す。
  const adoptChange = (changed: Trip): Trip => {
    // 固定だけの変更は、根拠に影響しない。照合結果の取り下げも、確認中の通信の中止もしない。
    if (isFixedOnlyChange(view.current, changed)) {
      update((previous) => ({ ...previous, current: changed }))
      return changed
    }
    // 内容が変わった：変更の影響を受けた根拠を取り下げ、確認中なら通信を中止して、理由を通知する。
    // 取り下げの判断は、直前の旅程（画面に出していたもの）と、変更後の旅程の比較だけで行う。
    const { trip: adopted, withdrawn } = withdrawStaleVerification(view.current, changed)
    const aborted = cancel()
    update((previous) => ({
      ...previous,
      current: adopted,
      verified: previous.verified && { withdrawn: previous.verified.withdrawn || withdrawn },
      interrupted: aborted || previous.interrupted,
    }))
    return adopted
  }

  // 路線図の外で旅程が変わったとき。取り下げは adoptChange と同じで、路線図が表示する旅程も差し替える。
  const adoptExternalChange = (changed: Trip): Trip => {
    const adopted = adoptChange(changed)
    update((previous) => ({ ...previous, prop: adopted }))
    return adopted
  }

  const summary = summarizeVerification(view.current)
  const status: PanelStatus = !view.verified
    ? { kind: 'unverified', googleTotal: summary.google.total }
    : !view.verified.withdrawn
      ? { kind: 'verified', summary }
      : summary.google.total > 0
        ? { kind: 'partial', summary }
        : { kind: 'withdrawn' }

  return (
    <div className="space-y-4">
      <VerificationPanel
        status={status}
        phase={state}
        interrupted={view.interrupted}
        onVerify={() => void verifyNow()}
      />
      <RevisionRouteView trip={view.prop} adoptTripChange={adoptChange} />
      {renderAfter?.({ trip: view.current, adoptExternalChange })}
    </div>
  )
}
