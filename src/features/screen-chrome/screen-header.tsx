'use client'

import Link from 'next/link'
import type { ReactNode, Ref } from 'react'

export const SHOW_HOME_EVENT = 'groundtrip:show-home'

export function GroundTripBrand() {
  return (
    <Link
      href="/"
      aria-label="GroundTrip ホーム"
      onNavigate={(event) => {
        // 同じURLの旅程画面からは、入力や旅程を保持したままホームを表示する。
        if (window.location.pathname !== '/') return
        if (!window.dispatchEvent(new Event(SHOW_HOME_EVENT, { cancelable: true }))) {
          event.preventDefault()
        }
      }}
      className="inline-flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
    >
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-gt-action text-lg font-bold text-white"
      >
        G
      </span>
      <span className="min-w-0 text-lg leading-tight font-bold wrap-anywhere">GroundTrip</span>
    </Link>
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
