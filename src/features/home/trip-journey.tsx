'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { Trip } from '@/domain'
import { OnSiteReplanningFlow } from '@/features/onsite-flow/onsite-replanning-flow'
import {
  scopedOnSiteApply,
  scopedRecovery,
  scopedReportControl,
} from '@/features/onsite-flow/onsite-persistence'
import { sameSavedTrip } from '@/features/onsite-flow/saved-snapshot'
import { ReflectionFlow } from '@/features/reflection-flow/reflection-flow'
import { RevisionRouteView } from '@/features/revision-review/revision-route-view'
import { readUnresolvedApply } from '@/features/revision-review/unresolved-apply'
import {
  requestRevisions,
  type ApplyRevision,
  type GenerateRevisions,
} from '@/features/revision-review/api-client'
import { TripSavePanel, type SaveTrip } from '@/features/trip-save/trip-save-panel'
import { getProtectedApiHeadersForScope } from '@/lib/auth/protected-api'
import {
  beginSessionScopeOperation,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'

interface TripJourneyProps {
  // いま画面に出している旅程（固定の切り替えや部分修正を反映済み）。
  trip: Trip
  routeTrip?: Trip
  adoptRouteChange?: (changed: Trip) => Trip
  // 旅程が変わったとき、画面へ採用する旅程を決める（前回の照合結果の取り下げを含む）。
  adoptTripChange: (changed: Trip) => Trip
  // この旅程を作った認証セッション。認証を確認できない間は null。
  scope: SessionScope | null
  generateRevisions?: GenerateRevisions
  applyRevision?: ApplyRevision
  saveTrip?: SaveTrip
  initialSavedTrip?: Trip
  learningSummary?: ReactNode
  verificationPanel: ReactNode
  visible: boolean
  onEditInput: () => void
  // 学びを保存したとき。次の旅に使う学びの一覧を読み込み直すために使う。
  onLearningsChanged: () => void
}

// 認証確認中・終了時は、既定の「現在のUID」へフォールバックしない。
// 生成開始、保護ヘッダー取得、送信直前、応答採用前を同じ認証世代に結び付ける。
export function createScopedRevisions(
  scope: SessionScope | null,
  generateRevisions?: GenerateRevisions,
): GenerateRevisions {
  return async (request, signal) => {
    if (!scope) {
      return {
        status: 'auth_required',
        message: '認証の状態を確認できないため、変更候補を取得しませんでした。',
      }
    }
    if (signal.aborted) return { status: 'interrupted' }

    let operation: ReturnType<typeof beginSessionScopeOperation> | undefined
    try {
      const active = beginSessionScopeOperation(scope, signal)
      operation = active
      active.signal.throwIfAborted()

      const result = await (generateRevisions
        ? generateRevisions(request, active.signal)
        : requestRevisions(request, active.signal, {
            getHeaders: () => getProtectedApiHeadersForScope(scope),
            fetchFn: (input, init) => {
              // App CheckやBearer取得を待つ間にUIDが変わっても、旧Tripを送信しない。
              active.assertCurrent()
              active.signal.throwIfAborted()
              return fetch(input, {
                ...init,
                signal: active.signal,
                redirect: 'error',
              })
            },
          }))

      // requestRevisionsは認証エラーを結果として返すため、結果の採用直前にも独立して判定。
      active.assertCurrent('unknown')
      active.signal.throwIfAborted()
      return result
    } catch (error) {
      if (error instanceof SessionChangedError) {
        return {
          status: 'auth_required',
          message: '認証セッションが変わったため、古い変更候補を表示しませんでした。',
        }
      }
      if (signal.aborted || operation?.signal.aborted) return { status: 'interrupted' }
      return { status: 'unavailable' }
    } finally {
      operation?.dispose()
    }
  }
}

// 画面の切り替えで比較・現地報告の入力を保持するため、非表示の画面もマウントしておく。
// 旅程が変わる操作（現地報告からの部分修正）は、必ず adoptTripChange を通す。
// 認証セッションが変わると、親（HomePlanner）がこの部分ごと作り直す（進行中の報告・保存・振り返りは残らない）。
export function TripJourney({
  trip,
  routeTrip,
  adoptRouteChange,
  adoptTripChange,
  scope,
  generateRevisions,
  applyRevision,
  saveTrip,
  initialSavedTrip,
  learningSummary,
  verificationPanel,
  visible,
  onEditInput,
  onLearningsChanged,
}: TripJourneyProps) {
  const [savedTrip, setSavedTrip] = useState<Trip | null>(initialSavedTrip ?? null)
  const isSavedCurrent = savedTrip !== null && sameSavedTrip(trip, savedTrip)
  const persistence = useMemo(
    () =>
      scope
        ? {
            apply: scopedOnSiteApply(scope),
            reportControl: scopedReportControl(scope),
            ...scopedRecovery(scope),
          }
        : null,
    [scope],
  )
  const [mode, setMode] = useState<'before' | 'during'>('before')
  const [reflection, setReflection] = useState<{ open: boolean; tripId?: string } | null>(null)
  const reflectionOpen = reflection?.open === true
  const heading = useRef<HTMLHeadingElement>(null)
  const screen = reflectionOpen ? 'reflection' : mode

  useEffect(() => {
    if (visible) heading.current?.focus()
  }, [screen, visible])

  const openReflection = (tripId?: string) => {
    setReflection({ open: true, tripId })
  }

  // 候補生成の処理は、認証確認中に現在の別UIDのBearerへフォールバックしない。
  const revisions = useMemo(() => {
    const generate = createScopedRevisions(scope, generateRevisions)
    return ((request, signal) => {
      if (readUnresolvedApply(scope?.uid, request.trip.id).status !== 'clear') {
        return Promise.resolve({ status: 'unavailable' as const })
      }
      return generate(request, signal)
    }) satisfies GenerateRevisions
  }, [generateRevisions, scope])

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <button
          type="button"
          className="gt-button-secondary"
          onClick={
            reflectionOpen ? () => setReflection({ ...reflection, open: false }) : onEditInput
          }
        >
          {reflectionOpen ? '旅程へ戻る' : '旅行条件・保存済みの旅程'}
        </button>
        <h1 ref={heading} tabIndex={-1} className="gt-screen-title">
          {reflectionOpen
            ? '振り返り'
            : mode === 'during'
              ? '旅行中'
              : savedTrip
                ? '旅程'
                : '旅程の提案'}
        </h1>
        {!reflectionOpen && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <p className="font-semibold wrap-anywhere">
              {trip.region} <time dateTime={trip.date}>{trip.date}</time>
            </p>
            {savedTrip && (
              <span
                className={
                  isSavedCurrent ? 'font-semibold text-gt-ok' : 'font-semibold text-gt-unk'
                }
              >
                {isSavedCurrent ? '保存済み' : '保存後の変更あり'}
              </span>
            )}
          </div>
        )}
        {!reflectionOpen && (
          <div role="group" aria-label="旅程の表示モード" className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={mode === 'before'}
              className="gt-button-secondary"
              onClick={() => setMode('before')}
            >
              旅行前
            </button>
            <button
              type="button"
              aria-pressed={mode === 'during'}
              className="gt-button-secondary"
              onClick={() => setMode('during')}
            >
              旅行中
            </button>
          </div>
        )}
      </header>

      <div hidden={screen !== 'before'} className="space-y-4">
        <RevisionRouteView
          trip={routeTrip ?? trip}
          ownerUid={scope?.uid}
          generate={isSavedCurrent ? revisions : undefined}
          apply={isSavedCurrent ? (applyRevision ?? persistence?.apply) : undefined}
          lockManagedByApply={!applyRevision}
          loadLatestTrip={persistence?.loadLatestTrip}
          loadAppliedRevision={persistence?.loadAppliedRevision}
          adoptTripChange={adoptRouteChange ?? adoptTripChange}
          onRevisionApplied={setSavedTrip}
          revisionUnavailableReason={
            savedTrip
              ? '画面の旅程が保存時点と異なります。部分修正を始めるには、保存済みの旅程へ戻してください。'
              : '部分修正を始めるには、旅程を保存してください。'
          }
          routeActions={
            <>
              {verificationPanel}
              {learningSummary}
              <TripSavePanel
                key={`${trip.id}:${savedTrip?.version ?? 'new'}`}
                initialSavedTrip={savedTrip ?? undefined}
                trip={trip}
                scope={scope}
                save={saveTrip}
                onSaved={setSavedTrip}
                onRestore={
                  savedTrip && !isSavedCurrent ? () => adoptTripChange(savedTrip) : undefined
                }
                onReflect={savedTrip ? () => openReflection(savedTrip.id) : undefined}
                onCheckSaved={() => openReflection()}
              />
            </>
          }
        />
      </div>

      <section
        hidden={screen !== 'during'}
        aria-label="旅行中の旅程と現地報告"
        className="space-y-3"
      >
        {!isSavedCurrent && (
          <div role="note" className="gt-card space-y-2 text-sm">
            <p>
              現地の候補を作るには、現在の旅程を保存してください。保存後に変更した場合は保存済みの旅程へ戻してください。
            </p>
            {savedTrip ? (
              <button
                className="gt-button-secondary"
                type="button"
                onClick={() => adoptTripChange(savedTrip)}
              >
                保存済みの旅程へ戻す
              </button>
            ) : (
              <button
                className="gt-button-secondary"
                type="button"
                onClick={() => setMode('before')}
              >
                旅行前の旅程へ
              </button>
            )}
          </div>
        )}
        <OnSiteReplanningFlow
          trip={trip}
          generate={isSavedCurrent ? revisions : undefined}
          generationUnavailableReason="保存済みの現在の旅程を確認してから再計画を始めてください。"
          apply={isSavedCurrent ? (applyRevision ?? persistence?.apply) : undefined}
          ownerUid={scope?.uid}
          reportControl={persistence?.reportControl}
          lockManagedByApply={!applyRevision}
          loadLatestTrip={persistence?.loadLatestTrip}
          loadAppliedRevision={persistence?.loadAppliedRevision}
          onTripChange={(next) => {
            setSavedTrip(next)
            adoptTripChange(next)
          }}
        />
      </section>

      {reflection && (
        <div hidden={!reflectionOpen}>
          <ReflectionFlow
            key={`${reflection.tripId}:${savedTrip?.version ?? 0}`}
            initialTripId={reflection.tripId}
            embedded
            onLearningsChanged={onLearningsChanged}
          />
        </div>
      )}
    </div>
  )
}
