import { RevisionSchema, type Revision, type Stop } from '@/domain'
import {
  NOTE_SEPARATOR,
  REPORT_PRESETS,
  type PresetId,
} from '@/features/onsite-report/report-model'
import type { RevisionProposal, RevisionRequest } from '@/features/revision-review/api-client'

// 現地報告からの再計画だけで使う、承認可否の暫定ガード（純関数）。
// 共通の根拠・制約判定は #46 の担当であり、ここでは判定を作り直さない。
// 候補の制約判定を「下げる」方向にだけ働き、承認できない候補を承認できるようにはしない。
// #46で共通判定に置き換える暫定の処理（docs/PARTIAL_REVISION.md「現地報告フローの暫定ガード」）。

type ConstraintStatus = Revision['constraintCheck']['status']

// 数字が大きいほど承認から遠い。ガードはこの順位を下げる（上げる）ことしかしない。
const severity: Record<ConstraintStatus, number> = {
  satisfied: 0,
  unknown: 1,
  not_checked: 1,
  violated: 2,
}

// 承認できる候補に付いていた影響の説明は、ガードで承認できなくなった時点で使わない。
const GUARDED_IMPACT_SUMMARY = 'この予定だけが変更対象です。'

export interface OnSiteBlock {
  status: 'violated' | 'unknown'
  reasons: string[]
}

// 契約には報告の種類（休業・遅れなど）の欄が無い。フォームが作る説明文の形から、何が起きたかを読み取る。
// 読み取れない説明文（「その他」の自由記述、フォーム以外から作った報告）は null。
export function classifyReport(description: string): PresetId | null {
  const text = description.trim()
  const preset = REPORT_PRESETS.find(
    ({ label }) => text === label || text.startsWith(`${label}${NOTE_SEPARATOR}`),
  )
  return preset?.id ?? null
}

// 1つの候補が、現地の報告に照らして承認できない理由。問題がなければ null。
export function onSiteApprovalBlock(
  revision: Revision,
  target: Stop,
  description: string,
): OnSiteBlock | null {
  const category = classifyReport(description)
  const candidate = revision.diff.after
  const reasons: string[] = []
  let status: OnSiteBlock['status'] = 'unknown'

  // (a) 報告の対象になった施設と同じ施設（Place IDが同じ）は、名称が違っても代わりの候補にならない。
  //     Place IDが未同定（null）どうしは、同じ施設とは言えない。
  if (target.placeId !== null && candidate.placeId === target.placeId) {
    status = 'violated'
    reasons.push(
      category === 'closed'
        ? `休業と報告された「${target.name}」と同じ施設（同じPlace ID）のため、名称が違っても代わりの候補として承認できません。`
        : `報告の対象になった「${target.name}」と同じ施設（同じPlace ID）のため、代わりの候補として承認できません。`,
    )
  }

  // (b) 本人の現地報告と矛盾する根拠が残っている候補は、ほかの根拠が整合していても承認しない。
  if (
    candidate.evidence.some(
      ({ source, status: evidence }) => source.kind === 'user_report' && evidence === 'conflicting',
    )
  ) {
    status = 'violated'
    reasons.push(
      '本人の現地報告と矛盾する根拠（矛盾あり）がこの候補に残っているため、ほかの根拠が整合していても承認できません。',
    )
  }

  // (c) 遅れの報告があるのに、元の予定の時刻だけを根拠に「間に合う」とは言えない。
  //     いまの時刻・位置・遅れの大きさは評価できないため、未確認として承認しない。
  if (category === 'delayed') {
    reasons.push(
      '遅れの報告があります。予定の時刻だけを根拠にしており、いまの時刻と位置から間に合うかは評価できていないため、「間に合う見込み」とは言えず、承認できません。',
    )
  }

  return reasons.length > 0 ? { status, reasons } : null
}

// 制約判定を下げる。もとの判定より承認に近づけず、承認できる状態だった場合は理由で置き換える。
function lowered(revision: Revision, block: OnSiteBlock): Revision {
  const current = revision.constraintCheck
  const reasons = block.reasons.join('')
  const wasSatisfied = current.status === 'satisfied'
  return {
    ...revision,
    constraintCheck: {
      status: severity[block.status] > severity[current.status] ? block.status : current.status,
      explanation: wasSatisfied ? reasons : `${reasons}${current.explanation}`,
    },
    impactSummary: wasSatisfied ? GUARDED_IMPACT_SUMMARY : revision.impactSummary,
  }
}

// 現地報告の依頼に対する候補の応答へ、暫定ガードを適用する。ガードに当たらない候補は、そのまま返す。
// 形が不正な応答は触らない（受け取る側の検証が、応答全体を退ける）。
export function guardOnSiteProposal(
  proposal: RevisionProposal,
  request: RevisionRequest,
): RevisionProposal {
  if (request.context.phase !== 'on_site' || !Array.isArray(proposal.revisions)) return proposal
  const target = request.trip.stops.find(({ id }) => id === request.targetStopId)
  if (!target) return proposal
  const { description } = request.context.report

  let changed = false
  const revisions = proposal.revisions.map((revision) => {
    const parsed = RevisionSchema.safeParse(revision)
    if (!parsed.success) return revision
    const block = onSiteApprovalBlock(parsed.data, target, description)
    if (!block) return revision
    changed = true
    return lowered(parsed.data, block)
  })
  return changed ? { ...proposal, revisions } : proposal
}
