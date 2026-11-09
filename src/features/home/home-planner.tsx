'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovedLearning, Trip } from '@/domain'

import { LearningApplicationSummary } from '@/features/learning-reuse/learning-application-summary'
import type {
  LearningReuseSelection,
  LoadLearningOptions,
} from '@/features/learning-reuse/learning-reuse-picker'
import type { ApplyRevision, GenerateRevisions } from '@/features/revision-review/api-client'
import { SHOW_HOME_EVENT } from '@/features/screen-chrome/screen-header'
import { requestTripGeneration } from '@/features/trip-planner/api-client'
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
import { useJourneyHistory, type JourneyScreen } from './use-journey-history'

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
}

// 認証セッションの見え方。UID・認証世代が変わったら discard を進め、前のセッションの結果を捨てる。
interface SessionView {
  epoch: number
  scope: SessionScope | null
  discard: number
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
  const { entry, navigate } = useJourneyHistory()
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
  const trip = journey?.trip
  const activeView = entry?.view.journeyKey === journey?.key ? entry?.view.screen : undefined
  const journeyScreen = activeView && activeView !== 'home' ? activeView : null
  const showInput = journeyScreen === null
  const previous =
    entry?.previous?.journeyKey === journey?.key ? entry?.previous?.screen : undefined
  const inputHeading = useRef<HTMLHeadingElement>(null)
  const showHome = useCallback(() => {
    if (showInput) inputHeading.current?.focus()
    else if (journey) navigate({ screen: 'home', journeyKey: journey.key })
  }, [journey, navigate, showInput])

  useEffect(() => {
    const onShowHome = (event: Event) => {
      event.preventDefault()
      showHome()
    }
    window.addEventListener(SHOW_HOME_EVENT, onShowHome)
    return () => window.removeEventListener(SHOW_HOME_EVENT, onShowHome)
  }, [showHome])
  useEffect(() => {
    if (showInput && trip) inputHeading.current?.focus()
  }, [showInput, trip])

  return (
    <>
      <div hidden={!showInput} className="space-y-4">
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
          onChoose={(trip) => {
            const key = ++nextJourneyKey.current
            if (!navigate({ screen: 'before', journeyKey: key })) return
            setChoiceSeq((count) => count + 1)
            setChosen({ trip, discard: session.discard, key })
            setGeneration(null)
          }}
        />
        <TripPlanner
          generate={generateWithSelection}
          active={showInput}
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
      </div>
      {journey && (
        <div hidden={showInput}>
          <VerifiableTrip
            key={journey.key}
            trip={journey.trip}
            verify={verify ?? verifyTripWithProtectedApi}
            renderContent={({
              trip: current,
              adoptExternalChange,
              routeTrip,
              adoptRouteChange,
              verificationPanel,
              placeSaveProof,
            }) => (
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
                visible={!showInput}
                screen={journeyScreen ?? 'before'}
                onNavigate={(screen: JourneyScreen, back?: boolean) =>
                  navigate({ screen, journeyKey: journey.key }, back)
                }
                onCloseReflection={() => {
                  const screen = previous === 'during' ? 'during' : 'before'
                  navigate({ screen, journeyKey: journey.key }, true)
                }}
                onEditInput={showHome}
                onLearningsChanged={() => setPickerKey((count) => count + 1)}
              />
            )}
          />
        </div>
      )}
    </>
  )
}
