import type { Evidence } from '@/domain'

import { formatCheckedAt } from './format'
import {
  EVIDENCE_WORDING,
  REASON_PREFIX,
  SIMULATION_WORDING,
  SOURCE_KIND_LABELS,
  SOURCE_PHRASES,
  SOURCE_PLACEHOLDER,
  SUBJECT_LABELS,
  UNCHECKED_WORDING,
  type Tone,
} from './wording'

export type EvidenceWording = {
  label: string
  // 何を確認した結果か・限界。
  detail: string
  // 出典と照合日時（「出典：…／照合：…」）。
  provenance: string
  tone: Tone
}

// 出典と照合日時の行。日時は、与えられた文字列の整形だけで作る。
export function describeProvenance(evidence: Pick<Evidence, 'source' | 'checkedAt'>): string {
  return `出典：${SOURCE_KIND_LABELS[evidence.source.kind]}（${evidence.source.label}）／照合：${formatCheckedAt(evidence.checkedAt)}`
}

// 根拠（Evidence）の状態を、利用者向けの言葉にする。
// 判定は、与えられたstatusをそのまま言葉にするだけ（ここで再計算しない）。
// 「情報源と整合」は現実の正しさの保証ではないため、何を・どこで確認したかをdetailに含める。
export function describeEvidence(
  evidence: Pick<Evidence, 'subject' | 'status' | 'source' | 'checkedAt' | 'explanation'>,
): EvidenceWording {
  const isSimulation = evidence.source.kind === 'simulation'
  const wording = isSimulation
    ? SIMULATION_WORDING[evidence.status]
    : EVIDENCE_WORDING[evidence.subject][evidence.status]
  const base = wording.detail.replace(SOURCE_PLACEHOLDER, SOURCE_PHRASES[evidence.source.kind])
  // 確認できない場合は、理由の補足を添える。
  // 営業時間の矛盾は、通常営業時間の範囲外と閉業とで原因が違うため、照合由来（Places・公式）の説明も添える。
  const showReason =
    evidence.status === 'unverifiable' ||
    (evidence.status === 'conflicting' &&
      evidence.subject === 'opening_hours' &&
      (evidence.source.kind === 'places' || evidence.source.kind === 'official') &&
      evidence.explanation.trim() !== '')
  const detail = showReason ? `${base} ${REASON_PREFIX}${evidence.explanation}` : base
  return {
    label: `${SUBJECT_LABELS[evidence.subject]}：${wording.headline}`,
    detail,
    provenance: describeProvenance(evidence),
    tone: wording.tone,
  }
}

// 根拠が空（evidence: []）＝未照合。「確認したが確認できなかった（unverifiable）」とは別の状態。
export function describeUnchecked(): { label: string; detail: string; tone: Tone } {
  return { ...UNCHECKED_WORDING }
}
