import { evidenceStatusLabels, type Evidence, type EvidenceStatus } from '@/domain'

import { evidenceSourceLabels, evidenceSubjectLabels } from './model'

// 根拠の状態表示。色だけに頼らず、記号とラベルを必ず併用する。
const styles: Record<EvidenceStatus, { box: string; icon: string }> = {
  consistent: {
    box: 'border-gt-ok bg-gt-ok-bg text-gt-ok',
    icon: 'rounded-full bg-gt-ok text-white',
  },
  conflicting: {
    box: 'border-gt-warn bg-gt-warn-bg text-gt-warn',
    icon: 'rounded-[3px] bg-gt-warn text-white',
  },
  unverifiable: {
    box: 'border-dashed border-gt-unk bg-gt-unk-bg text-gt-unk',
    icon: 'rounded-full border-[1.5px] border-dashed border-gt-unk',
  },
}

function Mark({ status }: { status: EvidenceStatus }) {
  const common = 'inline-flex size-4 items-center justify-center'
  if (status === 'consistent') {
    return (
      <span aria-hidden="true" className={`${common} ${styles[status].icon}`}>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`${common} text-[10px] font-black leading-none ${styles[status].icon}`}
    >
      {status === 'conflicting' ? '!' : '?'}
    </span>
  )
}

export function EvidenceBadge({ evidence }: { evidence: Pick<Evidence, 'subject' | 'status'> }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border-[1.5px] py-0.5 pl-1 pr-2 text-[11.5px] font-bold leading-tight ${styles[evidence.status].box}`}
    >
      <Mark status={evidence.status} />
      {evidenceSubjectLabels[evidence.subject]}：{evidenceStatusLabels[evidence.status]}
    </span>
  )
}

// まだ照合していない（evidenceが空）。「確認できない」とは別の状態として示す。
export function UnverifiedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border-[1.5px] border-dotted border-gt-muted py-0.5 pl-1 pr-2 text-[11.5px] font-bold leading-tight text-gt-muted">
      <span
        aria-hidden="true"
        className="inline-flex size-4 items-center justify-center rounded-full border-[1.5px] border-dotted border-gt-muted text-[10px] leading-none"
      >
        −
      </span>
      未照合
    </span>
  )
}

const checkedAtFormat = new Intl.DateTimeFormat('ja-JP', {
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
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <EvidenceBadge evidence={evidence} />
        <span className="text-xs text-gt-muted underline">根拠を見る</span>
      </summary>
      <div className="my-1.5 border-l-[3px] border-gt-rule py-1 pl-3 text-xs">
        <dl className="grid grid-cols-[5.5em_1fr] gap-x-2 gap-y-0.5">
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
