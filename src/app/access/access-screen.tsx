'use client'

import { useEffect, useRef, useState } from 'react'

import {
  demoAccessExchangePath,
  demoAccessTicket,
  demoAccessTokenResponse,
} from '@/features/demo-access/contract'
import { getAppCheckToken } from '@/lib/auth/protected-api'
import { getDemoClientApp, getDemoSessionStatus, prepareDemoSignIn } from '@/lib/firebase/client'

type AccessResult = 'authenticated' | 'invalid' | 'limited' | 'unavailable' | 'exit_pending'

async function enterDemo(signal: AbortSignal): Promise<AccessResult> {
  const match = /^#ticket=([A-Za-z0-9_-]+)$/.exec(window.location.hash)
  // App Checkの外部スクリプトを読み込む前に、フラグメントを履歴から除去する。
  window.history.replaceState(window.history.state, '', '/access')
  const ticket = demoAccessTicket.safeParse(match?.[1])
  if (!ticket.success) return 'invalid'
  const status = getDemoSessionStatus()
  if (status === 'exit_requested') return 'exit_pending'
  if (status === 'unavailable') return 'unavailable'

  const signIn = prepareDemoSignIn()
  const appCheck = await getAppCheckToken(getDemoClientApp())
  signal.throwIfAborted()
  const response = await fetch(demoAccessExchangePath, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Firebase-AppCheck': appCheck },
    body: ticket.data,
    cache: 'no-store',
    credentials: 'omit',
    mode: 'same-origin',
    // ページのno-referrer設定下でも、交換APIが検証するOriginを同一オリジンのPOSTに付ける。
    referrerPolicy: 'same-origin',
    redirect: 'error',
    signal,
  })
  if (response.status === 403) return 'invalid'
  if (response.status === 429) return 'limited'
  if (!response.ok) return 'unavailable'

  const { customToken } = demoAccessTokenResponse.parse(await response.json())
  signal.throwIfAborted()
  if (await signIn(customToken, signal)) return 'authenticated'
  return getDemoSessionStatus() === 'exit_requested' ? 'exit_pending' : 'unavailable'
}

function startAccess() {
  const controller = new AbortController()
  const onPageHide = () => controller.abort()
  window.addEventListener('pagehide', onPageHide, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<AccessResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('unavailable')
    }, 15_000)
  })
  const result = Promise.race([enterDemo(controller.signal), timeout]).finally(() => {
    clearTimeout(timer)
    window.removeEventListener('pagehide', onPageHide)
  })
  return { result, cancel: onPageHide }
}

const messages = {
  invalid: 'デモへのアクセスを確認できませんでした。提出資料のURLをご確認ください。',
  limited: 'デモのアクセスが集中しています。時間をおいて提出資料のURLを開き直してください。',
  unavailable: 'デモへ接続できませんでした。時間をおいて提出資料のURLを開き直してください。',
  exit_pending:
    '前のデモの終了操作が残っています。通常画面に戻り、ヘッダーの「デモを終了する」を押してください。',
}

export function AccessScreen() {
  const attempt = useRef<ReturnType<typeof startAccess> | null>(null)
  const mounted = useRef(false)
  const [error, setError] = useState<Exclude<AccessResult, 'authenticated'> | null>(null)

  useEffect(() => {
    let active = true
    mounted.current = true
    const current = (attempt.current ??= startAccess())
    void current.result
      .then((result) => {
        if (!active) return
        if (result === 'authenticated') {
          if (window.location.pathname !== '/access' || getDemoSessionStatus() !== 'active') return
          // 前の画面のReact状態・認証スコープを引き継がず、通常画面を読み込み直す。
          window.location.replace('/')
        } else {
          setError(result)
        }
      })
      .catch(() => {
        if (active) setError('unavailable')
      })
    return () => {
      active = false
      mounted.current = false
      // Strict Modeの同期的な購読の張り直しと実際のSPA離脱を区別する。
      queueMicrotask(() => {
        if (!mounted.current) current.cancel()
      })
    }
  }, [])

  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">GroundTripのデモ</h1>
      <p className="text-sm">
        このタブでデモを開きます。デモの保存データと利用枠は、ほかのデモ利用者と共有されます。
      </p>
      {error ? (
        <p role="alert" className="text-sm">
          {messages[error]}
        </p>
      ) : (
        <p role="status" className="text-sm">
          デモへのアクセスを確認しています…
        </p>
      )}
    </section>
  )
}
