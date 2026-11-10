'use client'

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { revisionTargetRestriction, type Trip } from '@/domain'
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
import type { LearningSaveUnavailable } from '@/features/trip-save/learning-save-availability'
import { focusRouteStop } from '@/features/trip-map/route-map'
import { TripSavePanel, type SaveTrip } from '@/features/trip-save/trip-save-panel'
import type { FinishTripAction } from '@/features/trip-progress/trip-progress-view'
import { getProtectedApiHeadersForScope } from '@/lib/auth/protected-api'
import {
  beginSessionScopeOperation,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'
import type { JourneyScreen, PositionJourneyScreen } from './use-journey-history'

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
  learningSaveProof?: string
  placeSaveProof?: string
  learningSaveUnavailable?: LearningSaveUnavailable
  initialSavedTrip?: Trip
  learningSummary?: ReactNode
  verificationPanel: ReactNode
  visible: boolean
  screen: JourneyScreen
  entryId?: number
  positionScreen: PositionJourneyScreen
  onNavigate: (screen: JourneyScreen, back?: boolean) => void
  onCloseReflection: () => void
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
  learningSaveProof,
  placeSaveProof,
  learningSaveUnavailable,
  initialSavedTrip,
  learningSummary,
  verificationPanel,
  visible,
  screen,
  entryId,
  positionScreen,
  onNavigate,
  onCloseReflection,
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
  // 旅行前と旅行中の比較画面を保持していても、同じ旅程の適用要求は一つずつ扱う。
  const applying = useRef(false)
  const [applyInFlight, setApplyInFlight] = useState(false)
  const apply = useMemo<ApplyRevision | undefined>(() => {
    const run = applyRevision ?? persistence?.apply
    if (!run || !scope) return undefined
    return async (decision, signal) => {
      if (applying.current) {
        return {
          status: 'failed',
          message: '別の変更の適用を確認中です。確認後に操作してください。',
        }
      }
      let operation: ReturnType<typeof beginSessionScopeOperation>
      try {
        signal?.throwIfAborted()
        operation = beginSessionScopeOperation(scope, signal)
      } catch {
        return { status: 'failed', message: '認証を確認できないため、適用を開始しませんでした。' }
      }
      applying.current = true
      setApplyInFlight(true)
      try {
        const result = await run(decision, operation.signal)
        operation.assertCurrent('unknown')
        operation.signal.throwIfAborted()
        return result
      } finally {
        operation.dispose()
        applying.current = false
        setApplyInFlight(false)
      }
    }
  }, [applyRevision, persistence?.apply, scope])
  const reflectionOpen = screen === 'reflection' || screen === 'check-saved'
  const [reflectionView, setReflectionView] = useState<'reflection' | 'check-saved' | null>(null)
  if (visible && reflectionOpen && reflectionView !== screen) {
    setReflectionView(screen)
  }
  const heading = useRef<HTMLHeadingElement>(null)
  const savePanel = useRef<HTMLElement>(null)
  const focusSaveResult = useRef(false)
  useLayoutEffect(() => {
    if (focusSaveResult.current) savePanel.current?.focus()
    focusSaveResult.current = false
  }, [savedTrip])
  const reflectionOrigin = useRef<
    Partial<Record<'before' | 'during', { control: HTMLButtonElement; top: number }>>
  >({})
  const previousScreen = useRef<JourneyScreen | null>(null)

  useLayoutEffect(() => {
    const previous = previousScreen.current
    previousScreen.current = visible ? screen : null
    if (!visible) return
    if ((previous === 'reflection' || previous === 'check-saved') && !reflectionOpen) {
      const origin = reflectionOrigin.current[screen]
      if (origin?.control.isConnected && !origin.control.closest('[hidden]')) {
        origin.control.focus({ preventScroll: true })
        return positionScreen(origin.top)
      }
    }
    heading.current?.focus({ preventScroll: true })
    return positionScreen()
  }, [entryId, positionScreen, reflectionOpen, screen, visible])

  const openReflection = (
    control: HTMLButtonElement,
    destination: 'reflection' | 'check-saved' = 'reflection',
  ) => {
    if (reflectionOpen) return
    reflectionOrigin.current[screen] = { control, top: window.scrollY }
    onNavigate(destination)
  }

  // 候補生成の処理は、認証確認中に現在の別UIDのBearerへフォールバックしない。
  const revisions = useMemo(() => {
    const generate = createScopedRevisions(scope, generateRevisions)
    return ((request, signal) => {
      if (applying.current || readUnresolvedApply(scope?.uid, request.trip.id).status !== 'clear') {
        return Promise.resolve({ status: 'unavailable' as const })
      }
      return generate(request, signal)
    }) satisfies GenerateRevisions
  }, [generateRevisions, scope])

  const reflectionUnavailable = !savedTrip
    ? '振り返りには旅程の保存が必要です。「旅行前の旅程へ戻る」から保存してください。'
    : !isSavedCurrent
      ? '現在の旅程は保存時点と異なります。「保存済みの旅程へ戻す」を選ぶと振り返れます。'
      : !scope
        ? '認証の状態を確認できません。認証の確認が済んでから操作してください。'
        : null
  const finishAction: FinishTripAction = reflectionUnavailable
    ? { unavailableReason: reflectionUnavailable }
    : { onFinish: (event) => openReflection(event.currentTarget) }
  const showReflectionView =
    screen === reflectionView && (screen === 'check-saved' || !reflectionUnavailable)

  const firstEditableStop = trip.stops.find((stop) => revisionTargetRestriction(stop) === null)
  const editTripInputs = (
    <button type="button" className="gt-button-secondary" onClick={onEditInput}>
      旅行条件・保存済みの旅程
    </button>
  )

  return (
    <div className="gt-journey flex flex-col gap-4">
      {!reflectionOpen && (
        <div className="gt-journey-chrome flex flex-wrap items-center gap-x-3">
          <span id="journey-mode-label" className="text-sm font-semibold">
            旅程の表示
          </span>
          <div
            role="group"
            aria-labelledby="journey-mode-label"
            className="gt-mode-switch relative flex shrink-0 items-center px-1"
          >
            {(['before', 'during'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={screen === value}
                className="group min-h-11 rounded-full text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
                onClick={() => onNavigate(value)}
              >
                <span className="block rounded-full px-2.5 py-1 text-gt-ink group-aria-pressed:bg-gt-ink group-aria-pressed:text-white">
                  {value === 'before' ? '旅行前' : '旅行中'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="gt-journey-title">
        <h1 ref={heading} tabIndex={-1} className={reflectionOpen ? 'gt-screen-title' : 'sr-only'}>
          {reflectionOpen
            ? '振り返り'
            : screen === 'during'
              ? '旅行中'
              : savedTrip
                ? '旅程'
                : '旅程の提案'}
        </h1>
        {!reflectionOpen && (
          <>
            <p className="gt-screen-title">{trip.region}の旅程</p>
            {screen === 'before' && (
              <p className="mt-1 text-xs text-gt-muted">
                <time dateTime={trip.date}>{trip.date}</time> ・ {trip.stops.length}つの予定
                {' ・ '}
                {savedTrip ? (isSavedCurrent ? '保存済み' : '保存後の変更あり') : 'AIの旅程提案'}
              </p>
            )}
          </>
        )}
      </div>

      {reflectionOpen && (
        <div>
          <button type="button" className="gt-button-secondary" onClick={onCloseReflection}>
            旅程へ戻る
          </button>
        </div>
      )}

      <div hidden={screen !== 'before'} className="space-y-4">
        {!savedTrip && (
          <div className="gt-journey-chrome gt-card space-y-2 text-sm">
            <p>旅程を保存すると、予定の部分修正や現地での再計画ができます。</p>
            <button
              type="button"
              className="gt-button-secondary"
              onClick={() => savePanel.current?.focus()}
            >
              旅程の保存へ
            </button>
          </div>
        )}
        <RevisionRouteView
          trip={routeTrip ?? trip}
          active={visible && screen === 'before'}
          ownerUid={scope?.uid}
          generate={isSavedCurrent ? revisions : undefined}
          apply={isSavedCurrent ? apply : undefined}
          applyInFlight={applyInFlight}
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
          routeActions={(revisionBlocked) => (
            <>
              {verificationPanel}
              {learningSummary}
              <TripSavePanel
                key={`${trip.id}:${savedTrip?.version ?? 'new'}`}
                initialSavedTrip={savedTrip ?? undefined}
                trip={trip}
                scope={scope}
                save={saveTrip}
                learningSaveProof={learningSaveProof}
                learningSaveUnavailable={learningSaveUnavailable}
                placeSaveProof={placeSaveProof}
                onEditInput={onEditInput}
                panelRef={savePanel}
                onSaved={(saved) => {
                  const panel = savePanel.current
                  focusSaveResult.current = Boolean(
                    panel?.contains(document.activeElement) && !panel.closest('[hidden]'),
                  )
                  setSavedTrip(saved)
                }}
                onRestore={
                  savedTrip && !isSavedCurrent ? () => adoptTripChange(savedTrip) : undefined
                }
                savedActions={
                  isSavedCurrent && scope ? (
                    <div className="space-y-2 text-sm">
                      {firstEditableStop && !revisionBlocked && (
                        <p>予定を開くと、変更できる予定には「この予定だけ変更」が表示されます。</p>
                      )}
                      <p>
                        出発したら、旅行中の画面で今の予定を確認できます。
                        {firstEditableStop &&
                          !revisionBlocked &&
                          '現地で予定が変わったら、再計画できます。'}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {firstEditableStop && !revisionBlocked && (
                          <button
                            type="button"
                            className="gt-button-secondary"
                            onClick={() => focusRouteStop(firstEditableStop.id)}
                          >
                            変更する予定を探す
                          </button>
                        )}
                        <button
                          type="button"
                          className="gt-button-primary"
                          onClick={() => onNavigate('during')}
                        >
                          旅行中の画面へ
                        </button>
                      </div>
                    </div>
                  ) : undefined
                }
                onCheckSaved={(control) => openReflection(control, 'check-saved')}
              />
              {initialSavedTrip && !reflectionUnavailable && (
                <button
                  type="button"
                  className="gt-button-secondary"
                  onClick={(event) => openReflection(event.currentTarget)}
                >
                  保存した旅行を振り返る
                </button>
              )}
              {editTripInputs}
            </>
          )}
        />
      </div>

      <section
        hidden={screen !== 'during'}
        aria-label="旅行中の旅程と現地報告"
        className="space-y-3"
      >
        {!isSavedCurrent && (
          <div role="note" className="gt-journey-chrome gt-card space-y-2 text-sm">
            <p>
              {savedTrip
                ? '現地で再計画するには、保存済みの旅程へ戻してください。'
                : '現地で再計画するには、旅行前の画面で旅程を保存してください。'}
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
                onClick={() => onNavigate('before', true)}
              >
                旅行前の旅程へ戻る
              </button>
            )}
          </div>
        )}
        <OnSiteReplanningFlow
          trip={trip}
          active={visible && screen === 'during'}
          generate={isSavedCurrent ? revisions : undefined}
          generationUnavailableReason="保存済みの現在の旅程を確認してから再計画を始めてください。"
          apply={isSavedCurrent ? apply : undefined}
          applyInFlight={applyInFlight}
          ownerUid={scope?.uid}
          reportControl={persistence?.reportControl}
          finishAction={finishAction}
          progressActions={editTripInputs}
          lockManagedByApply={!applyRevision}
          loadLatestTrip={persistence?.loadLatestTrip}
          loadAppliedRevision={persistence?.loadAppliedRevision}
          onTripChange={(next) => {
            setSavedTrip(next)
            adoptTripChange(next)
          }}
        />
      </section>

      {screen === 'reflection' && reflectionUnavailable && (
        <p role="note" className="gt-notice">
          {reflectionUnavailable}
        </p>
      )}
      {reflectionView && (
        <div hidden={!showReflectionView}>
          <ReflectionFlow
            key={`${reflectionView}:${reflectionView === 'reflection' ? savedTrip?.version : ''}`}
            initialTripId={reflectionView === 'reflection' ? savedTrip?.id : undefined}
            active={visible && showReflectionView}
            embedded
            onLearningsChanged={onLearningsChanged}
          />
        </div>
      )}
    </div>
  )
}
