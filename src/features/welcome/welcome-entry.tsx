'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

const WELCOME_COMPLETED_KEY = 'groundtrip:welcome-completed:v1'
let completedInMemory = false

export function hasCompletedWelcome(): boolean {
  if (completedInMemory) return true
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(WELCOME_COMPLETED_KEY) === 'true'
  } catch {
    return false
  }
}

export function completeWelcome(): void {
  completedInMemory = true
  try {
    window.localStorage.setItem(WELCOME_COMPLETED_KEY, 'true')
  } catch {
    // The module-level flag keeps this visit moving when browser storage is blocked.
  }
}

export function WelcomeEntry({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const redirectStarted = useRef(false)

  useEffect(() => {
    if (hasCompletedWelcome()) {
      setReady(true)
      return
    }
    if (redirectStarted.current) return
    redirectStarted.current = true
    router.replace('/welcome')
  }, [router])

  return ready ? children : null
}
