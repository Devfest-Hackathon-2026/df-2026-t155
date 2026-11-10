'use client'

import { useState, type ReactNode } from 'react'

import { requestTripGeneration } from '@/features/trip-planner/api-client'
import { requestTripVerification } from '@/features/trip-verification/api-client'
import { withAuthHeaders } from '@/features/trip-verification/browser-verify'
import { startNewAnonymousSession } from '@/lib/auth/client'
import { getProtectedApiHeadersForScope } from '@/lib/auth/protected-api'
import { beginSessionScopeOperation, type SessionScope } from '@/lib/auth/session-scope'
import { useSessionScope } from '@/lib/auth/use-session-scope'
import { isDemoSessionActive } from '@/lib/firebase/client'

import { HomePlanner } from './home-planner'

async function runScoped<T>(
  scope: SessionScope,
  signal: AbortSignal | undefined,
  run: (fetchFn: typeof fetch, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const operation = beginSessionScopeOperation(scope, signal)
  const page = new AbortController()
  const combined = AbortSignal.any([operation.signal, page.signal])
  const onPageHide = () => page.abort()
  const scopedFetch: typeof fetch = (input, init) => {
    operation.assertCurrent()
    combined.throwIfAborted()
    return fetch(input, { ...init, signal: combined, redirect: 'error' })
  }
  window.addEventListener('pagehide', onPageHide, { once: true })
  try {
    const result = await run(scopedFetch, combined)
    operation.assertCurrent('unknown')
    combined.throwIfAborted()
    return result
  } finally {
    window.removeEventListener('pagehide', onPageHide)
    operation.dispose()
  }
}

export function SessionHomePlanner() {
  const session = useSessionScope()
  const [starting, setStarting] = useState(false)
  const scope = session.status === 'authenticated' ? session.scope : undefined
  const demo = session.status !== 'restoring' && isDemoSessionActive()
  const demoEnded = session.status === 'session_ended' && demo
  let message = ''
  if (session.status === 'restoring') message = '利用状態を確認しています。'
  if (session.status === 'session_ended' || session.status === 'error')
    message = session.error.message
  if (demoEnded) message = 'デモの利用状態を確認できません。提出資料のURLを開き直してください。'

  const canStartNewSession = session.status === 'session_ended' && !demoEnded
  const showDemoNotice = Boolean(scope && demo)
  const statusContent: ReactNode = showDemoNotice ? (
    <p role="note" className="rounded-lg border border-gt-rule bg-white px-3 py-2 text-xs">
      デモの旅程・学び・利用枠は共有されます。個人情報は入力しないでください。
    </p>
  ) : message || canStartNewSession ? (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-gt-rule bg-white/90 px-3 py-2 text-xs">
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {canStartNewSession && (
        <button
          type="button"
          className="min-h-11 rounded-lg border border-gt-muted bg-gt-paper px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview disabled:opacity-60"
          disabled={starting}
          onClick={async () => {
            setStarting(true)
            try {
              await startNewAnonymousSession()
            } catch {
              // 失敗は既存の認証購読から表示する。
            } finally {
              setStarting(false)
            }
          }}
        >
          新しい利用を始める
        </button>
      )}
    </div>
  ) : null

  return (
    <>
      <HomePlanner
        showDiscoveryHome
        statusContent={statusContent}
        generate={(request, options) =>
          scope
            ? runScoped(scope, options?.signal, (fetchFn, signal) =>
                requestTripGeneration(request, {
                  ...options,
                  fetchFn,
                  signal,
                  getHeaders: () => getProtectedApiHeadersForScope(scope),
                }),
              ).catch(() => ({
                ok: false as const,
                failure: { kind: 'session_changed' as const, message: '利用状態が変わりました。' },
              }))
            : Promise.resolve({
                ok: false,
                failure: { kind: 'auth_required', message },
              })
        }
        verify={(trip, options) =>
          scope
            ? runScoped(scope, options?.signal, (fetchFn, signal) =>
                requestTripVerification(trip, {
                  fetchFn: withAuthHeaders(fetchFn, () => getProtectedApiHeadersForScope(scope), {
                    requireAuth: true,
                  }),
                  signal,
                }),
              ).catch(() => ({
                ok: false as const,
                failure: { kind: 'auth_required' as const, message: '利用状態が変わりました。' },
              }))
            : Promise.resolve({
                ok: false,
                failure: { kind: 'auth_required', message },
              })
        }
      />
    </>
  )
}
