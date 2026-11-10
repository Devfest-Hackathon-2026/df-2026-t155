'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type JourneyScreen = 'before' | 'during' | 'reflection' | 'check-saved'
export type HomeHistoryScreen = 'discovery' | 'bookmarks' | 'records' | 'create'

type View = { screen: 'home' | JourneyScreen | HomeHistoryScreen; journeyKey: number }
type Entry = { owner: string; view: View; previous?: View }
type HistoryState = { groundTripJourney?: Entry } | null

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
  const [{ entry, fromHistory }, setNavigation] = useState(() => ({
    entry: typeof window === 'undefined' ? null : readEntry(window.history.state, owner),
    fromHistory: false,
  }))
  const returning = useRef(false)

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
      returning.current = false
      setNavigation({ entry: readEntry(event.state, owner), fromHistory: true })
    }
    window.addEventListener('popstate', restore)
    return () => {
      mounted = false
      if (history.replaceState === replaceWithJourney) history.replaceState = replace
      window.removeEventListener('popstate', restore)
    }
  }, [owner])

  const navigate = useCallback(
    (view: View, back = false) => {
      const current = readEntry(window.history.state, owner)
      if (returning.current || sameView(current?.view, view)) return false
      if (back && sameView(current?.previous, view)) {
        returning.current = true
        window.history.back()
        return true
      }
      const next = { owner, view, previous: current?.view }
      // 既存のApp Routerの履歴情報を消さない。同一URLの画面切替だけを記録する。
      // 旅程や自由記述は履歴に保存しない（現在のマウントで保持する）。
      window.history.pushState({ ...window.history.state, groundTripJourney: next }, '')
      setNavigation({ entry: next, fromHistory: false })
      return true
    },
    [owner],
  )

  const initialize = useCallback(
    (view: View) => {
      const current = readEntry(window.history.state, owner)
      if (current) {
        setNavigation({ entry: current, fromHistory: false })
        return
      }
      const next = { owner, view }
      window.history.replaceState({ ...window.history.state, groundTripJourney: next }, '')
      setNavigation({ entry: next, fromHistory: false })
    },
    [owner],
  )

  return { entry, fromHistory, navigate, initialize }
}
