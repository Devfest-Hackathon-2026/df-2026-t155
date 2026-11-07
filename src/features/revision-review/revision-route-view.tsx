'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { Trip } from '@/domain'
import type { RouteMeta } from '@/features/trip-map/model'
import { ROUTE_LIST_ID, stopButtonId } from '@/features/trip-map/route-map'
import { TripRouteView } from '@/features/trip-map/trip-route-view'

import type { ApplyRevision, GenerateRevisions } from './api-client'
import { RevisionReview } from './revision-review'

interface RevisionRouteViewProps {
  trip: Trip
  meta?: RouteMeta
  mock?: boolean
  generate?: GenerateRevisions
  apply?: ApplyRevision
}

export function RevisionRouteView({
  trip: sourceTrip,
  meta,
  mock,
  generate,
  apply,
}: RevisionRouteViewProps) {
  const [local, setLocal] = useState<{
    source: Trip
    trip: Trip
    meta?: RouteMeta
    appliedStopId?: string
  } | null>(null)
  const current =
    local?.source === sourceTrip ? local : { trip: sourceTrip, meta, appliedStopId: undefined }
  const [session, setSession] = useState<{
    trip: Trip
    stopId: string
    applyUnresolved?: boolean
  } | null>(null)
  const [interruption, setInterruption] = useState<{
    stopId: string
    applyUnresolved?: boolean
  } | null>(null)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [notice, setNotice] = useState<{
    source: Trip
    message: string
    tone: 'neutral' | 'success'
  } | null>(null)
  const updateNotice = useRef<HTMLDivElement>(null)
  const target = session && current.trip.stops.find((stop) => stop.id === session.stopId)
  const hasActiveSession =
    session && target && !target.isFixed && session.trip === current.trip && generate

  if (session && !hasActiveSession) {
    setInterruption({ stopId: session.stopId, applyUnresolved: session.applyUnresolved })
    setSession(null)
  }

  useLayoutEffect(() => {
    if (interruption && document.activeElement === document.body) {
      updateNotice.current?.focus()
    }
  }, [interruption])

  useEffect(() => {
    if (!returnTo) return
    const destination =
      document.getElementById(stopButtonId(returnTo)) ?? document.getElementById(ROUTE_LIST_ID)
    destination?.focus()
    setReturnTo(null)
  }, [returnTo])

  const leave = (message: string, tone: 'neutral' | 'success' = 'neutral') => {
    setNotice(message ? { source: sourceTrip, message, tone } : null)
    setReturnTo(session?.stopId ?? interruption?.stopId ?? null)
    setInterruption(null)
    setSession(null)
  }

  const onApplied = (trip: Trip) => {
    let nextMeta = current.meta
    if (nextMeta && target) {
      const nextStop = trip.stops[trip.stops.findIndex((stop) => stop.id === target.id) + 1]
      // 置換した施設の価格と前後区間の旧データを、新しい旅程に流用しない。
      nextMeta = { ...nextMeta, [target.id]: { kind: nextMeta[target.id]?.kind } }
      if (nextStop)
        nextMeta[nextStop.id] = { ...nextMeta[nextStop.id], segmentFromPrevious: undefined }
    }
    setLocal({ source: sourceTrip, trip, meta: nextMeta, appliedStopId: target?.id })
    leave('承認した候補が旅程に反映されました。', 'success')
  }

  return (
    <div>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm not-empty:mb-2">
        {notice?.source === sourceTrip && (
          <span className="gt-notice gt-enter inline-block" data-tone={notice.tone}>
            {notice.message}
          </span>
        )}
      </p>
      {hasActiveSession && generate ? (
        <div className="space-y-2">
          {mock && (
            <p role="note" className="text-sm">
              架空デモ・候補と照合結果は画面確認用です。
            </p>
          )}
          <RevisionReview
            trip={session.trip}
            target={target}
            meta={current.meta}
            generate={generate}
            apply={apply}
            onApplyUnresolvedChange={(applyUnresolved) => {
              setSession((active) => active && { ...active, applyUnresolved })
            }}
            onCancel={() => {
              if (session.applyUnresolved) {
                setInterruption({ stopId: session.stopId, applyUnresolved: true })
                setSession(null)
              } else {
                leave('部分修正をキャンセルしました。')
              }
            }}
            onApplied={onApplied}
          />
        </div>
      ) : (
        <div className="space-y-2">
          {interruption && (
            <div
              ref={updateNotice}
              role="alert"
              tabIndex={-1}
              className="gt-notice"
              data-tone="error"
            >
              <p>
                {interruption.applyUnresolved
                  ? '適用結果を確認できませんでした。再操作する前に最新の旅程を確認してください。'
                  : '旅程が更新されたため、候補を取り消しました。最新の旅程を表示しています。'}
              </p>
              <button
                className="min-h-11 font-bold underline"
                type="button"
                onClick={() => leave('')}
              >
                比較を閉じる
              </button>
            </div>
          )}
          <TripRouteView
            trip={current.trip}
            meta={current.meta}
            mock={mock}
            appliedStopId={current.appliedStopId}
            onTripChange={(trip) => setLocal({ ...current, source: sourceTrip, trip })}
            onStartRevision={
              generate
                ? (stopId) => {
                    if (current.trip.stops.some((stop) => stop.id === stopId && !stop.isFixed)) {
                      setNotice(null)
                      setInterruption(null)
                      setSession({ trip: current.trip, stopId })
                    }
                  }
                : undefined
            }
          />
        </div>
      )}
    </div>
  )
}
