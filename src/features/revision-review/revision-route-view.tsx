'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { Trip } from '@/domain'
import type { RouteMeta } from '@/features/trip-map/model'
import { ROUTE_LIST_ID, stopButtonId } from '@/features/trip-map/route-map'
import { TripRouteView } from '@/features/trip-map/trip-route-view'
import type { ApplyRevisionResult } from '@/server/persistence/contracts'

import type { ApplyRevision, GenerateRevisions } from './api-client'
import { RevisionReview } from './revision-review'
import {
  clearApplyUnresolved,
  judgeLatestTrip,
  markApplyUnresolved,
  readUnresolvedApply,
  unresolvedApplyStorageKey,
  type UnresolvedApplyState,
} from './unresolved-apply'

// サーバーに保存されている最新の旅程（正本）を取得する。取得できないときは null を返すか例外を投げる。
export type LoadLatestTrip = (tripId: string, signal: AbortSignal) => Promise<Trip | null>
// サーバーから対象Revisionの承認状態を取得する。
export type LoadAppliedRevision = (
  tripId: string,
  revisionId: string,
  signal: AbortSignal,
) => Promise<unknown>

const unresolvedMessage =
  '適用結果を確認できませんでした。対象候補の承認記録と最新の旅程を確認できるまで、この旅程は再操作できません。'

interface RevisionRouteViewProps {
  trip: Trip
  // 保存されたTripの所有者。applyを接続する際は、認証済みUIDを必ず渡す。
  // 未指定・認証未確認時は、状態を復元できないため適用を許可しない。
  ownerUid?: string | null
  meta?: RouteMeta
  mock?: boolean
  generate?: GenerateRevisions
  apply?: ApplyRevision
  // 適用結果不明からの復旧には、最新の旅程と対象Revisionの承認記録の両方が必要。
  loadLatestTrip?: LoadLatestTrip
  loadAppliedRevision?: LoadAppliedRevision
  // 固定の切り替え・候補の適用で旅程が変わったとき、画面に採用する旅程を決める（変えなければ受け取った旅程を返す）。
  // 照合結果の取り下げなど、旅程の変更に連動して根拠を戻す用途。予定の名称・時刻・固定は変えないこと。
  adoptTripChange?: (changed: Trip) => Trip
}

export function RevisionRouteView({
  trip: sourceTrip,
  ownerUid,
  meta,
  mock,
  generate,
  apply,
  loadLatestTrip,
  loadAppliedRevision,
  adoptTripChange,
}: RevisionRouteViewProps) {
  const [local, setLocal] = useState<{
    source: Trip
    trip: Trip
    meta?: RouteMeta
    applied?: { stopId: string; placeId: string | null; version: number }
  } | null>(null)
  const current =
    local?.source === sourceTrip ? local : { trip: sourceTrip, meta, applied: undefined }
  const applied = current.applied
  const appliedStopId =
    applied &&
    current.trip.version === applied.version &&
    current.trip.stops.some(
      ({ id, placeId }) => id === applied.stopId && placeId === applied.placeId,
    )
      ? applied.stopId
      : undefined
  const [session, setSession] = useState<{
    trip: Trip
    stopId: string
    applyUnresolved?: boolean
  } | null>(null)
  // 最初の描画では永続ロックの復元が未完了。確認前に操作を開始してはならない。
  // UIDとTripの組が変わった瞬間にも前の組の解除状態を使わない。
  const lockKey = JSON.stringify([ownerUid, sourceTrip.id])
  const [restored, setRestored] = useState<{
    key: string
    state: UnresolvedApplyState
  } | null>(null)
  const lockState: UnresolvedApplyState =
    restored?.key === lockKey ? restored.state : { status: 'unavailable' }
  const operationBlocked = Boolean(apply) && lockState.status !== 'clear'

  const updateStoredLock = useCallback(
    () => setRestored({ key: lockKey, state: readUnresolvedApply(ownerUid, sourceTrip.id) }),
    [lockKey, ownerUid, sourceTrip.id],
  )

  useEffect(() => {
    updateStoredLock()
    // 別タブからの書き込み／解除も、そのタブの表示に反映する。
    const key = ownerUid ? unresolvedApplyStorageKey(ownerUid, sourceTrip.id) : null
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === key || event.key === null)) {
        updateStoredLock()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [lockKey, ownerUid, sourceTrip.id, updateStoredLock])

  const [reconcile, setReconcile] = useState<{
    status: 'checking' | 'failed'
  } | null>(null)
  const reconciling = useRef(false)
  const reconcileAbort = useRef<AbortController | null>(null)
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
    setInterruption({
      stopId: session.stopId,
      applyUnresolved: session.applyUnresolved || operationBlocked,
    })
    setSession(null)
  }

  // 取得中の要求は、画面が外れたら捨てる。
  useEffect(() => () => reconcileAbort.current?.abort(), [lockKey])

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

  const onApplied = (changed: Trip, receipt?: ApplyRevisionResult, revisionId?: string) => {
    // 成功した対象Revisionだけ解除する。永続ストレージが失敗したら閉じたままにする。
    let cleared = false
    try {
      if (!ownerUid || !revisionId) throw new Error('missing apply ownership context')
      clearApplyUnresolved(ownerUid, changed.id, revisionId)
      cleared = true
    } catch {
      setReconcile({ status: 'failed' })
    }
    updateStoredLock()
    const trip = adoptTripChange?.(changed) ?? changed
    if (!cleared) {
      setLocal({ source: sourceTrip, trip })
      leave('適用結果は確認しましたが、端末の再操作禁止を解除できません。', 'neutral')
      return
    }
    if (receipt && trip.version > receipt.appliedTripVersion) {
      setLocal({ source: sourceTrip, trip })
      leave('候補の適用を確認し、その後に更新された最新の旅程を表示しています。', 'success')
      return
    }
    let nextMeta = current.meta
    if (nextMeta && target) {
      const nextStop = trip.stops[trip.stops.findIndex((stop) => stop.id === target.id) + 1]
      // 置換した施設の価格と前後区間の旧データを、新しい旅程に流用しない。
      nextMeta = { ...nextMeta, [target.id]: { kind: nextMeta[target.id]?.kind } }
      if (nextStop)
        nextMeta[nextStop.id] = { ...nextMeta[nextStop.id], segmentFromPrevious: undefined }
    }
    const stop = trip.stops.find(({ id }) => id === target?.id)
    setLocal({
      source: sourceTrip,
      trip,
      meta: nextMeta,
      applied: stop ? { stopId: stop.id, placeId: stop.placeId, version: trip.version } : undefined,
    })
    leave('承認した候補が旅程に反映されました。', 'success')
  }

  // 結果不明のとき、サーバーの最新の旅程と照合して解禁するか判断する。取得に失敗しても解禁しない。
  const checkLatestTrip = async () => {
    const read = readUnresolvedApply(ownerUid, sourceTrip.id)
    if (
      !loadLatestTrip ||
      !loadAppliedRevision ||
      read.status !== 'pending' ||
      reconciling.current
    ) {
      updateStoredLock()
      return
    }
    const pending = read.value
    reconciling.current = true
    const abort = new AbortController()
    reconcileAbort.current = abort
    setReconcile({ status: 'checking' })
    let latest: Trip | null = null
    let revision: unknown = null
    try {
      latest = await loadLatestTrip(sourceTrip.id, abort.signal)
      revision = await loadAppliedRevision(sourceTrip.id, pending.revisionId, abort.signal)
    } catch {
      latest = null
    }
    reconciling.current = false
    if (abort.signal.aborted) return
    const currentLock = readUnresolvedApply(ownerUid, sourceTrip.id)
    if (
      currentLock.status !== 'pending' ||
      currentLock.value.baseVersion !== pending.baseVersion ||
      currentLock.value.revisionId !== pending.revisionId
    ) {
      updateStoredLock()
      return
    }
    const verdict = judgeLatestTrip(
      sourceTrip.id,
      pending.baseVersion,
      pending.revisionId,
      latest,
      revision,
    )
    if (verdict.kind === 'unverified') {
      setReconcile({ status: 'failed' })
      return
    }
    try {
      if (!ownerUid) throw new Error('missing owner')
      clearApplyUnresolved(ownerUid, sourceTrip.id, pending.revisionId)
    } catch {
      updateStoredLock()
      setReconcile({ status: 'failed' })
      return
    }
    updateStoredLock()
    setReconcile(null)
    // 対象Revisionの承認が確定した場合だけ、取得した旅程を採用する。
    setLocal({ source: sourceTrip, trip: adoptTripChange?.(verdict.trip) ?? verdict.trip })
    leave('サーバーで適用を確認し、最新の旅程を表示しています。', 'success')
  }

  const unresolvedGuide = (
    <>
      <p>
        {lockState.status === 'pending'
          ? unresolvedMessage
          : '認証または端末に保存した適用状態を確認できません。確認できるまで、この旅程は再操作できません。'}
      </p>
      {reconcile?.status === 'failed' && (
        <p>
          対象の適用を確定できませんでした。承認記録を確認できるまで、まだ再操作できません。通信を確認して、もう一度お試しください。
        </p>
      )}
      {lockState.status === 'pending' && loadLatestTrip && loadAppliedRevision ? (
        <button
          className="min-h-11 font-bold underline"
          type="button"
          aria-busy={reconcile?.status === 'checking'}
          onClick={() => void checkLatestTrip()}
        >
          {reconcile?.status === 'checking' ? '確認中…' : '最新の旅程を取得して確認する'}
        </button>
      ) : lockState.status === 'pending' ? (
        <p>最新の旅程と対象Revisionの承認記録をサーバーから取得し直してください。</p>
      ) : null}
    </>
  )

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
            apply={operationBlocked && !session.applyUnresolved ? undefined : apply}
            applyUnresolved={operationBlocked && !session.applyUnresolved}
            onApplyUnresolvedChange={(unresolved, revisionId) => {
              if (!ownerUid || !revisionId) throw new Error('認証状態を確認できません。')
              try {
                if (unresolved) {
                  markApplyUnresolved(ownerUid, session.trip.id, session.trip.version, revisionId)
                } else {
                  clearApplyUnresolved(ownerUid, session.trip.id, revisionId)
                }
              } finally {
                updateStoredLock()
              }
              setSession((active) => active && { ...active, applyUnresolved: unresolved })
            }}
            onCancel={() => {
              if (operationBlocked || session.applyUnresolved) {
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
              {operationBlocked ? (
                unresolvedGuide
              ) : (
                <p>旅程が更新されたため、候補を取り消しました。最新の旅程を表示しています。</p>
              )}
              <button
                className="min-h-11 font-bold underline"
                type="button"
                onClick={() => leave('')}
              >
                比較を閉じる
              </button>
            </div>
          )}
          {operationBlocked && !interruption && (
            <div role="alert" className="gt-notice" data-tone="error">
              {unresolvedGuide}
            </div>
          )}
          <TripRouteView
            trip={current.trip}
            meta={current.meta}
            mock={mock}
            appliedStopId={appliedStopId}
            onTripChange={(changed) => {
              const trip = adoptTripChange?.(changed) ?? changed
              setLocal({ ...current, source: sourceTrip, trip })
              return trip
            }}
            onStartRevision={
              generate && !operationBlocked
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
