import type { ReactNode } from 'react'

import { evidenceStatusLabels, type Evidence, type EvidenceStatus } from '@/domain'

import { evidenceSourceLabels, evidenceSubjectLabels } from './model'

// 根拠の状態表示。色だけに頼らず、記号とラベルを必ず併用する。
type StatusTone = EvidenceStatus | 'unverified'

const styles: Record<StatusTone, string> = {
  consistent: 'border-gt-ok/35 bg-gt-ok-bg text-gt-ok',
  conflicting: 'border-gt-warn/35 bg-gt-warn-bg text-gt-warn',
  unverifiable: 'border-gt-unk/35 bg-gt-unk-bg text-gt-unk',
  unverified: 'border-gt-rail/40 bg-gt-unchecked text-gt-muted',
}

const marks: Record<StatusTone, string> = {
  consistent: 'm7 12 3.5 3.5L17 9',
  conflicting: 'm9 9 6 6m0-6-6 6',
  unverifiable: 'M9 9a3 3 0 1 1 5 2.2c-1 .7-2 1.3-2 2.8m0 3h.01',
  unverified: 'M8 12h8',
}

function Mark({ status }: { status: StatusTone }) {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9.5" />
      <path d={marks[status]} />
    </svg>
  )
}

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold leading-snug ${styles[tone]}`}
    >
      <Mark status={tone} />
      {children}
    </span>
  )
}

export function EvidenceBadge({ evidence }: { evidence: Pick<Evidence, 'subject' | 'status'> }) {
  return (
    <StatusBadge tone={evidence.status}>
      {evidenceSubjectLabels[evidence.subject]}：{evidenceStatusLabels[evidence.status]}
    </StatusBadge>
  )
}

// まだ照合していない（evidenceが空）。「確認できない」とは別の状態として示す。
export function UnverifiedBadge({ subject }: { subject?: string }) {
  return <StatusBadge tone="unverified">{subject ? `${subject}：未照合` : '未照合'}</StatusBadge>
}

export const checkedAtFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  dateStyle: 'medium',
  timeStyle: 'short',
})

// タップ（開閉）で、情報源・取得日時・確認した項目・確認できていない点を見られる。
export function EvidenceDetail({ evidence }: { evidence: Evidence }) {
  const note =
    evidence.status === 'consistent'
      ? '「情報源と整合」は、現実の正しさや将来の営業を保証するものではありません。'
      : evidence.status === 'unverifiable'
        ? '確認できていないことを、整合とは扱いません。'
        : '情報源との矛盾があります。内容を確認してから判断してください。'
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <EvidenceBadge evidence={evidence} />
        <span className="text-sm text-gt-muted underline">根拠を見る</span>
      </summary>
      <div className="my-1.5 border-l-[3px] border-gt-rule py-1 pl-3 text-sm wrap-anywhere">
        <dl className="grid grid-cols-[5em_minmax(0,1fr)] gap-x-2 gap-y-1">
          <dt className="text-gt-muted">確認項目</dt>
          <dd>{evidenceSubjectLabels[evidence.subject]}</dd>
          <dt className="text-gt-muted">内容</dt>
          <dd>{evidence.claim}</dd>
          <dt className="text-gt-muted">対象</dt>
          <dd>{evidence.applicability}</dd>
          <dt className="text-gt-muted">情報源</dt>
          <dd>
            {evidenceSourceLabels[evidence.source.kind]}（{evidence.source.label}）
            {evidence.source.url && (
              <>
                {' '}
                <a
                  href={evidence.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  情報源を開く<span className="sr-only">（新しいタブで開きます）</span>
                </a>
              </>
            )}
          </dd>
          <dt className="text-gt-muted">照合日時</dt>
          <dd>{checkedAtFormat.format(new Date(evidence.checkedAt))}</dd>
          <dt className="text-gt-muted">説明</dt>
          <dd>{evidence.explanation}</dd>
        </dl>
        <p className="mt-1.5 text-gt-muted">{note}</p>
      </div>
    </details>
  )
}
