'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovedLearning, Trip } from '@/domain'

import { LearningApplicationSummary } from '@/features/learning-reuse/learning-application-summary'
import type {
  LearningReuseSelection,
  LoadLearningOptions,
} from '@/features/learning-reuse/learning-reuse-picker'
import type { ApplyRevision, GenerateRevisions } from '@/features/revision-review/api-client'
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
    seq: number
    trip: Trip
    learnings: readonly ApprovedLearning[]
  } | null>(null)
  const [showInput, setShowInput] = useState(true)
  const changed =
    auth.scopeEpoch !== view.epoch ||
    (authScope !== null && view.scope !== null && authScope.uid !== view.scope.uid)
  let session = view
  if (changed) {
    session = { epoch: auth.scopeEpoch, scope: authScope, discard: view.discard + 1 }
    setView(session)
    setGeneration(null)
    setShowInput(true)
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
  const [chosen, setChosen] = useState<{ trip: Trip; discard: number } | null>(null)
  const selected = chosen?.discard === session.discard ? chosen.trip : null

  const run = generate ?? requestTripGeneration
  const generateWithSelection = useCallback<GenerateTrip>(
    async (request, options) => {
      // 選択は、ここで取り出した値をそのまま渡す。送信の直前に、クライアント側で現在のセッションと照合される。
      const selection = selectionRef.current
      const result = await run(request, { ...options, learningSelection: selection })
      if (options?.signal?.aborted) return result
      if (result.ok) {
        setChosen(null)
        setChooserSeq((count) => count + 1)
        setShowInput(false)
        setGeneration((previous) => ({
          seq: (previous?.seq ?? 0) + 1,
          trip: result.trip,
          learnings: selection?.learnings ?? [],
        }))
      } else if (result.failure.kind === 'selection_changed') {
        // 選んだ学びが変わっていた：最新の一覧を読み込み直して、選び直してもらう。
        setPickerKey((count) => count + 1)
      }
      return result
    },
    [run],
  )

  const trip = selected ?? generation?.trip
  const inputHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (showInput && trip) inputHeading.current?.focus()
  }, [showInput, trip])

  return (
    <>
      <div hidden={!showInput} className="space-y-4">
        <h1 ref={inputHeading} tabIndex={-1} className="gt-screen-title">
          日帰り旅程を作る
        </h1>
        {trip && (
          <button type="button" className="gt-button-secondary" onClick={() => setShowInput(false)}>
            旅程へ戻る
          </button>
        )}
        <SavedTripChooser
          key={`${session.discard}:${chooserSeq}`}
          scope={authScope}
          onChoose={(trip) => {
            setChoiceSeq((count) => count + 1)
            setChosen({ trip, discard: session.discard })
            setGeneration(null)
            setShowInput(false)
          }}
        />
        <TripPlanner
          generate={generateWithSelection}
          discardKey={`${session.discard}:${choiceSeq}`}
          renderTrip={null}
          renderLearningPicker={(region) => (
            <HomeLearningPicker
              key={pickerKey}
              region={region}
              session={auth}
              load={loadLearnings}
              delayMs={learningPickerDelayMs}
              onSelectionChange={onSelectionChange}
            />
          )}
        />
      </div>
      {trip && (
        <div hidden={showInput}>
          <VerifiableTrip
            key={
              selected ? `saved:${trip.id}:${choiceSeq}` : `generated:${trip.id}:${generation?.seq}`
            }
            trip={trip}
            verify={verify ?? verifyTripWithProtectedApi}
            renderContent={({
              trip: current,
              adoptExternalChange,
              routeTrip,
              adoptRouteChange,
              verificationPanel,
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
                initialSavedTrip={selected ?? undefined}
                verificationPanel={verificationPanel}
                learningSummary={
                  generation?.trip === trip && (
                    <LearningApplicationSummary trip={trip} learnings={generation.learnings} />
                  )
                }
                visible={!showInput}
                onEditInput={() => setShowInput(true)}
                onLearningsChanged={() => setPickerKey((count) => count + 1)}
              />
            )}
          />
        </div>
      )}
    </>
  )
}
