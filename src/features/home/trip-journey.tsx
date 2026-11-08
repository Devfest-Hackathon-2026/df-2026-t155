'use client'

import { useMemo, useState } from 'react'

import type { Trip } from '@/domain'
import { OnSiteReplanningFlow } from '@/features/onsite-flow/onsite-replanning-flow'
import { ReflectionFlow } from '@/features/reflection-flow/reflection-flow'
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
  // 旅程が変わったとき、画面へ採用する旅程を決める（前回の照合結果の取り下げを含む）。
  adoptTripChange: (changed: Trip) => Trip
  // この旅程を作った認証セッション。認証を確認できない間は null。
  scope: SessionScope | null
  generateRevisions?: GenerateRevisions
  applyRevision?: ApplyRevision
  saveTrip?: SaveTrip
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

// 生成された旅程の下に続く、旅の通し導線：保存 → 現地での報告と部分修正 → 振り返りと学びの保存。
// 旅程が変わる操作（現地報告からの部分修正）は、必ず adoptTripChange を通す。
// 認証セッションが変わると、親（HomePlanner）がこの部分ごと作り直す（進行中の報告・保存・振り返りは残らない）。
export function TripJourney({
  trip,
  adoptTripChange,
  scope,
  generateRevisions,
  applyRevision,
  saveTrip,
  onLearningsChanged,
}: TripJourneyProps) {
  const [savedTripId, setSavedTripId] = useState<string | null>(null)
  // 保存の結果が不明のとき、保存済みの旅行の一覧を開いて確かめる。
  const [reflectionOpen, setReflectionOpen] = useState(false)

  // 候補生成の処理は、認証確認中に現在の別UIDのBearerへフォールバックしない。
  const revisions = useMemo(
    () => createScopedRevisions(scope, generateRevisions),
    [generateRevisions, scope],
  )

  return (
    <div className="space-y-8">
      <TripSavePanel
        trip={trip}
        scope={scope}
        save={saveTrip}
        onSaved={(tripId) => {
          setSavedTripId(tripId)
          setReflectionOpen(true)
        }}
        onCheckSaved={() => setReflectionOpen(true)}
      />

      <section aria-labelledby="onsite-heading" className="space-y-3">
        <h3 id="onsite-heading" className="text-base font-semibold">
          旅行中：現地での報告と、その予定だけの修正
        </h3>
        <p className="text-sm">
          旅行当日に予定が変わったときに、その予定だけを直す候補を比べます。旅程に反映できるのは「実際の報告」だけです。
          「デモ用の模擬報告」は、実際に起きたことではないため、候補の比較までで旅程には適用しません。
        </p>
        <OnSiteReplanningFlow
          trip={trip}
          generate={revisions}
          apply={applyRevision}
          onTripChange={adoptTripChange}
        />
      </section>

      {reflectionOpen && (
        <section aria-labelledby="reflection-heading" className="space-y-3">
          <h3 id="reflection-heading" className="text-base font-semibold">
            旅のあと：振り返りと、次の旅への学び
          </h3>
          <p className="text-sm">
            承認して保存した学びは、次に旅程を作るとき、上の「前の旅の学びを使う」から選べます。
            選んだ学びだけが、次の旅程の作成に使われます。
          </p>
          <ReflectionFlow
            initialTripId={savedTripId ?? undefined}
            embedded
            onLearningsChanged={onLearningsChanged}
          />
        </section>
      )}
    </div>
  )
}
