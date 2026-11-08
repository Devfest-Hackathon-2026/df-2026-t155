import type { Evidence, Stop } from './models'
import type { RevisionContext } from './revision'

export function revisionReportUncertainty(context: RevisionContext): string | undefined {
  if (context.phase !== 'on_site') return
  const { report } = context
  if (!('category' in report) || report.category === 'other') {
    return '現地報告が候補や前後の予定にどう影響するか確認できていません。'
  }
  if (report.category === 'delayed') {
    const delay = report.kind === 'actual' ? '報告された遅れ' : '模擬報告で想定した遅れ'
    return `${delay}を踏まえた到着時刻を確認できていません。`
  }
  if (report.kind === 'simulated') return '模擬報告のため適用できません。'
}

export function confirmedOriginalPlaceId(
  original: Stop,
  resolvedPlaceId?: string | null,
): string | null {
  if (original.placeId !== null && original.placeId !== resolvedPlaceId) return null
  if (
    original.evidence.some(
      (item) => item.subject === 'place_identity' && isRevisionEvidenceConflict(item, 'original'),
    )
  )
    return null
  return resolvedPlaceId ?? null
}

// 元施設の営業時間はその施設にだけ適用する。同定・移動に関する本人報告や
// 対象の分からない矛盾は、施設を変えるだけで解消したとは判断できない。
export function isRevisionEvidenceConflict(
  { status, subject, source }: Evidence,
  scope: 'original' | 'candidate',
): boolean {
  return (
    status === 'conflicting' &&
    source.kind !== 'simulation' &&
    (scope === 'candidate' ||
      subject === 'other' ||
      (source.kind === 'user_report' &&
        (subject === 'place_identity' || subject === 'travel_time')))
  )
}
