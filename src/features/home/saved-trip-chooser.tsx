'use client'
import { useEffect, useRef, useState } from 'react'
import type { Trip } from '@/domain'
import { loadSavedTrips } from '@/features/reflection-flow/api-client'
import {
  assertCurrentSessionScopeSync,
  beginSessionScopeOperation,
  isSameScope,
  type SessionScope,
  type SessionScopeOperation,
} from '@/lib/auth/session-scope'

type TripList = Awaited<ReturnType<typeof loadSavedTrips>>
type LoadedTrips = { scope: SessionScope; result: TripList }
type ScopedMessage = { scope: SessionScope; text: string }

export function SavedTripChooser({
  scope,
  onChoose,
  load = loadSavedTrips,
}: {
  scope: SessionScope | null
  onChoose: (trip: Trip) => void
  load?: typeof loadSavedTrips
}) {
  const [loaded, setLoaded] = useState<LoadedTrips | null>(null)
  const [message, setMessage] = useState<ScopedMessage | null>(null)
  const active = useRef<SessionScopeOperation | null>(null)
  const currentScope = useRef(scope)

  // Render-time invalidation prevents old-session data from flashing before effects run.
  if (currentScope.current !== scope) {
    active.current?.dispose()
    active.current = null
    currentScope.current = scope
  }
  useEffect(
    () => () => {
      active.current?.dispose()
      active.current = null
    },
    [],
  )

  const usableScope = (candidate: SessionScope) => {
    if (!scope || currentScope.current !== candidate || !isSameScope(candidate, scope)) return false
    try {
      assertCurrentSessionScopeSync(candidate)
      return true
    } catch {
      return false
    }
  }

  const open = async () => {
    if (!scope || active.current || !usableScope(scope)) return
    let operation: SessionScopeOperation
    try {
      operation = beginSessionScopeOperation(scope)
    } catch {
      setMessage({
        scope,
        text: '保存した旅程を確認できませんでした。画面を読み込み直してください。',
      })
      return
    }
    active.current = operation
    setLoaded(null)
    setMessage({ scope, text: '保存した旅程を確認中です。' })
    try {
      operation.assertCurrent()
      const result = await load(scope, { signal: operation.signal })
      operation.assertCurrent()
      if (operation.signal.aborted || !usableScope(scope)) return
      setLoaded({ scope, result })
      const notices = [
        result.listInfo.skippedInvalid > 0
          ? `読み込めなかった保存旅程が${result.listInfo.skippedInvalid}件あります。`
          : '',
        result.listInfo.truncated ? '表示件数に上限があります。' : '',
        result.trips.length === 0 ? '保存した旅程はありません。' : '',
      ].filter(Boolean)
      setMessage({ scope, text: notices.join(' ') })
    } catch {
      if (!operation.signal.aborted && usableScope(scope)) {
        setMessage({
          scope,
          text: '保存した旅程を確認できませんでした。時間をおいて再度お試しください。',
        })
      }
    } finally {
      if (active.current === operation) active.current = null
      operation.dispose()
    }
  }

  const visible = loaded && usableScope(loaded.scope) ? loaded : null
  const visibleMessage = message && usableScope(message.scope) ? message.text : ''

  return (
    <section className="space-y-2">
      <button
        className="min-h-11 w-full rounded-md border px-4 py-2 text-left"
        type="button"
        onClick={() => void open()}
        disabled={!scope || Boolean(active.current)}
      >
        保存した旅程で旅行を続ける
      </button>
      <p className="text-sm" role="status" aria-live="polite">
        {visibleMessage}
      </p>
      {visible?.result.trips.map((trip) => (
        <button
          className="block min-h-11 w-full rounded-md border px-4 py-2 text-left"
          type="button"
          key={trip.id}
          onClick={() => {
            if (!usableScope(visible.scope)) return
            setLoaded(null)
            setMessage(null)
            onChoose(trip)
          }}
        >
          {trip.region}・{trip.date}
        </button>
      ))}
    </section>
  )
}
