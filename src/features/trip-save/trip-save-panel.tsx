'use client'

import { useRef, useState } from 'react'

import type { Trip } from '@/domain'
import { sameSavedTrip } from '@/features/onsite-flow/saved-snapshot'
import { ReflectionApiError, saveTrip } from '@/features/reflection-flow/api-client'
import type { SessionScope } from '@/lib/auth/session-scope'

// 旅程の保存の呼び出し。省略時は実際の保存API（本人のBearer＋App Check付き）。
export type SaveTrip = (scope: SessionScope, trip: Trip) => Promise<Trip>

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; trip: Trip }
  | { phase: 'failed'; message: string; unknown: boolean }

const AUTH_MESSAGE = '認証の状態を確認できないため、保存を始めませんでした。旅程はそのままです。'

// 旅程を保存して振り返りに進むための、本人の操作。保存は利用者が押したときだけ行う。
// ボタンは常に押せる。保存中の再押下は無視し、認証を確認できないときは理由を示す。
export function TripSavePanel({
  trip,
  scope,
  save = saveTrip,
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

  const start = async () => {
    if (busy.current || state.phase === 'saved') return
    if (!scope) {
      setState({ phase: 'failed', message: AUTH_MESSAGE, unknown: false })
      return
    }
    busy.current = true
    setState({ phase: 'saving' })
    try {
      const saved = await save(scope, trip)
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
            aria-disabled={saving}
            onClick={() => void start()}
            className="gt-button-primary"
          >
            {saving ? '保存を確認中…' : '本人の操作で旅程を保存する'}
          </button>
          <p role="status" className="text-sm empty:hidden">
            {saving ? '保存しています。結果が出るまで、もう一度押さないでください。' : ''}
          </p>
          {state.phase === 'failed' && (
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
