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

const progressStyles: Record<StopProgress, string> = {
  visited: 'border-gt-rail bg-gt-bg text-gt-muted',
  current: 'border-gt-action bg-gt-line-tint text-gt-line-strong',
  upcoming: 'border-gt-rail bg-gt-bg text-gt-muted',
}

export function ProgressChip({
  progress,
  compact = false,
}: {
  progress: StopProgress
  compact?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] leading-tight font-bold ${progressStyles[progress]}`}
    >
      {progress === 'visited' && <CheckIcon size={10} />}
      {progress === 'current' && !compact && (
        <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      )}
      {stopProgressLabels[progress]}
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
