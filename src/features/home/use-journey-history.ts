'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type JourneyScreen = 'before' | 'during' | 'reflection' | 'check-saved'

type View = { screen: 'home' | JourneyScreen; journeyKey: number }
type Entry = { owner: string; view: View; previous?: View }
type HistoryState = { groundTripJourney?: Entry } | null

const sameView = (left: View | undefined, right: View) =>
  left?.journeyKey === right.journeyKey && left.screen === right.screen

function readEntry(state: HistoryState, owner: string) {
  const entry = state?.groundTripJourney
  return entry?.owner === owner ? entry : null
}

// 履歴は画面への目印だけを持つ。再読込・別ページから戻った場合は、以前のマウントの目印を使わない。
export function useJourneyHistory() {
  const [owner] = useState(() => crypto.getRandomValues(new Uint32Array(4)).join('-'))
  const [entry, setEntry] = useState<Entry | null>(null)
  const returning = useRef(false)

  useEffect(() => {
    const restore = (event: PopStateEvent) => {
      returning.current = false
      setEntry(readEntry(event.state, owner))
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
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
      setEntry(next)
      return true
    },
    [owner],
  )

  return { entry, navigate }
}
