'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { revisionTargetRestriction, type Revision, type Trip } from '@/domain'
import type { RouteMeta } from '@/features/trip-map/model'
import { reviseButtonId, ROUTE_LIST_ID, stopButtonId } from '@/features/trip-map/route-map'
import { TripRouteView } from '@/features/trip-map/trip-route-view'

import type {
  ApplyManualRevision,
  ApplyRevision,
  RevisionApplyReceipt,
  GenerateRevisions,
} from './api-client'
import { ManualApplyRecoveryActions } from './manual-apply-recovery-actions'
import { RevisionReview } from './revision-review'
import {
  clearApplyUnresolved,
  isManualApply,
  judgeLatestTrip,
  markApplyUnresolved,
  readUnresolvedApply,
  subscribeApplyLock,
  type ManualRecoveryAction,
  type RecoverManualApply,
  type RecoveryVerdict,
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
  applyManual?: ApplyManualRevision
  simulateApproval?: (trip: Trip, revision: Revision) => Trip | null
  applyInFlight?: boolean
  lockManagedByApply?: boolean
  // 適用結果不明からの復旧には、最新の旅程と対象Revisionの承認記録の両方が必要。
  loadLatestTrip?: LoadLatestTrip
  loadAppliedRevision?: LoadAppliedRevision
  recoverManualApply?: RecoverManualApply
  // 固定の切り替え・候補の適用で旅程が変わったとき、画面に採用する旅程を決める（変えなければ受け取った旅程を返す）。
  // 照合結果の取り下げなど、旅程の変更に連動して根拠を戻す用途。予定の名称・時刻・固定は変えないこと。
  adoptTripChange?: (changed: Trip) => Trip
  onRevisionApplied?: (saved: Trip) => void
  revisionUnavailableReason?: string
  routeActions?: (revisionBlocked: boolean) => ReactNode
  active?: boolean
}

export function RevisionRouteView({
  trip: sourceTrip,
  ownerUid,
  meta,
  mock,
  generate,
  apply,
  applyManual,
  simulateApproval,
  applyInFlight = false,
  lockManagedByApply,
  loadLatestTrip,
  loadAppliedRevision,
  recoverManualApply,
  adoptTripChange,
  onRevisionApplied,
  revisionUnavailableReason,
  routeActions,
  active = true,
}: RevisionRouteViewProps) {
  const demoApproval = mock && !apply && !applyManual ? simulateApproval : undefined
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
    fromShortcut?: boolean
    applyUnresolved?: boolean
    detached?: boolean
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
  const operationBlocked =
    applyInFlight ||
    lockState.status === 'pending' ||
    (Boolean(apply || applyManual) && lockState.status !== 'clear')

  const updateStoredLock = useCallback(
    () => setRestored({ key: lockKey, state: readUnresolvedApply(ownerUid, sourceTrip.id) }),
    [lockKey, ownerUid, sourceTrip.id],
  )

  useEffect(() => {
    if (active) updateStoredLock()
    if (ownerUid) return subscribeApplyLock(ownerUid, sourceTrip.id, updateStoredLock)
  }, [active, ownerUid, sourceTrip.id, updateStoredLock])

  const [reconcile, setReconcile] = useState<{
    status: 'checking' | 'failed'
  } | null>(null)
  const reconciling = useRef(false)
  const reconcileAbort = useRef<AbortController | null>(null)
  const [interruption, setInterruption] = useState<{
    stopId: string
    applyUnresolved?: boolean
  } | null>(null)
  const [returnTo, setReturnTo] = useState<{ stopId: string; fromShortcut?: boolean } | null>(null)
  const [notice, setNotice] = useState<{
    source: Trip
    message: string
    tone: 'neutral' | 'success'
  } | null>(null)
  const updateNotice = useRef<HTMLDivElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const reviewArea = useRef<HTMLDivElement>(null)
  const target = session && current.trip.stops.find((stop) => stop.id === session.stopId)
  const hasActiveSession =
    session &&
    target &&
    revisionTargetRestriction(target) === null &&
    session.trip === current.trip &&
    generate
  const showReview = hasActiveSession && !session.detached
  const waitingForApply = applyInFlight || Boolean(hasActiveSession && session.detached)

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
    if (active && interruption && document.activeElement === document.body) {
      updateNotice.current?.focus()
    }
  }, [active, interruption])

  useEffect(() => {
    if (!active || !returnTo) return
    const destination =
      (returnTo.fromShortcut ? document.getElementById(reviseButtonId(returnTo.stopId)) : null) ??
      document.getElementById(stopButtonId(returnTo.stopId)) ??
      document.getElementById(ROUTE_LIST_ID)
    destination?.focus()
    setReturnTo(null)
  }, [active, returnTo])

  const leave = (message: string, tone: 'neutral' | 'success' = 'neutral') => {
    setNotice(message ? { source: sourceTrip, message, tone } : null)
    if (!reviewArea.current?.hidden) setReturnTo(session ?? interruption)
    setInterruption(null)
    setSession(null)
  }

  const onApplied = (changed: Trip, receipt?: RevisionApplyReceipt, revisionId?: string) => {
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
    onRevisionApplied?.(changed)
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
    showChangedTrip(
      trip,
      receipt && 'method' in receipt.revision
        ? '本人の確認を記録し、候補を旅程に反映しました。'
        : '承認した候補が旅程に反映されました。',
    )
  }

  const showChangedTrip = (trip: Trip, message: string) => {
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
    leave(message, 'success')
  }

  // 結果不明のとき、サーバーの最新の旅程と照合して解禁するか判断する。取得に失敗しても解禁しない。
  const checkLatestTrip = async (action?: ManualRecoveryAction) => {
    const read = readUnresolvedApply(ownerUid, sourceTrip.id)
    if (
      waitingForApply ||
      (action ? !recoverManualApply : !loadLatestTrip || !loadAppliedRevision) ||
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
    let verdict: RecoveryVerdict = { kind: 'unverified' }
    try {
      if (action && recoverManualApply && isManualApply(pending)) {
        verdict = await recoverManualApply(sourceTrip.id, pending, action, abort.signal)
      } else if (!action && loadLatestTrip && loadAppliedRevision) {
        const latest = await loadLatestTrip(sourceTrip.id, abort.signal)
        const revision = await loadAppliedRevision(sourceTrip.id, pending.revisionId, abort.signal)
        verdict = judgeLatestTrip(
          sourceTrip.id,
          pending.baseVersion,
          pending.revisionId,
          latest,
          revision,
        )
      }
    } catch {
      // 通信や取得に失敗した場合はロックを維持する。
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
    // サーバーで適用済みか未適用を確定できた場合だけ、取得した旅程を採用する。
    setLocal({ source: sourceTrip, trip: adoptTripChange?.(verdict.trip) ?? verdict.trip })
    onRevisionApplied?.(verdict.trip)
    if (verdict.kind === 'not_applied') {
      leave('変更は適用されていません。最新の旅程から再操作できます。')
    } else {
      leave('サーバーで適用を確認し、最新の旅程を表示しています。', 'success')
    }
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
      {ownerUid &&
        recoverManualApply &&
        lockState.status === 'pending' &&
        isManualApply(lockState.value) && (
          <ManualApplyRecoveryActions
            ownerUid={ownerUid}
            tripId={sourceTrip.id}
            pending={lockState.value}
            busy={reconcile?.status === 'checking'}
            onRecover={(action) => void checkLatestTrip(action)}
          />
        )}
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
      {hasActiveSession && generate && (
        <div ref={reviewArea} hidden={!showReview} className="space-y-2">
          {mock && (
            <p role="note" className="text-sm">
              架空デモ・候補と照合結果は画面確認用です。
            </p>
          )}
          <RevisionReview
            trip={session.trip}
            active={active && Boolean(showReview)}
            target={target}
            meta={current.meta}
            generate={generate}
            apply={operationBlocked && !session.applyUnresolved ? undefined : apply}
            applyManual={operationBlocked && !session.applyUnresolved ? undefined : applyManual}
            onDemoApprove={
              demoApproval
                ? (revision) => {
                    const trip = demoApproval(session.trip, revision)
                    if (trip) {
                      showChangedTrip(
                        trip,
                        'デモで承認した候補を、この画面の架空旅程に反映しました。',
                      )
                    } else {
                      leave('デモの候補を反映できませんでした。元の旅程を表示しています。')
                    }
                  }
                : undefined
            }
            applyUnresolved={operationBlocked && !session.applyUnresolved}
            onApplyUnresolvedChange={(unresolved, revisionId) => {
              if (!ownerUid || !revisionId) throw new Error('認証状態を確認できません。')
              try {
                if (unresolved && !lockManagedByApply) {
                  markApplyUnresolved(ownerUid, session.trip.id, session.trip.version, revisionId)
                } else if (!unresolved && !lockManagedByApply) {
                  clearApplyUnresolved(ownerUid, session.trip.id, revisionId)
                }
              } finally {
                updateStoredLock()
              }
              setSession((active) => active && { ...active, applyUnresolved: unresolved })
            }}
            onCancel={() => {
              updateStoredLock()
              if (operationBlocked || session.applyUnresolved) {
                setInterruption({ stopId: session.stopId, applyUnresolved: true })
                setSession(null)
              } else {
                leave('部分修正をキャンセルしました。')
              }
            }}
            onLeaveWhileApplying={() => {
              setSession((current) => current && { ...current, detached: true })
              setReturnTo(session)
            }}
            onApplyFailureAfterLeave={(message) => {
              setSession(null)
              if (message) setNotice({ source: sourceTrip, message, tone: 'neutral' })
            }}
            onApplied={onApplied}
          />
        </div>
      )}
      {!showReview && (
        <div className="space-y-2">
          {waitingForApply && (
            <p role="status" className="gt-notice">
              適用結果を確認中です。確認が終わるまで、この旅程の部分修正はできません。
            </p>
          )}
          {interruption && !waitingForApply && (
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
          {operationBlocked && !interruption && !waitingForApply && (
            <div role="alert" className="gt-notice" data-tone="error">
              {unresolvedGuide}
            </div>
          )}
          {routeActions && (
            <button
              type="button"
              className="min-h-11 text-sm font-semibold text-gt-line-strong underline underline-offset-4"
              onClick={() => actions.current?.focus()}
            >
              根拠・保存の操作へ
            </button>
          )}
          <TripRouteView
            active={active}
            trip={current.trip}
            meta={current.meta}
            mock={mock}
            appliedStopId={appliedStopId}
            revisionUnavailableReason={
              operationBlocked
                ? '先に適用結果を確認してください。旅程の画面から確認できます。'
                : revisionUnavailableReason
            }
            onTripChange={(changed) => {
              const trip = adoptTripChange?.(changed) ?? changed
              setLocal({ ...current, source: sourceTrip, trip })
              return trip
            }}
            onStartRevision={
              generate && !operationBlocked && !waitingForApply
                ? (stopId, fromShortcut) => {
                    if (apply && readUnresolvedApply(ownerUid, sourceTrip.id).status !== 'clear') {
                      updateStoredLock()
                      return
                    }
                    if (
                      current.trip.stops.some(
                        (stop) => stop.id === stopId && revisionTargetRestriction(stop) === null,
                      )
                    ) {
                      setNotice(null)
                      setInterruption(null)
                      setSession({ trip: current.trip, stopId, fromShortcut })
                    }
                  }
                : undefined
            }
          />
        </div>
      )}
      {routeActions && (
        <div
          ref={actions}
          tabIndex={-1}
          role="region"
          aria-label="旅程の確認と保存"
          hidden={Boolean(showReview)}
          className="mt-4 space-y-4 scroll-mt-4 outline-none"
        >
          {routeActions(operationBlocked || waitingForApply)}
        </div>
      )}
    </div>
  )
}
