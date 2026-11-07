import type { Approval } from '@/domain'

import { formatCheckedAt } from './format'
import { APPROVAL_WORDING, type ApprovalTone } from './wording'

export type ApprovalWording = {
  label: string
  detail?: string
  tone: ApprovalTone
}

// 本人の判断（approval）を、利用者向けの言葉にする。根拠の照合・制約判定とは別の軸。
export function describeApproval(approval: Approval): ApprovalWording {
  const wording = APPROVAL_WORDING[approval.status]
  if (approval.status === 'pending') return { ...wording }
  const decidedAt = `判断した日時：${formatCheckedAt(approval.decidedAt)}`
  return {
    label: wording.label,
    detail: wording.detail ? `${wording.detail} ${decidedAt}` : decidedAt,
    tone: wording.tone,
  }
}
