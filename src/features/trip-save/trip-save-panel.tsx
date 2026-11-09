'use client'

import { useRef, useState } from 'react'

import type { Trip } from '@/domain'
import { sameSavedTrip } from '@/features/onsite-flow/saved-snapshot'
import {
  ReflectionApiError,
  saveTrip,
  type TripSaveProofs,
} from '@/features/reflection-flow/api-client'
import { requiresLearningSaveProof } from '@/server/persistence/contracts'
import type { SessionScope } from '@/lib/auth/session-scope'

import {
  learningSaveAvailability,
  REGENERATE_NOTICE,
  useSaveClock,
  type LearningSaveUnavailable,
} from './learning-save-availability'

// 旅程の保存の呼び出し。省略時は実際の保存API（本人のBearer＋App Check付き）。
export type SaveTrip = (scope: SessionScope, trip: Trip, options?: TripSaveProofs) => Promise<Trip>

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; trip: Trip }
  | {
      phase: 'failed'
      message: string
      unknown: boolean
      code?: string
      rejectedPlaceProof?: string
    }

const AUTH_MESSAGE = '認証の状態を確認できないため、保存を始めませんでした。旅程はそのままです。'

// 旅程を保存して振り返りに進むための、本人の操作。保存は利用者が押したときだけ行う。
// 証跡に問題があるときは、表示中の旅程を保持して回復方法を案内する。
export function TripSavePanel({
  trip,
  scope,
  save = saveTrip,
  learningSaveProof,
  placeSaveProof,
  learningSaveUnavailable,
  onEditInput,
  onSaved,
  onCheckSaved,
  onReflect,
  onRestore,
  initialSavedTrip,
}: {
  trip: Trip
  // 認証済みのセッション。なければ保存を始めない。
  scope: SessionScope | null
  save?: SaveTrip
  learningSaveProof?: string
  placeSaveProof?: string
  learningSaveUnavailable?: LearningSaveUnavailable
  onEditInput?: () => void
  onSaved: (saved: Trip) => void
  // 結果不明のとき、保存済みの旅行の一覧で確かめる操作。
  onCheckSaved: () => void
  onReflect?: () => void
  onRestore?: () => void
  initialSavedTrip?: Trip
}) {
  const [state, setState] = useState<SaveState>(() =>
    initialSavedTrip ? { phase: 'saved', trip: initialSavedTrip } : { phase: 'idle' },
  )
  // 同じ描画の間の二重押下を止める。
  const busy = useRef(false)
  const now = useSaveClock(learningSaveProof, placeSaveProof)
  const availability = learningSaveAvailability(
    trip,
    now,
    learningSaveProof,
    placeSaveProof,
    learningSaveUnavailable,
  )
  const regenerateAfterRejection =
    state.phase === 'failed' &&
    (state.code === 'learning_changed' ||
      state.code === 'learning_provenance_expired' ||
      state.code === 'learning_provenance_missing' ||
      state.code === 'learning_provenance_invalid')
  const needsPlaceCheck =
    state.phase === 'failed' &&
    state.code === 'learning_place_provenance_invalid' &&
    state.rejectedPlaceProof === placeSaveProof
  const authBlocked = !scope && requiresLearningSaveProof(trip)
  const blocked = Boolean(
    authBlocked ||
    availability.blocked ||
    regenerateAfterRejection ||
    needsPlaceCheck ||
    (state.phase === 'failed' && state.code === 'learning_trip_save_disabled'),
  )
  const regenerate = availability.regenerate || regenerateAfterRejection

  const start = async () => {
    if (
      busy.current ||
      state.phase === 'saved' ||
      blocked ||
      learningSaveAvailability(
        trip,
        Date.now(),
        learningSaveProof,
        placeSaveProof,
        learningSaveUnavailable,
      ).blocked
    )
      return
    if (!scope) {
      setState({ phase: 'failed', message: AUTH_MESSAGE, unknown: false })
      return
    }
    busy.current = true
    setState({ phase: 'saving' })
    try {
      const saved = learningSaveProof
        ? await save(scope, trip, { learningSaveProof, placeSaveProof })
        : await save(scope, trip)
      setState({ phase: 'saved', trip: saved })
      onSaved(saved)
    } catch (error) {
      const known = error instanceof Error ? error.message : ''
      // 送信後に応答を失った・読めないときは、保存されたかもしれない。未保存とは言わない。
      const unknown = error instanceof ReflectionApiError && error.outcome === 'unknown'
      setState({
        phase: 'failed',
        message: known || '保存できませんでした。旅程はそのままです。',
        unknown,
        code: error instanceof ReflectionApiError ? error.code : undefined,
        rejectedPlaceProof: placeSaveProof,
      })
    } finally {
      busy.current = false
    }
  }

  const saving = state.phase === 'saving'

  return (
    <section aria-labelledby="trip-save-heading" className="gt-card space-y-3">
      <h3 id="trip-save-heading" className="text-base font-semibold">
        旅程の保存
      </h3>
      {state.phase === 'saved' ? (
        <div role="status" className="space-y-1 text-sm">
          <p className="font-semibold text-gt-ok">保存を確認しました。</p>
          {!sameSavedTrip(trip, state.trip) && (
            <p role="note">
              保存したあとに、画面の旅程が変わりました。振り返りに使われるのは、保存した時点の旅程です。
            </p>
          )}
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={blocked}
            aria-disabled={saving || blocked}
            onClick={() => void start()}
            className="gt-button-primary"
          >
            {saving ? '保存を確認中…' : '本人の操作で旅程を保存する'}
          </button>
          <p role="status" className="text-sm empty:hidden">
            {saving ? '保存しています。結果が出るまで、もう一度押さないでください。' : ''}
          </p>
          {(authBlocked ||
            availability.blocked ||
            availability.warning ||
            regenerateAfterRejection) && (
            <div role="status" className="gt-notice space-y-2 text-sm" data-tone="warning">
              {authBlocked && <p>{AUTH_MESSAGE}</p>}
              {availability.blocked || availability.warning ? (
                <p>{availability.blocked ?? availability.warning}</p>
              ) : null}
              {regenerate && (
                <>
                  <p>{REGENERATE_NOTICE}</p>
                  {onEditInput && (
                    <button type="button" className="gt-button-secondary" onClick={onEditInput}>
                      旅行条件に戻る
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {state.phase === 'failed' &&
            (!state.code ||
              state.code !== 'learning_place_provenance_invalid' ||
              needsPlaceCheck) && (
              <div role="alert" className="gt-notice space-y-2" data-tone="error">
                <p>{state.message}</p>
                {state.unknown && (
                  <>
                    <p>
                      保存できたかどうか、確認できませんでした。もう一度押す前に、保存済みの旅行に入っているか確かめてください。
                    </p>
                    <button type="button" onClick={onCheckSaved} className="gt-button-secondary">
                      保存済みの旅行を確認する
                    </button>
                  </>
                )}
              </div>
            )}
        </>
      )}
      <details className="text-sm text-gt-muted">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium">
          保存される内容
        </summary>
        <p>
          予定の名前・時刻・場所の識別子を保存します。営業時間や評価は保存しません。予約状況や当日の営業は別途ご確認ください。
        </p>
      </details>
      {onRestore && (
        <button type="button" onClick={onRestore} className="gt-button-secondary">
          保存済みの旅程へ戻す
        </button>
      )}
      {onReflect && (
        <button type="button" onClick={onReflect} className="gt-button-secondary">
          保存した旅行を振り返る
        </button>
      )}
    </section>
  )
}
