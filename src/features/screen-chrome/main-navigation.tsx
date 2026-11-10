'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type MainPage = 'home' | 'bookmarks' | 'records'

const items = [
  { id: 'home', label: 'ホーム' },
  { id: 'bookmarks', label: 'しおり' },
  { id: 'records', label: '記録' },
] as const

export function MainNavigation({
  current,
  onNavigate,
}: {
  current?: MainPage
  onNavigate: (page: MainPage, keyboard: boolean) => void
}) {
  const [target, setTarget] = useState<{ slot: HTMLElement; desktop: boolean }>()
  const focusOnResize = useRef<string | undefined>(undefined)

  useEffect(() => {
    const desktop = document.getElementById('gt-desktop-nav')
    const mobile = document.getElementById('gt-mobile-nav')
    if (!desktop || !mobile) return

    // 表示位置はポータルを移して切り替える。CSSで先に隠すとフォーカス元を判別できない。
    const media = window.matchMedia('(min-width: 64rem)')
    const updateTarget = () => {
      const [next, previous] = media.matches ? [desktop, mobile] : [mobile, desktop]
      focusOnResize.current =
        previous.querySelector<HTMLButtonElement>('button:focus')?.dataset.navPage
      setTarget({ slot: next, desktop: media.matches })
    }

    updateTarget()
    media.addEventListener('change', updateTarget)
    return () => media.removeEventListener('change', updateTarget)
  }, [])

  useLayoutEffect(() => {
    const page = focusOnResize.current
    focusOnResize.current = undefined
    if (!page) return
    target?.slot
      .querySelector<HTMLButtonElement>(`button[data-nav-page="${page}"]`)
      ?.focus({ preventScroll: true })
  }, [target])

  if (!target) return null
  return createPortal(
    <nav
      aria-label="メインナビゲーション"
      className={
        target.desktop ? 'flex justify-end gap-1' : 'mx-auto grid max-w-xl grid-cols-3 py-0.5'
      }
    >
      {items.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          data-nav-page={id}
          aria-current={current === id ? 'page' : undefined}
          onClick={(event) => onNavigate(id, event.detail === 0)}
          className="min-h-11 rounded-lg px-3 text-sm font-semibold whitespace-nowrap hover:bg-gt-bg focus-visible:outline-2 focus-visible:outline-gt-preview underline-offset-4 aria-[current=page]:text-gt-action aria-[current=page]:underline lg:hover:aria-[current=page]:text-gt-line-strong"
        >
          {label}
        </button>
      ))}
    </nav>,
    target.slot,
  )
}
