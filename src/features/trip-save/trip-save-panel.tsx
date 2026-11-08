'use client'

import { useRef, useState } from 'react'

import type { Trip } from '@/domain'
import { ReflectionApiError, saveTrip } from '@/features/reflection-flow/api-client'
import type { SessionScope } from '@/lib/auth/session-scope'

// 旅程の保存の呼び出し。省略時は実際の保存API（本人のBearer＋App Check付き）。
export type SaveTrip = (scope: SessionScope, trip: Trip) => Promise<Trip>

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  // 保存を確認できた。savedFingerprint は保存した時点の旅程（その後の変更に気づくために持つ）。
  | { phase: 'saved'; tripId: string; savedFingerprint: string }
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
}: {
  trip: Trip
  // 認証済みのセッション。なければ保存を始めない。
  scope: SessionScope | null
  save?: SaveTrip
  onSaved: (tripId: string) => void
  // 結果不明のとき、保存済みの旅行の一覧で確かめる操作。
  onCheckSaved: () => void
}) {
  const [state, setState] = useState<SaveState>({ phase: 'idle' })
  // 同じ描画の間の二重押下を止める。
  const busy = useRef(false)
  const fingerprint = JSON.stringify(trip)

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
      setState({ phase: 'saved', tripId: saved.id, savedFingerprint: fingerprint })
      onSaved(saved.id)
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
    <section aria-labelledby="trip-save-heading" className="space-y-3 rounded-xl border p-4">
      <h3 id="trip-save-heading" className="text-base font-semibold">
        この旅程を保存して、旅のあとに振り返る
      </h3>
      <p className="text-sm">
        保存は、あなたが押したときだけ行います。予約や、当日の営業を保証するものではありません。
        Googleの情報（営業時間・評価など）は保存せず、予定の名前・時刻と、場所の識別子（Place
        ID）だけを保存します。
      </p>
      {state.phase === 'saved' ? (
        <div role="status" className="space-y-1 text-sm">
          <p className="font-semibold">保存を確認しました。下の「振り返り」へ進めます。</p>
          {state.savedFingerprint !== fingerprint && (
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
            className="min-h-11 rounded-lg border-2 border-gt-ink px-4 py-2 font-semibold aria-disabled:opacity-60"
          >
            {saving ? '保存を確認中…' : '本人の操作で旅程を保存する'}
          </button>
          <p role="status" className="text-sm empty:hidden">
            {saving ? '保存しています。結果が出るまで、もう一度押さないでください。' : ''}
          </p>
          {state.phase === 'failed' && (
            <div role="alert" className="space-y-2 text-sm">
              <p>{state.message}</p>
              {state.unknown && (
                <>
                  <p>
                    保存できたかどうか、確認できませんでした。もう一度押す前に、保存済みの旅行に入っているか確かめてください。
                  </p>
                  <button
                    type="button"
                    onClick={onCheckSaved}
                    className="min-h-11 rounded-lg border border-gt-rule px-3 py-2 font-semibold"
                  >
                    保存済みの旅行を確認する
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
