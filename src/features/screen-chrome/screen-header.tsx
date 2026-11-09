import type { ReactNode, Ref } from 'react'

export function GroundTripBrand({ subtitle }: { subtitle?: string }) {
  return (
    <div data-journey-brand className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-gt-action text-lg font-bold text-white"
      >
        G
      </span>
      <div className="min-w-0">
        <p className="text-lg leading-tight font-bold wrap-anywhere">GroundTrip</p>
        {subtitle && <p className="truncate text-[10px] text-gt-muted">{subtitle}</p>}
      </div>
    </div>
  )
}

export function ScreenHeader({
  title,
  subtitle,
  headingId,
  headingRef,
  backLabel,
  onBack,
  disabled,
}: {
  title: string
  subtitle: ReactNode
  headingId: string
  headingRef?: Ref<HTMLHeadingElement>
  backLabel?: string
  onBack?: () => void
  disabled?: boolean
}) {
  return (
    <header
      data-flow-header="subpage"
      className="gt-header-bleed flex min-h-[71px] items-center gap-3 bg-gt-paper py-2"
    >
      {onBack && (
        <button
          type="button"
          aria-label={backLabel ?? '戻る'}
          disabled={disabled}
          onClick={onBack}
          className="grid size-11 shrink-0 place-items-center rounded-full border-2 border-gt-ink bg-gt-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview disabled:opacity-60"
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 4-8 8 8 8" />
          </svg>
        </button>
      )}
      <div className="min-w-0">
        <h2 id={headingId} tabIndex={-1} ref={headingRef} className="gt-screen-title">
          {title}
        </h2>
        <p className="text-xs text-gt-muted wrap-anywhere">{subtitle}</p>
      </div>
    </header>
  )
}
