'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'

import type { ApprovedLearning } from '@/domain'
import { isSameScope, type ScopedValue, type SessionScope } from '@/lib/auth/session-scope'
import type { SessionScopeState } from '@/lib/auth/use-session-scope'
import { normalizeLearningRegion, selectApplicableLearnings } from '@/lib/learnings/lifecycle'
import type { LearningSelection, VersionedLearning } from '@/server/persistence/contracts'

import { loadApprovedLearningOptions, type LearningLoadResult } from './api-client'
import { isSelectableLearningList } from './learning-list'
import type { ScopedLearningSelection } from './selection-scope'

// 読み込みは取得するセッション（scope）と中断用のsignalを受け取る。
// 結果の一覧は、取得したセッションと組（ScopedValue）で返す。
export type LoadLearningOptions = (
  scope: SessionScope,
  signal: AbortSignal,
) => Promise<LearningLoadResult>

// 本文は結果画面で選択時の内容を表示するために保持する。生成APIへは value のID・版だけを送る。
export type LearningReuseSelection = ScopedLearningSelection & {
  learnings: readonly ApprovedLearning[]
}

interface LearningReusePickerProps {
  region: string
  // 親が useSessionScope() で得た認証状態。一覧・選択・進行中の読み込みは、UIDと認証世代に
  // 結び付ける。親が選択を保持するときも、同じ状態を使って古い選択を捨てる。
  session: SessionScopeState
  // 選んだ学びを、画面に表示した版と、選択時の認証セッションの組で通知する。
  // 地域・UID・認証世代が変わった、読み込み中、失敗、アンマウントのときは null（選択なし）を通知する。
  // 送信の直前に resolveSelectionForRequest で現在のセッションと照合してから使う。
  // サーバーは版が現行と一致するときだけ採用する。
  onSelectionChange?: (selection: LearningReuseSelection | null) => void
  // テスト・他の画面での依存性注入に使う。省略時は本人のFirestore保存APIを読む。
  // 読み込みは地域・認証世代・「再読み込み」のときだけ行い、この関数の差し替えでは再実行しない。
  load?: LoadLearningOptions
}

// 表示している一覧と選択が属する条件。どれかが変わったら別の条件として扱い、前の状態を表示しない。
interface ViewKey {
  region: string
  uid: string | null
  epoch: number
}

type LoadedView =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      // 取得したセッションと組で保持する。選択はこのセッションに対するものとして通知する。
      list: ScopedValue<VersionedLearning[]>
      selected: LearningSelection[]
    }

interface PickerState {
  key: ViewKey
  view: LoadedView
}

// 画面に出す状態。認証状態が読み込みを始められないときは、保持している状態を使わない。
type PickerView = LoadedView | { status: 'restoring' } | { status: 'blocked'; message: string }

const sameKey = (a: ViewKey, b: ViewKey) =>
  a.region === b.region && a.uid === b.uid && a.epoch === b.epoch

const defaultLoad: LoadLearningOptions = (scope, signal) =>
  loadApprovedLearningOptions({ scope, signal })

const categoryLabels: Record<ApprovedLearning['category'], string> = {
  verification: '情報の確認について',
  preference: '好み・過ごし方について',
}

const clearedNotice =
  '地域または認証状態が変わったため、選んでいた学びを解除しました。もう一度選んでください。'

// 読み上げ用の常設領域に出す文。領域は常に描画し、中身だけを入れ替える
// （中身と同時に挿入された領域は、読み上げられないことがある）。
function statusMessage(view: PickerView): string {
  if (view.status === 'restoring') return '認証状態を確認しています…'
  if (view.status === 'loading') return '保存済みの学びを確認しています…'
  if (view.status === 'error' || view.status === 'blocked') return ''
  if (view.list.value.length === 0) {
    return '今回の地域に使える、承認済みの学びはありません。学びを使わずに旅程を作れます。'
  }
  return `${view.list.value.length}件の学びから選べます。現在${view.selected.length}件を選択中です。`
}

// このUIは、選んだ学びのID・版と表示した本文を、選択時の認証セッションと組にして返す。
// 画面で受け取った学びの内容・承認状態は次回生成APIの信頼できる入力とはしない
// （サーバーで本人の保存データを再取得し、版を照合する）。
export function LearningReusePicker({
  region,
  session,
  onSelectionChange,
  load = defaultLoad,
}: LearningReusePickerProps) {
  // サーバーと同じ正規化（前後の空白を除く）を、入口で1回だけ行う。
  const normalizedRegion = normalizeLearningRegion(region)
  // useSessionScopeから受け取った世代付きscopeをそのまま使う。
  // UIDだけでscopeを作り直すと、A→B→A後に古いAの選択が復活してしまう。
  const scope = session.status === 'authenticated' ? session.scope : null
  const uid = scope?.uid ?? null
  const epoch = session.scopeEpoch
  const currentKey: ViewKey = { region: normalizedRegion, uid, epoch }

  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PickerState>({ key: currentKey, view: { status: 'loading' } })
  const [notice, setNotice] = useState('')
  const statusRef = useRef<HTMLDivElement>(null)
  // 選択中の件数。条件が変わって選択を捨てたことを、利用者に伝えるために使う。
  const selectedCountRef = useRef(0)
  // 親が毎回新しい関数を渡しても、読み込みの再実行や通知の連鎖を起こさないよう、
  // 最新の関数はrefで持つ。
  const loadRef = useRef(load)
  const changeRef = useRef(onSelectionChange)
  useEffect(() => {
    loadRef.current = load
    changeRef.current = onSelectionChange
  }, [load, onSelectionChange])

  // Pickerが消えるとき、親に残る選択を無効にする（見えない選択が生成に使われない）。
  useEffect(() => {
    const notify = () => changeRef.current?.(null)
    return notify
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const key: ViewKey = { region: normalizedRegion, uid, epoch }
    // 地域・UID・認証世代が変わった、または再読み込みした。前の一覧・選択・進行中の読み込みは使わない。
    setState({ key, view: { status: 'loading' } })
    setNotice(selectedCountRef.current > 0 ? clearedNotice : '')
    selectedCountRef.current = 0
    changeRef.current?.(null)
    // 認証済みでなければ読み込みを始めない。匿名アカウントも作らない。
    if (!scope) return () => controller.abort()
    if (!normalizedRegion) {
      setState({
        key,
        view: { status: 'error', message: '先に旅行先の地域を入力してください。' },
      })
      return () => controller.abort()
    }

    const fail = (message: string) => setState({ key, view: { status: 'error', message } })
    void loadRef.current(scope, controller.signal).then(
      (result) => {
        // 条件が変わった後に届いた応答（古い応答）は採用しない。
        if (controller.signal.aborted) return
        if (!result.ok) return fail(result.message)
        const { scope: loadedScope, value } = result.learnings
        // 読み込みを始めたセッションと違うセッションの一覧は、中身が正しく見えても採用しない。
        if (!isSameScope(loadedScope, scope)) {
          return fail('認証状態が変わりました。学びを読み込み直してください。')
        }
        // 読み込み関数は差し替えられるため、取得時の検証に頼らず、表示の入口でも確かめる。
        if (!isSelectableLearningList(value)) {
          return fail('学びの一覧に未取得または不正な項目があります。')
        }
        const applicable = selectApplicableLearnings(
          value.map(({ learning }) => learning),
          normalizedRegion,
        )
        const ids = new Set(applicable.map(({ id }) => id))
        setState({
          key,
          view: {
            status: 'ready',
            list: {
              scope: loadedScope,
              value: value.filter(({ learning }) => ids.has(learning.id)),
            },
            selected: [],
          },
        })
      },
      () => {
        if (!controller.signal.aborted) fail('学びを取得できませんでした。もう一度お試しください。')
      },
    )
    return () => controller.abort()
  }, [normalizedRegion, scope, uid, epoch, attempt])

  let visible: PickerView
  if (session.status === 'restoring') {
    visible = { status: 'restoring' }
  } else if (session.status !== 'authenticated') {
    // 失効・復元失敗。ここから匿名アカウントを作らない（新規開始は利用者の明示操作だけ）。
    visible = {
      status: 'blocked',
      message: '認証状態を確認できません。ログイン状態を確認してください。',
    }
  } else {
    visible = sameKey(state.key, currentKey) ? state.view : { status: 'loading' }
  }

  const toggle = (event: ChangeEvent<HTMLInputElement>, item: VersionedLearning) => {
    if (visible.status !== 'ready') return
    const { id } = item.learning
    const next = event.target.checked
      ? [...visible.selected, { id, version: item.version }]
      : visible.selected.filter((value) => value.id !== id)
    selectedCountRef.current = next.length
    setNotice('')
    setState({ key: currentKey, view: { ...visible, selected: next } })
    // 選択は、一覧を取得したセッションと組で渡す。
    changeRef.current?.({
      scope: visible.list.scope,
      value: next,
      learnings: visible.list.value
        .filter(({ learning }) => next.some(({ id }) => id === learning.id))
        .map(({ learning }) => learning),
    })
  }

  const retry = () => {
    // 押したボタンは読み込み中に消える。フォーカスがページ先頭へ落ちないよう、
    // 常設の状況表示へ移してから再読み込みする。
    statusRef.current?.focus()
    setAttempt((count) => count + 1)
  }

  const message = statusMessage(visible)
  const errorMessage =
    visible.status === 'error' || visible.status === 'blocked' ? visible.message : null

  return (
    <section
      aria-label="次の旅に使う学び"
      className="space-y-3 rounded-xl border border-current/20 p-4"
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">前の旅の学びを使う</h2>
        <p className="text-sm text-gt-muted">
          自分で承認した学びから、今回の旅に使いたいものだけを選べます。
          選んだだけではまだ旅程に反映されません。
        </p>
        <p className="text-sm text-gt-muted">
          地域を限定した学びは、旅行先の地域と同じ表記のものだけが表示されます。
          例：「京都」と「京都市」は別の地域として扱います。
        </p>
      </div>

      <div ref={statusRef} role="status" tabIndex={-1} className="text-sm">
        {notice ? `${message}${message ? ' ' : ''}${notice}` : message}
      </div>
      {errorMessage !== null && (
        <div role="alert" className="space-y-2">
          <p className="text-sm">{errorMessage}</p>
          {visible.status === 'error' && (
            <button
              type="button"
              onClick={retry}
              className="min-h-11 rounded-lg border border-current/40 px-4 text-sm"
            >
              再読み込み
            </button>
          )}
        </div>
      )}
      {visible.status === 'ready' && visible.list.value.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">今回使う学び</legend>
          {visible.list.value.map((item) => {
            const { learning } = item
            return (
              <label
                key={learning.id}
                className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-current/20 p-3"
              >
                <input
                  type="checkbox"
                  checked={visible.selected.some(({ id }) => id === learning.id)}
                  onChange={(event) => toggle(event, item)}
                  className="mt-1 h-5 w-5 shrink-0"
                />
                <span className="min-w-0 space-y-1 break-words [overflow-wrap:anywhere]">
                  <span className="block text-sm font-medium">{learning.content}</span>
                  <span className="block text-xs text-gt-muted">
                    {categoryLabels[learning.category]}・
                    {learning.scope.kind === 'all_trips'
                      ? 'すべての地域'
                      : 'この地域だけ（' + learning.scope.region + '）'}
                  </span>
                </span>
              </label>
            )
          })}
          <p className="text-xs text-gt-muted">
            選択した学びは、次回生成時にサーバーが改めて確認します。
            ここに表示した後で内容が変わっていた場合は、そのまま使わず選び直しをお願いします。
            学びによる変更かどうかは、生成結果だけでは断定できません。
          </p>
        </fieldset>
      )}
    </section>
  )
}
