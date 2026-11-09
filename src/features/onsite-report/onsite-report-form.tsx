'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react'

import { revisionTargetRestriction, stopKindLabels, type Trip } from '@/domain'
import { TRANSPORT_REVISION_UNAVAILABLE } from '@/features/plain-wording/wording'

import { ONSITE_PALETTE as palette } from './palette'
import {
  MAX_NOTE_LENGTH,
  REPORT_PRESETS,
  buildSubmission,
  errorCount,
  firstInvalidField,
  fixedStops,
  initialValues,
  resolveTargetId,
  selectableStops,
  type OnSiteReportSubmission,
  type ReportField,
  type ReportFormErrors,
  type ReportFormValues,
  type ReportKind,
} from './report-model'

export type OnSiteReportStatus =
  { phase: 'idle' } | { phase: 'submitting' } | { phase: 'failed'; message: string }

interface OnSiteReportFormProps {
  trip: Trip
  // 報告の内容を親へ渡す。保存・API呼び出し・再計画の処理は、ここでは行わない。
  // 親は、この呼び出しと同じ更新の中で status を submitting にすること（二重送信の防止）。
  onSubmit: (submission: OnSiteReportSubmission) => void
  // 送信の状況（親が指定する）。
  status: OnSiteReportStatus
  // 最初に選んでおく予定（固定されていない予定のときだけ使う）。
  initialTargetStopId?: string
  // 選べる予定が1件だけのとき、それを自動で選ぶか（既定は選ぶ）。
  // 対象の予定が変わって入力を作り直したときは false にして、利用者に対象を選び直してもらう。
  autoSelectSingleTarget?: boolean
}

// 色はこのコンポーネントの中で完結させる（グローバルのテーマに依存しない）。
const rootStyle: CSSProperties & Record<`--of-${string}`, string> = {
  '--of-paper': palette.paper,
  '--of-ink': palette.ink,
  '--of-muted': palette.muted,
  '--of-edge': palette.edge,
  '--of-selected': palette.selected,
  '--of-accent': palette.accent,
  '--of-warn': palette.warn,
  '--of-warn-bg': palette.warnBg,
  '--of-caution': palette.caution,
  '--of-caution-bg': palette.cautionBg,
}

// 長い文字列でも、狭い画面で横にはみ出さない。
const wrapClass = 'break-words [overflow-wrap:anywhere]'
const focusClass =
  'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-(--of-ink)'
// 入力枠は、地色に対して3:1以上の境界を常に持つ（空欄・非フォーカスでも編集領域が分かる）。
const textareaClass = `block w-full min-h-24 rounded-lg border-2 border-(--of-edge) bg-(--of-paper) px-3 py-3 text-base text-(--of-ink) aria-[invalid=true]:border-(--of-warn) ${focusClass}`
const groupClass =
  'min-w-0 space-y-2 rounded-lg border-2 border-transparent p-0 aria-[invalid=true]:border-(--of-warn) aria-[invalid=true]:p-2'

const KIND_OPTIONS: ReadonlyArray<{ id: ReportKind; label: string; hint: string }> = [
  {
    id: 'actual',
    label: 'いまの現地の状況（実際の報告）',
    hint: '実際に起きていることを報告します。',
  },
  {
    id: 'simulated',
    label: 'デモ用の模擬報告',
    hint: '練習・デモ用に、起きた想定を試します。',
  },
]

const SIMULATED_NOTICE = 'デモ用の想定です。実際の出来事ではなく、学びの材料にもしません'

function submitLabel(kind: ReportFormValues['kind']): string {
  if (kind === 'actual') return '実際の報告として送る'
  if (kind === 'simulated') return '模擬報告として送る'
  return '報告する'
}

// 現地の状況を、少ない操作で報告するフォーム。
// ①どの予定か ②何が起きたか ③（任意）補足 ④報告の種類（実際／模擬）。送るだけで、旅程は変わらない
// （再計画の候補づくり・比較・承認は、別の機能）。
//
// 操作の方針：
// - 送信ボタンは常に押せる。不備があれば該当の欄を示し、最初の不備へフォーカスを移す。
// - 入力し直すと、その欄の案内だけが消える。入力は、送信の失敗後も保持する。
// - 処理中は二重送信しない（ref による即時ロック。親の再描画を待たずに止める）。
export function OnSiteReportForm({
  trip,
  onSubmit,
  status,
  initialTargetStopId,
  autoSelectSingleTarget = true,
}: OnSiteReportFormProps) {
  const baseId = useId()
  const [values, setValues] = useState<ReportFormValues>(() =>
    initialValues(trip, initialTargetStopId, autoSelectSingleTarget),
  )
  const [errors, setErrors] = useState<ReportFormErrors>({})
  const [lastTripId, setLastTripId] = useState(trip.id)
  const [submitTick, setSubmitTick] = useState(0)

  const lockRef = useRef(false)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const radioRefs = useRef<Partial<Record<'target' | 'preset' | 'kind', HTMLInputElement | null>>>(
    {},
  )
  const targetGroupRef = useRef<HTMLFieldSetElement>(null)

  // 別の旅程になったら、前の旅程への入力と案内を消す（描画中の状態調整）。
  if (trip.id !== lastTripId) {
    setLastTripId(trip.id)
    setValues(initialValues(trip, initialTargetStopId, autoSelectSingleTarget))
    setErrors({})
  }

  // 処理中でなくなったら（失敗・待機に戻った、または親が処理中にしなかった）、ロックを外す。
  // 親が同じ更新の中で処理中にした場合は、このコミットで status が submitting になっているため外れない。
  useEffect(() => {
    if (status.phase !== 'submitting') lockRef.current = false
  }, [status.phase, submitTick])

  const submitting = status.phase === 'submitting'
  const selectable = selectableStops(trip)
  const fixed = fixedStops(trip)
  const hasTransport = trip.stops.some((stop) => revisionTargetRestriction(stop) === 'transport')
  // 選べる予定が1件だけなら最初から選択する。選べなくなった予定は未選択に戻す。
  const targetStopId = resolveTargetId(trip, values.targetStopId, autoSelectSingleTarget)
  const current: ReportFormValues = { ...values, targetStopId }
  const count = errorCount(errors)

  const update = (field: ReportField, patch: Partial<ReportFormValues>) => {
    if (submitting) return
    setValues((previous) => ({ ...previous, ...patch }))
    // 入力し直した項目の案内だけを消す。「その他」の切り替えは、補足の必須の案内にも影響する。
    setErrors((previous) => {
      const next = { ...previous, [field]: undefined }
      if (field === 'preset') next.note = undefined
      return next
    })
  }

  const focusField = (field: ReportField) => {
    if (field === 'note') {
      noteRef.current?.focus()
    } else if (field === 'target') {
      ;(radioRefs.current.target ?? targetGroupRef.current)?.focus()
    } else {
      radioRefs.current[field]?.focus()
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // 即時ロック：状態の更新は非同期のため、連続した送信は ref で確実に止める。
    if (lockRef.current || submitting) return

    const built = buildSubmission(trip, current)
    if (!built.ok) {
      // ボタンは常に押せるようにし、押されたら不備の欄を示して最初の欄へ移動する。
      setErrors(built.errors)
      const first = firstInvalidField(built.errors)
      if (first) focusField(first)
      return
    }
    setErrors({})
    lockRef.current = true
    try {
      onSubmit(built.submission)
    } catch (error) {
      lockRef.current = false
      throw error
    }
    setSubmitTick((tick) => tick + 1)
  }

  const noteRequired = current.preset === 'other'
  const noteLength = current.note.trim().length
  const simulated = current.kind === 'simulated'

  const statusText = submitting
    ? simulated
      ? '模擬報告として送信しています。しばらくお待ちください。'
      : '送信しています。しばらくお待ちください。'
    : count > 0
      ? `入力に不足があります（${count}件）。最初の欄へ移動しました。`
      : ''

  const id = (name: string) => `${baseId}-${name}`

  return (
    <section
      aria-labelledby={id('heading')}
      style={rootStyle}
      className={`mx-auto w-full max-w-xl rounded-xl border-2 border-(--of-edge) bg-(--of-paper) p-4 text-base text-(--of-ink) ${wrapClass}`}
    >
      <h2 id={id('heading')} className="gt-screen-title">
        現地の状況を報告する
      </h2>
      <p className="mt-1 text-sm text-(--of-muted)">
        報告しただけで、旅程は変わりません。変更は、案を比べて、あなたが承認したときだけ反映されます。
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-6">
        {/* ① どの予定の状況か */}
        <fieldset
          ref={targetGroupRef}
          role="radiogroup"
          tabIndex={-1}
          aria-required="true"
          aria-invalid={errors.target !== undefined}
          aria-describedby={errors.target ? id('target-error') : id('target-hint')}
          className={groupClass}
        >
          <legend className="text-base font-semibold">1. どの予定の状況ですか（必須）</legend>
          <div id={id('target-hint')} className="text-sm text-(--of-muted)">
            <p>固定予定は、修正の対象にできないため、選べません。</p>
            {hasTransport && <p>{TRANSPORT_REVISION_UNAVAILABLE}</p>}
          </div>
          <FieldError id={id('target-error')} message={errors.target} />
          {selectable.length === 0 && (
            <p className="rounded-lg border-2 border-(--of-edge) p-3 text-sm">
              修正できる予定がありません。
              {fixed.length === trip.stops.length && 'すべて固定予定です。'}
            </p>
          )}
          <div className="space-y-2">
            {selectable.map((stop, index) => (
              <RadioOption
                key={stop.id}
                name={id('target')}
                value={stop.id}
                checked={targetStopId === stop.id}
                onChange={() => update('target', { targetStopId: stop.id })}
                inputRef={
                  index === 0
                    ? (element) => {
                        radioRefs.current.target = element
                      }
                    : undefined
                }
              >
                <span className="block font-medium">{stop.name}</span>
                <span className="block text-sm text-(--of-muted)">
                  {stop.plannedStartTime} 開始
                  {stop.kind ? `・${stopKindLabels[stop.kind]}` : ''}
                </span>
              </RadioOption>
            ))}
          </div>
          {fixed.length > 0 && (
            <div className="rounded-lg border-2 border-dashed border-(--of-edge) p-3">
              <p className="text-sm font-medium">固定予定（修正の対象にできません）</p>
              <ul className="mt-1 space-y-1 text-sm text-(--of-muted)">
                {fixed.map((stop) => (
                  <li key={stop.id}>
                    <span className="mr-2 rounded border-2 border-(--of-ink) px-1 text-xs font-semibold text-(--of-ink)">
                      固定
                    </span>
                    {stop.plannedStartTime} {stop.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>

        {/* ② 何が起きたか */}
        <fieldset
          role="radiogroup"
          aria-required="true"
          aria-invalid={errors.preset !== undefined}
          aria-describedby={errors.preset ? id('preset-error') : undefined}
          className={groupClass}
        >
          <legend className="text-base font-semibold">2. 何が起きましたか（必須）</legend>
          <FieldError id={id('preset-error')} message={errors.preset} />
          <div className="space-y-2">
            {REPORT_PRESETS.map((preset, index) => (
              <RadioOption
                key={preset.id}
                name={id('preset')}
                value={preset.id}
                checked={current.preset === preset.id}
                onChange={() => update('preset', { preset: preset.id })}
                inputRef={
                  index === 0
                    ? (element) => {
                        radioRefs.current.preset = element
                      }
                    : undefined
                }
              >
                <span className="block font-medium">{preset.label}</span>
              </RadioOption>
            ))}
          </div>
        </fieldset>

        {/* ③ 補足 */}
        <div className="space-y-1">
          <label htmlFor={id('note')} className="block text-base font-semibold">
            3. 補足{noteRequired ? '（「その他」は必須）' : '（任意）'}
          </label>
          <FieldError id={id('note-error')} message={errors.note} />
          <textarea
            id={id('note')}
            ref={noteRef}
            rows={3}
            value={current.note}
            readOnly={submitting}
            onChange={(event) => update('note', { note: event.target.value })}
            aria-required={noteRequired ? 'true' : undefined}
            aria-invalid={errors.note !== undefined}
            aria-describedby={`${errors.note ? `${id('note-error')} ` : ''}${id('note-hint')}`}
            className={textareaClass}
          />
          <p id={id('note-hint')} className="text-sm text-(--of-muted)">
            {noteLength} / {MAX_NOTE_LENGTH}文字。例：臨時休業の貼り紙があった
          </p>
        </div>

        {/* ④ 報告の種類（実際／模擬）。既定は選ばせない */}
        <fieldset
          role="radiogroup"
          aria-required="true"
          aria-invalid={errors.kind !== undefined}
          aria-describedby={`${errors.kind ? `${id('kind-error')} ` : ''}${id('kind-hint')}`}
          className={groupClass}
        >
          <legend className="text-base font-semibold">4. 報告の種類（必須）</legend>
          <p id={id('kind-hint')} className="text-sm text-(--of-muted)">
            実際の現地の報告と、デモ用の模擬報告は、区別して扱います。
          </p>
          <FieldError id={id('kind-error')} message={errors.kind} />
          <div className="space-y-2">
            {KIND_OPTIONS.map((option, index) => (
              <RadioOption
                key={option.id}
                name={id('kind')}
                value={option.id}
                checked={current.kind === option.id}
                onChange={() => update('kind', { kind: option.id })}
                inputRef={
                  index === 0
                    ? (element) => {
                        radioRefs.current.kind = element
                      }
                    : undefined
                }
              >
                <span className="block font-medium">{option.label}</span>
                <span className="block text-sm text-(--of-muted)">{option.hint}</span>
              </RadioOption>
            ))}
          </div>
          {/* 常設のライブリージョン：選んだ内容の注意を、テキストの更新として知らせる */}
          <div role="status" aria-label="報告の種類についての注意">
            {simulated && (
              <p className="rounded-lg border-2 border-(--of-caution) bg-(--of-caution-bg) p-3 text-sm font-medium text-(--of-caution)">
                模擬報告：{SIMULATED_NOTICE}
              </p>
            )}
          </div>
        </fieldset>

        <div className="space-y-3">
          {/* 常設のライブリージョン：不足の件数と処理中を、テキストの更新として知らせる */}
          <div role="status" aria-label="入力と送信の状況" className="text-sm font-medium">
            {statusText}
          </div>
          {status.phase === 'failed' && (
            <p
              role="alert"
              className="rounded-lg border-2 border-(--of-warn) bg-(--of-warn-bg) p-3 text-sm font-medium text-(--of-warn)"
            >
              送信に失敗しました：{status.message}
              入力した内容は残っています。もう一度、送信してください。
            </p>
          )}
          <button
            type="submit"
            aria-disabled={submitting || undefined}
            className={`min-h-12 w-full rounded-lg border-2 border-(--of-ink) bg-(--of-accent) px-4 py-3 text-base font-semibold text-white aria-disabled:opacity-70 ${focusClass}`}
          >
            {submitting ? '送信しています…' : submitLabel(current.kind)}
          </button>
        </div>
      </form>
    </section>
  )
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null
  // 状態は色だけで伝えない（「入力エラー：」の文言と、太い枠を併用する）。フォーカス移動で読み上げられる。
  return (
    <p
      id={id}
      className="rounded-lg border-2 border-(--of-warn) bg-(--of-warn-bg) p-2 text-sm font-medium text-(--of-warn)"
    >
      入力エラー：{message}
    </p>
  )
}

interface RadioOptionProps {
  name: string
  value: string
  checked: boolean
  onChange: () => void
  inputRef?: (element: HTMLInputElement | null) => void
  children: ReactNode
}

// タップ領域は行全体（44px以上）。選択中は、ラジオの印・太字の枠・地色で示し、色だけに頼らない。
function RadioOption({ name, value, checked, onChange, inputRef, children }: RadioOptionProps) {
  return (
    <label
      className={`flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border-2 p-3 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--of-ink) ${
        checked ? 'border-(--of-ink) bg-(--of-selected)' : 'border-(--of-edge) bg-(--of-paper)'
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        ref={inputRef}
        className="mt-0.5 size-6 shrink-0 accent-(--of-ink)"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )
}
