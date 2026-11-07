import type { TravelBasisKind } from './progress-model'
import { stopProgressLabels, type StopProgress } from './progress-model'

// 進行状況の表示で使う小さな部品（印・チップ）。状態は、色だけでなく、形と文字で必ず区別する。

export function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}

export function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

// 固定は予約済み・購入済みを意味しない。予定の種類や進行状態とは独立に付ける。
export function FixedChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border-2 border-(color:--tp-ink) bg-(color:--tp-card) px-2 py-0.5 text-xs font-bold text-(color:--tp-ink)">
      <LockIcon />
      固定予定
    </span>
  )
}

// 進行状態のチップ。訪問済み＝チェック、いま＝塗りつぶし、これから＝点線の枠。文字も併記する。
export function ProgressChip({ progress }: { progress: StopProgress }) {
  const label = stopProgressLabels[progress]
  if (progress === 'visited') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border-2 border-(color:--tp-edge) bg-(color:--tp-card) px-2 py-0.5 text-xs font-bold text-(color:--tp-muted)">
        <CheckIcon size={12} />
        {label}
      </span>
    )
  }
  if (progress === 'current') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border-2 border-(color:--tp-accent) bg-(color:--tp-accent) px-2 py-0.5 text-xs font-bold text-white">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 1l7 4-7 4z" fill="currentColor" />
        </svg>
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-md border-2 border-dashed border-(color:--tp-edge) bg-(color:--tp-card) px-2 py-0.5 text-xs font-bold text-(color:--tp-muted)">
      {label}
    </span>
  )
}

const markStyles: Record<TravelBasisKind, string> = {
  consistent: 'rounded-full bg-(color:--tp-ok) text-white',
  conflicting: 'rounded-[3px] bg-(color:--tp-warn) text-white',
  unverifiable: 'rounded-full border-2 border-dashed border-(color:--tp-unk) text-(color:--tp-unk)',
  unchecked:
    'rounded-full border-2 border-dotted border-(color:--tp-muted) text-(color:--tp-muted)',
}

// 根拠の状態の印（整合＝チェック、矛盾＝!、確認できない＝?、未確認・未照合＝−）。必ず文字と併用する。
// 模擬データ（デモ用の想定）は、実測の「整合」と区別するため、破線の枠＋「デモ」の文字にする（色だけで区別しない）。
export function StatusMark({
  kind,
  simulated = false,
}: {
  kind: TravelBasisKind
  simulated?: boolean
}) {
  if (simulated) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-4 shrink-0 items-center justify-center rounded-[3px] border-2 border-dashed border-(color:--tp-edge) px-0.5 text-[9px] font-black leading-none text-(color:--tp-muted)"
      >
        デモ
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-4 shrink-0 items-center justify-center text-[11px] font-black leading-none ${markStyles[kind]}`}
    >
      {kind === 'consistent' ? (
        <CheckIcon size={10} />
      ) : kind === 'conflicting' ? (
        '!'
      ) : kind === 'unverifiable' ? (
        '?'
      ) : (
        '−'
      )}
    </span>
  )
}

const statusTextColors: Record<TravelBasisKind, string> = {
  consistent: 'text-(color:--tp-ok)',
  conflicting: 'text-(color:--tp-warn)',
  unverifiable: 'text-(color:--tp-unk)',
  unchecked: 'text-(color:--tp-muted)',
}

// 印と文字の並び（1行）。長い文字列は折り返す。模擬データは、状態の色を使わず、補助の色で示す。
export function StatusLine({
  kind,
  simulated = false,
  children,
}: {
  kind: TravelBasisKind
  simulated?: boolean
  children: string
}) {
  return (
    <span
      className={`flex items-start gap-2 text-sm font-bold [overflow-wrap:anywhere] ${
        simulated ? 'text-(color:--tp-muted)' : statusTextColors[kind]
      }`}
    >
      <span className="mt-0.5">
        <StatusMark kind={kind} simulated={simulated} />
      </span>
      <span className="min-w-0">{children}</span>
    </span>
  )
}
