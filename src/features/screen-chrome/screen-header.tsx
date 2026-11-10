'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useRef, type ReactNode, type Ref } from 'react'

export const SHOW_HOME_EVENT = 'groundtrip:show-home'

export function GroundTripBrand() {
  const keyboard = useRef(false)
  return (
    <Link
      href="/"
      aria-label="GroundTrip ホーム"
      onKeyDown={(event) => {
        if (event.key === 'Enter') keyboard.current = true
      }}
      onPointerDown={() => {
        keyboard.current = false
      }}
      onClick={(event) => {
        keyboard.current ||= event.detail === 0
      }}
      onNavigate={(event) => {
        const moveFocus = keyboard.current
        keyboard.current = false
        // 同じURLの旅程画面からは、入力や旅程を保持したままホームを表示する。
        if (window.location.pathname !== '/') return
        if (
          !window.dispatchEvent(
            new CustomEvent(SHOW_HOME_EVENT, { cancelable: true, detail: moveFocus }),
          )
        ) {
          event.preventDefault()
        }
      }}
      className="inline-flex min-h-11 items-center rounded-lg bg-gt-paper px-1 py-1 hover:bg-gt-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
    >
      <Image
        src="/brand/groundtrip-logo.png"
        alt=""
        width={1050}
        height={838}
        sizes="84px"
        className="h-auto w-[84px]"
        priority
      />
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
    <div data-flow-header="subpage" className="flex items-center gap-3 py-2">
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
    </div>
  )
}
