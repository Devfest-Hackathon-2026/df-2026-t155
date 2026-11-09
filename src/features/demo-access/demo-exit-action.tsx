'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useRef, useState, useSyncExternalStore } from 'react'

import { endDemoSession } from '@/lib/auth/client'
import { getDemoSessionStatus } from '@/lib/firebase/client'

function subscribeToPageShow(listener: () => void): () => void {
  window.addEventListener('pageshow', listener)
  return () => window.removeEventListener('pageshow', listener)
}

function useDemoSessionStatus() {
  return useSyncExternalStore(subscribeToPageShow, getDemoSessionStatus, () => null)
}

export function DemoExitAction() {
  const pathname = usePathname()
  const status = useDemoSessionStatus()
  const busy = useRef(false)
  const [phase, setPhase] = useState<'idle' | 'pending' | 'failed'>('idle')

  const canExit =
    status === 'active' ||
    status === 'exit_requested' ||
    (status === 'unavailable' && phase !== 'idle')
  if (pathname === '/access' || !canExit) return null

  async function handleExit() {
    if (busy.current) return
    busy.current = true
    setPhase('pending')
    try {
      await endDemoSession()
      window.location.replace('/demo-ended')
    } catch {
      busy.current = false
      setPhase('failed')
    }
  }

  return (
    <>
      <button
        type="button"
        aria-disabled={phase === 'pending'}
        className="col-start-2 row-start-1 my-3 min-h-11 self-start rounded-lg border border-gt-muted bg-gt-paper px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview aria-disabled:opacity-60"
        onClick={handleExit}
      >
        デモを終了する
      </button>
      <p role="status" className="sr-only">
        {phase === 'pending' ? 'デモを終了しています。' : ''}
      </p>
      <p
        role="alert"
        className={phase === 'failed' ? 'gt-notice col-span-2 mb-2' : 'sr-only'}
        data-tone="error"
      >
        {phase === 'failed'
          ? 'デモを終了できませんでした。時間をおいて「デモを終了する」をもう一度押してください。終了できない場合は、このタブを閉じて新しいタブで通常のURLを開いてください。'
          : ''}
      </p>
    </>
  )
}

export function DemoEndedScreen() {
  const status = useDemoSessionStatus()

  if (status !== 'inactive') {
    const messages = {
      active: 'ヘッダーの「デモを終了する」から終了できます。',
      exit_requested: 'ヘッダーの「デモを終了する」から終了操作を完了してください。',
      unavailable: '利用状態を確認できません。ブラウザの設定を確認して再読み込みしてください。',
    }
    return (
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">デモの利用状態</h1>
        <p role="status" className="text-sm">
          {status === null ? '利用状態を確認しています。' : messages[status]}
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">デモを終了しました</h1>
      <p className="text-sm">このタブでのデモ利用を終了しました。</p>
      <Link
        href="/"
        prefetch={false}
        className="inline-flex min-h-11 items-center rounded-lg border border-gt-muted bg-gt-paper px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
      >
        通常の利用へ
      </Link>
    </section>
  )
}
