'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import type { ApprovedLearning, Trip } from '@/domain'

import { LearningApplicationSummary } from '@/features/learning-reuse/learning-application-summary'
import { ReflectionFlow } from '@/features/reflection-flow/reflection-flow'
import { DiscoveryHome, type DiscoveryMode } from '@/features/discovery/discovery-home'
import type {
  LearningReuseSelection,
  LoadLearningOptions,
} from '@/features/learning-reuse/learning-reuse-picker'
import type { ApplyRevision, GenerateRevisions } from '@/features/revision-review/api-client'
import { MainNavigation, type MainPage } from '@/features/screen-chrome/main-navigation'
import { SHOW_HOME_EVENT } from '@/features/screen-chrome/screen-header'
import { requestTripGeneration } from '@/features/trip-planner/api-client'
import type { TripDraftChanges, TripDraftEdits } from '@/features/trip-planner/form-model'
import { TripPlanner } from '@/features/trip-planner/trip-planner'
import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'
import type { SaveTrip } from '@/features/trip-save/trip-save-panel'
import { verifyTripWithProtectedApi } from '@/features/trip-verification/protected-verify'
import { VerifiableTrip } from '@/features/trip-verification/verifiable-trip'
import type { VerifyTrip } from '@/features/trip-verification/use-trip-verification'
import type { SessionScope } from '@/lib/auth/session-scope'
import { useSessionScope } from '@/lib/auth/use-session-scope'

import { HomeLearningPicker } from './home-learning-picker'
import { TripJourney } from './trip-journey'
import { SavedTripChooser } from './saved-trip-chooser'
import {
  useJourneyHistory,
  type HomeHistoryScreen,
  type JourneyScreen,
} from './use-journey-history'

interface HomePlannerProps {
  // 以下はテスト用の差し替え口。省略時は実際のAPIを呼ぶ（本人のBearer＋App Check付き。取得できなければ送信しない）。
  generate?: GenerateTrip
  verify?: VerifyTrip
  generateRevisions?: GenerateRevisions
  // 部分修正の承認を旅程へ適用する処理。省略時は未接続（承認できない）。
  // 適用はサーバー側で認可・版・制約を再検証する必要があり、その適用APIがまだ無いため。
  applyRevision?: ApplyRevision
  saveTrip?: SaveTrip
  loadLearnings?: LoadLearningOptions
  // 旅行先の入力が落ち着いてから、保存済みの学びを読み込むまでの待ち時間。
  learningPickerDelayMs?: number
  showDiscoveryHome?: boolean
  statusContent?: ReactNode
}

// 認証セッションの見え方。UID・認証世代が変わったら discard を進め、前のセッションの結果を捨てる。
interface SessionView {
  epoch: number
  scope: SessionScope | null
  discard: number
}

function isJourneyScreen(screen: string | undefined): screen is JourneyScreen {
  return (
    screen === 'before' ||
    screen === 'during' ||
    screen === 'reflection' ||
    screen === 'check-saved'
  )
}

function modeForHistoryScreen(screen: HomeHistoryScreen): DiscoveryMode {
  return screen === 'discovery' ? 'home' : screen
}

// トップ画面：旅程の通し導線。
//   入力画面 → 旅程（旅行前・旅行中）→ 振り返りと学びの保存
//   → 承認した学びを、次の生成で選んで使う。
// 旅程は提案であり、保存・適用・学びの承認は、どれも本人が押したときだけ行う。
//
// 認証セッション（UIDまたは認証世代）が変わったときは、生成結果・照合・現地報告の入力・保存・振り返り・
// 学びの選択をすべて捨てる（旅行条件の入力欄だけは、本人が入れたものなので残す）。
export function HomePlanner({
  generate,
  verify,
  generateRevisions,
  applyRevision,
  saveTrip,
  loadLearnings,
  learningPickerDelayMs = 500,
  showDiscoveryHome = false,
  statusContent,
}: HomePlannerProps) {
  const auth = useSessionScope()
  const authScope = auth.status === 'authenticated' ? auth.scope : null

  // セッションが変わったかの判定（描画中の状態調整）。初回の認証確認は「変わった」に数えない。
  const [view, setView] = useState<SessionView>({
    epoch: auth.scopeEpoch,
    scope: authScope,
    discard: 0,
  })
  // 生成結果と、その送信時点で表示していた学びを組にする。再生成時は下の導線も作り直す。
  const [generation, setGeneration] = useState<{
    key: number
    trip: Trip
    learningSaveProof?: string
    learningSaveUnavailable?: 'disabled' | 'signing_unavailable'
    learnings: readonly ApprovedLearning[]
  } | null>(null)
  const nextJourneyKey = useRef(0)
  const { entry, kind, positionScreen, navigate, initialize } = useJourneyHistory()
  const changed =
    auth.scopeEpoch !== view.epoch ||
    (authScope !== null && view.scope !== null && authScope.uid !== view.scope.uid)
  let session = view
  if (changed) {
    session = { epoch: auth.scopeEpoch, scope: authScope, discard: view.discard + 1 }
    setView(session)
    setGeneration(null)
  } else if (authScope !== null && view.scope !== authScope) {
    session = { ...view, scope: authScope }
    setView(session)
  }

  // 利用者が選んだ学び（{ id, version } と、選んだ時点の認証セッション）。生成の送信直前に使う。
  const selectionRef = useRef<LearningReuseSelection | null>(null)
  const onSelectionChange = useCallback((selection: LearningReuseSelection | null) => {
    selectionRef.current = selection
  }, [])
  // 学びの一覧を読み込み直すための札（選び直しが必要になったとき、学びを保存したとき）。
  const [pickerKey, setPickerKey] = useState(0)
  const [homeMode, setHomeMode] = useState<DiscoveryMode>(showDiscoveryHome ? 'home' : 'create')
  const [tripDraft, setTripDraft] = useState<TripDraftChanges>()
  const [detailEdits, setDetailEdits] = useState<TripDraftEdits>()
  const [choiceSeq, setChoiceSeq] = useState(0)
  const [chooserSeq, setChooserSeq] = useState(0)
  const [chosen, setChosen] = useState<{ trip: Trip; discard: number; key: number } | null>(null)
  const selected = chosen?.discard === session.discard ? chosen : null

  const run = generate ?? requestTripGeneration
  const generateWithSelection = useCallback<GenerateTrip>(
    async (request, options) => {
      // 選択は、ここで取り出した値をそのまま渡す。送信の直前に、クライアント側で現在のセッションと照合される。
      const selection = selectionRef.current
      const result = await run(request, { ...options, learningSelection: selection })
      if (options?.signal?.aborted) return result
      if (result.ok) {
        const key = ++nextJourneyKey.current
        if (!navigate({ screen: 'before', journeyKey: key })) return result
        setChosen(null)
        setChooserSeq((count) => count + 1)
        setGeneration({
          key,
          trip: result.trip,
          learningSaveProof: result.learningSaveProof,
          learningSaveUnavailable: result.learningSaveUnavailable,
          learnings: selection?.learnings ?? [],
        })
      } else if (result.failure.kind === 'selection_changed') {
        // 選んだ学びが変わっていた：最新の一覧を読み込み直して、選び直してもらう。
        setPickerKey((count) => count + 1)
      }
      return result
    },
    [navigate, run],
  )

  const journey = selected ?? generation
  const activeView = entry?.view.journeyKey === journey?.key ? entry?.view.screen : undefined
  const journeyScreen = isJourneyScreen(activeView) ? activeView : null
  const journeyVisible = Boolean(journey && journeyScreen)
  const historyHomeMode =
    entry?.view.journeyKey === 0 &&
    entry.view.screen !== 'home' &&
    !isJourneyScreen(entry.view.screen)
      ? modeForHistoryScreen(entry.view.screen)
      : entry && entry.view.journeyKey === journey?.key && entry.view.screen === 'home'
        ? 'home'
        : undefined
  const visibleHomeMode = historyHomeMode ?? homeMode
  const showInput = journeyScreen === null && (!showDiscoveryHome || visibleHomeMode === 'create')
  const activePage = journeyVisible ? 'journey' : showInput ? 'create' : visibleHomeMode
  const entryId = entry?.id
  const lastPage = useRef({ page: activePage, entryId })
  const focusRequested = useRef(false)
  const discoveryHeading = useRef<HTMLHeadingElement>(null)
  const previous =
    entry?.previous?.journeyKey === journey?.key ? entry?.previous?.screen : undefined
  const inputHeading = useRef<HTMLHeadingElement>(null)
  const openHomeMode = useCallback(
    (mode: DiscoveryMode, back = false) => {
      if (showDiscoveryHome) {
        const screen: HomeHistoryScreen = mode === 'home' ? 'discovery' : mode
        navigate({ screen, journeyKey: 0 }, back)
      }
      setHomeMode(mode)
    },
    [navigate, showDiscoveryHome],
  )

  const previousWasDiscovery = entry?.previous?.screen === 'discovery'
  const showHome = useCallback(() => {
    const returningToHome = showDiscoveryHome && showInput
    if (journey && !(returningToHome && previousWasDiscovery)) {
      navigate({ screen: 'home', journeyKey: journey.key }, returningToHome)
      if (showDiscoveryHome) setHomeMode('home')
    } else if (showDiscoveryHome) openHomeMode('home', returningToHome)
    else if (showInput) inputHeading.current?.focus()
  }, [journey, navigate, openHomeMode, previousWasDiscovery, showDiscoveryHome, showInput])

  const createFromDiscovery = useCallback(
    (draft: TripDraftChanges) => {
      if (draft.region !== undefined || draft.preferences !== undefined) setTripDraft(draft)
      openHomeMode('create')
    },
    [openHomeMode],
  )

  const chooseSavedTrip = useCallback(
    (trip: Trip) => {
      const key = ++nextJourneyKey.current
      if (!navigate({ screen: 'before', journeyKey: key })) return
      setChoiceSeq((count) => count + 1)
      setChosen({ trip, discard: session.discard, key })
      setGeneration(null)
    },
    [navigate, session.discard],
  )

  const openMainPage = (page: MainPage, keyboard: boolean) => {
    focusRequested.current = keyboard && activePage !== page
    if (page === 'home') showHome()
    else openHomeMode(page)
  }

  useEffect(() => {
    const onShowHome = (event: Event) => {
      event.preventDefault()
      focusRequested.current =
        activePage !== 'home' && event instanceof CustomEvent && event.detail === true
      showHome()
    }
    window.addEventListener(SHOW_HOME_EVENT, onShowHome)
    return () => window.removeEventListener(SHOW_HOME_EVENT, onShowHome)
  }, [activePage, showHome])
  useEffect(() => {
    if (showDiscoveryHome && !entry) initialize({ screen: 'discovery', journeyKey: 0 })
  }, [entry, initialize, showDiscoveryHome])
  useEffect(() => {
    if (showDiscoveryHome && historyHomeMode) setHomeMode(historyHomeMode)
  }, [historyHomeMode, showDiscoveryHome])
  useLayoutEffect(() => {
    const previousPage = lastPage.current
    lastPage.current = { page: activePage, entryId }
    const fromBrowserHistory = kind === 'browser'
    if (
      previousPage.page === activePage &&
      (!fromBrowserHistory || previousPage.entryId === entryId)
    )
      return

    const requested = focusRequested.current
    focusRequested.current = false
    // 旅程側は振り返りの復帰先も含めて、TripJourneyで位置を決める。
    if (activePage === 'journey') return
    // 履歴の旅程がすでに差し替わっている場合は、代わりに表示する画面の先頭を開く。
    const top = historyHomeMode ? undefined : 0

    if (activePage === 'create') {
      inputHeading.current?.focus({ preventScroll: true })
      return positionScreen(top)
    }
    const focused = document.activeElement
    const leftJourneyWithoutFocus =
      previousPage.page === 'journey' && (focused === document.body || focused?.closest('[hidden]'))
    const heading = discoveryHeading.current
    if (requested || fromBrowserHistory || leftJourneyWithoutFocus) {
      heading?.focus({ preventScroll: true })
    }
    return positionScreen(top, requested ? heading : null)
  }, [activePage, entryId, historyHomeMode, kind, positionScreen])

  return (
    <>
      {statusContent && (
        <div className="mx-auto mb-4 w-full max-w-xl" data-session-status>
          {statusContent}
        </div>
      )}
      {showDiscoveryHome ? (
        <div hidden={journeyVisible}>
          <DiscoveryHome
            mode={visibleHomeMode}
            headingRef={discoveryHeading}
            detailEdits={detailEdits}
            currentTrip={
              journey ? { region: journey.trip.region, date: journey.trip.date } : undefined
            }
            onOpenHome={(keyboard) => openMainPage('home', keyboard)}
            onResumeTrip={() => {
              if (journey) navigate({ screen: 'before', journeyKey: journey.key })
            }}
            onOpenTrips={(keyboard) => openMainPage('bookmarks', keyboard)}
            onCreate={createFromDiscovery}
            bookmarksContent={
              <SavedTripChooser
                key={`${session.discard}:${chooserSeq}:bookmarks`}
                scope={authScope}
                onChoose={chooseSavedTrip}
              />
            }
            recordsContent={
              <ReflectionFlow
                embedded
                active={visibleHomeMode === 'records' && !journeyVisible}
                onLearningsChanged={() => setPickerKey((count) => count + 1)}
              />
            }
            createContent={
              <div hidden={!showInput} className="space-y-4">
                {inputContent()}
              </div>
            }
          />
        </div>
      ) : (
        <div hidden={!showInput} className="space-y-4">
          {inputContent()}
        </div>
      )}
      {showDiscoveryHome && (
        <MainNavigation
          current={!journeyVisible && visibleHomeMode !== 'create' ? visibleHomeMode : undefined}
          onNavigate={openMainPage}
        />
      )}
      {journey && (
        <div hidden={!journeyVisible}>
          <VerifiableTrip
            key={journey.key}
            trip={journey.trip}
            verify={verify ?? verifyTripWithProtectedApi}
            renderContent={renderJourney}
          />
        </div>
      )}
    </>
  )

  function inputContent() {
    return (
      <>
        <h1 ref={inputHeading} tabIndex={-1} className="gt-screen-title">
          日帰り旅程を作る
        </h1>
        {journey && (
          <button
            type="button"
            className="gt-button-secondary"
            onClick={() =>
              navigate(
                {
                  screen: previous && previous !== 'home' ? previous : 'before',
                  journeyKey: journey.key,
                },
                true,
              )
            }
          >
            旅程へ戻る
          </button>
        )}
        <SavedTripChooser
          key={`${session.discard}:${chooserSeq}`}
          scope={authScope}
          onChoose={chooseSavedTrip}
        />
        <TripPlanner
          generate={generateWithSelection}
          active={showInput}
          draft={tripDraft}
          onDraftFieldEdit={
            showDiscoveryHome
              ? (field, value) => setDetailEdits((current) => ({ ...current, [field]: { value } }))
              : undefined
          }
          discardKey={`${session.discard}:${choiceSeq}`}
          renderTrip={null}
          renderLearningPicker={(region) => (
            <HomeLearningPicker
              key={pickerKey}
              region={region}
              active={showInput}
              session={auth}
              load={loadLearnings}
              delayMs={learningPickerDelayMs}
              onSelectionChange={onSelectionChange}
            />
          )}
        />
      </>
    )
  }

  function renderJourney({
    trip: current,
    adoptExternalChange,
    routeTrip,
    adoptRouteChange,
    verificationPanel,
    placeSaveProof,
  }: Parameters<NonNullable<ComponentProps<typeof VerifiableTrip>['renderContent']>>[0]) {
    return (
      <TripJourney
        trip={current}
        routeTrip={routeTrip}
        adoptRouteChange={adoptRouteChange}
        adoptTripChange={adoptExternalChange}
        scope={authScope}
        generateRevisions={generateRevisions}
        applyRevision={applyRevision}
        saveTrip={saveTrip}
        initialSavedTrip={selected?.trip}
        learningSaveProof={selected ? undefined : generation?.learningSaveProof}
        learningSaveUnavailable={selected ? undefined : generation?.learningSaveUnavailable}
        placeSaveProof={placeSaveProof}
        verificationPanel={verificationPanel}
        learningSummary={
          <LearningApplicationSummary
            trip={current}
            learnings={selected ? [] : (generation?.learnings ?? [])}
          />
        }
        visible={journeyVisible}
        screen={journeyScreen ?? 'before'}
        entryId={entryId}
        positionScreen={positionScreen}
        onNavigate={(screen: JourneyScreen, back?: boolean) => {
          if (journey) navigate({ screen, journeyKey: journey.key }, back)
        }}
        onCloseReflection={() => {
          if (!journey) return
          const screen = previous === 'during' ? 'during' : 'before'
          navigate({ screen, journeyKey: journey.key }, true)
        }}
        onEditInput={() => {
          if (showDiscoveryHome) openHomeMode('create')
          else if (journey) {
            setHomeMode('create')
            navigate({ screen: 'home', journeyKey: journey.key })
          }
        }}
        onLearningsChanged={() => setPickerKey((count) => count + 1)}
      />
    )
  }
}
