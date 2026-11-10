'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type JourneyScreen = 'before' | 'during' | 'reflection' | 'check-saved'
export type HomeHistoryScreen = 'discovery' | 'bookmarks' | 'records' | 'create'

type View = { screen: 'home' | JourneyScreen | HomeHistoryScreen; journeyKey: number }
type Entry = { owner: string; id: number; view: View; previous?: View }
type HistoryState = { groundTripJourney?: Entry } | null
type NavigationKind = 'push' | 'browser' | 'return'
export type PositionJourneyScreen = (
  top?: number,
  revealHeading?: HTMLHeadingElement | null,
) => void | (() => void)

const sameView = (left: View | undefined, right: View) =>
  left?.journeyKey === right.journeyKey && left.screen === right.screen

function readEntry(state: HistoryState, owner: string) {
  const entry = state?.groundTripJourney
  return entry?.owner === owner ? entry : null
}

function isCurrentUrl(url?: string | URL | null) {
  if (url == null) return true
  const current = window.location.href
  try {
    return new URL(url, current).href === current
  } catch {
    return false
  }
}

// 履歴は画面への目印だけを持つ。再読込・別ページから戻った場合は、以前のマウントの目印を使わない。
export function useJourneyHistory() {
  const [owner] = useState(() => crypto.getRandomValues(new Uint32Array(4)).join('-'))
  const [{ entry, kind, scrollTop }, setNavigation] = useState<{
    entry: Entry | null
    kind: NavigationKind
    scrollTop: number
  }>(() => ({
    entry: typeof window === 'undefined' ? null : readEntry(window.history.state, owner),
    kind: 'push',
    scrollTop: 0,
  }))
  const returning = useRef(false)
  const nextEntryId = useRef(0)
  const currentEntry = useRef(entry)
  const scrollPositions = useRef(new Map<number, number>())

  const rememberPosition = useCallback(() => {
    const current = currentEntry.current
    if (current) scrollPositions.current.set(current.id, window.scrollY)
  }, [])

  useEffect(() => {
    const history = window.history
    const replace = history.replaceState
    let mounted = true

    // App Routerは同一URLのrefreshなどで独自のstateを省いてreplaceStateする。
    // 今いるエントリの目印だけを補い、Next.jsが渡したstateはそのまま使う。
    const replaceWithJourney: History['replaceState'] = function (
      this: History,
      data: unknown,
      title,
      url,
    ) {
      if (
        mounted &&
        this === history &&
        data !== null &&
        typeof data === 'object' &&
        Object.getPrototypeOf(data) === Object.prototype &&
        !('groundTripJourney' in data) &&
        isCurrentUrl(url)
      ) {
        const current = readEntry(history.state, owner)
        if (current) return replace.call(this, { ...data, groundTripJourney: current }, title, url)
      }
      return replace.call(this, data, title, url)
    }
    history.replaceState = replaceWithJourney

    const restore = (event: PopStateEvent) => {
      const kind = returning.current ? 'return' : 'browser'
      returning.current = false
      rememberPosition()
      const target = readEntry(event.state, owner)
      currentEntry.current = target
      setNavigation({
        entry: target,
        kind,
        scrollTop: target ? (scrollPositions.current.get(target.id) ?? 0) : 0,
      })
    }
    window.addEventListener('popstate', restore)
    return () => {
      mounted = false
      if (history.replaceState === replaceWithJourney) history.replaceState = replace
      window.removeEventListener('popstate', restore)
    }
  }, [owner, rememberPosition])

  const navigate = useCallback(
    (view: View, back = false) => {
      const current = readEntry(window.history.state, owner)
      if (returning.current || sameView(current?.view, view)) return false
      if (back && sameView(current?.previous, view)) {
        returning.current = true
        window.history.back()
        return true
      }
      rememberPosition()
      const next = { owner, id: ++nextEntryId.current, view, previous: current?.view }
      // 既存のApp Routerの履歴情報を消さない。同一URLの画面切替だけを記録する。
      // 旅程や自由記述は履歴に保存しない（現在のマウントで保持する）。
      window.history.pushState({ ...window.history.state, groundTripJourney: next }, '')
      currentEntry.current = next
      setNavigation({ entry: next, kind: 'push', scrollTop: 0 })
      return true
    },
    [owner, rememberPosition],
  )

  const initialize = useCallback(
    (view: View) => {
      const current = readEntry(window.history.state, owner)
      if (current) {
        currentEntry.current = current
        setNavigation({ entry: current, kind: 'push', scrollTop: 0 })
        return
      }
      const next = { owner, id: ++nextEntryId.current, view }
      window.history.replaceState({ ...window.history.state, groundTripJourney: next }, '')
      currentEntry.current = next
      setNavigation({ entry: next, kind: 'push', scrollTop: 0 })
    },
    [owner],
  )

  const positionScreen = useCallback<PositionJourneyScreen>(
    (top = scrollTop, revealHeading) => {
      const position = () => {
        if (window.scrollY !== top) window.scrollTo({ top, behavior: 'instant' })
        if (!revealHeading) return
        const bounds = revealHeading.getBoundingClientRect()
        if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
          revealHeading.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        }
      }
      if (kind === 'push') {
        position()
        return
      }
      // popstate後にブラウザが保存位置を適用する。描画済みの画面への復元はその後に行う。
      const frame = window.requestAnimationFrame(position)
      return () => window.cancelAnimationFrame(frame)
    },
    [kind, scrollTop],
  )

  return { entry, kind, positionScreen, navigate, initialize }
}
