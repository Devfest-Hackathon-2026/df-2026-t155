'use client'

import { signInWithCustomToken } from 'firebase/auth'
import { useEffect, useRef, useState } from 'react'

import {
  demoAccessExchangePath,
  demoAccessTicket,
  demoAccessTokenResponse,
} from '@/features/demo-access/contract'
import { getAppCheckToken } from '@/lib/auth/protected-api'
import { activateDemoSession, getDemoClientAuth, isDemoSessionActive } from '@/lib/firebase/client'

type AccessResult = 'authenticated' | 'invalid' | 'limited' | 'unavailable'

async function enterDemo(signal: AbortSignal): Promise<AccessResult> {
  const match = /^#ticket=([A-Za-z0-9_-]+)$/.exec(window.location.hash)
  // App Checkの外部スクリプトを読み込む前に、フラグメントを履歴から除去する。
  window.history.replaceState(window.history.state, '', '/access')
  const ticket = demoAccessTicket.safeParse(match?.[1])
  if (!ticket.success) return 'invalid'

  const auth = getDemoClientAuth()
  const appCheck = await getAppCheckToken(auth.app)
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
  await signInWithCustomToken(auth, customToken)
  // 画面を離れた後の完了でも、すでに使っていたデモ認証の旧世代を無効にする。
  if (isDemoSessionActive()) activateDemoSession()
  return 'authenticated'
}

function startAccess(): Promise<AccessResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<AccessResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('unavailable')
    }, 15_000)
  })
  return Promise.race([enterDemo(controller.signal), timeout]).finally(() => clearTimeout(timer))
}

const messages = {
  invalid: 'デモへのアクセスを確認できませんでした。提出資料のURLをご確認ください。',
  limited: 'デモのアクセスが集中しています。時間をおいて提出資料のURLを開き直してください。',
  unavailable: 'デモへ接続できませんでした。時間をおいて提出資料のURLを開き直してください。',
}

export function AccessScreen() {
  const attempt = useRef<Promise<AccessResult> | null>(null)
  const [error, setError] = useState<Exclude<AccessResult, 'authenticated'> | null>(null)

  useEffect(() => {
    let active = true
    attempt.current ??= startAccess()
    void attempt.current
      .then((result) => {
        if (!active) return
        if (result === 'authenticated') {
          if (!isDemoSessionActive()) activateDemoSession()
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
