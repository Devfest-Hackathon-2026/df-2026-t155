'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

import type { Trip } from '@/domain'
import { RouteFailure, RouteLoading } from '@/features/trip-map/route-states'

import { failureGuidance } from './failure-messages'
import { FixedStopsField, fixedStopFieldId } from './fixed-stops-field'
import {
  buildGenerateTripRequest,
  firstInvalidField,
  firstInvalidFixedStop,
  initialFormValues,
  MAX_FIXED_STOPS,
  type FixedStopErrorMap,
  type FixedStopField,
  type TripFormErrors,
  type TripFormField,
  type TripFormValues,
} from './form-model'
import { TripProposalPreview } from './trip-proposal-preview'
import { useTripGeneration, type GenerateTrip } from './use-trip-generation'

interface TripPlannerProps {
  // 旅程生成の呼び出し。テストや先行開発で差し替える。省略時は実際のAPIを呼ぶ。
  generate?: GenerateTrip
  // 生成された旅程の表示。#8の旅程一覧UIはここへ差し込む。省略時は暫定の一覧を出す。
  renderTrip?: (trip: Trip) => ReactNode
}

const defaultRenderTrip = (trip: Trip) => <TripProposalPreview trip={trip} />

const inputClassName = 'gt-field px-3 py-3'

// 旅行条件の入力から旅程の生成・表示までの入口。生成された旅程は提案であり、
// 自動で承認・確定・保存しない。入力値は生成の成否にかかわらず保持する。
export function TripPlanner({ generate, renderTrip = defaultRenderTrip }: TripPlannerProps) {
  const [values, setValues] = useState<TripFormValues>(initialFormValues)
  const [errors, setErrors] = useState<TripFormErrors>({})
  const [fixedStopErrors, setFixedStopErrors] = useState<FixedStopErrorMap>({})
  const [fixedStopNotice, setFixedStopNotice] = useState('')
  // 追加した行の画面上の識別子（入力欄の対応づけ用）。
  const nextRowKey = useRef(1)
  const addFixedStopRef = useRef<HTMLButtonElement>(null)
  // 次の描画のあとにフォーカスを移す入力欄のid（行の追加直後など）。
  const [focusId, setFocusId] = useState<string | null>(null)
  const { state, run } = useTripGeneration(generate)
  const isGenerating = state.phase === 'generating'

  const fieldRefs = useRef<Record<TripFormField, HTMLInputElement | HTMLTextAreaElement | null>>({
    region: null,
    date: null,
    preferences: null,
  })
  const resultHeadingRef = useRef<HTMLHeadingElement>(null)

  // 結果が出たら、見出しへフォーカスを移して読み上げと画面位置を合わせる。
  useEffect(() => {
    if (state.phase === 'succeeded') resultHeadingRef.current?.focus()
  }, [state.phase])

  useEffect(() => {
    if (focusId === null) return
    document.getElementById(focusId)?.focus()
    setFocusId(null)
  }, [focusId])

  const update = (field: TripFormField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
  }

  const addFixedStop = () => {
    if (values.fixedStops.length >= MAX_FIXED_STOPS) {
      setFixedStopNotice(`固定予定は、最大${MAX_FIXED_STOPS}件までです。`)
      return
    }
    const key = `row-${nextRowKey.current}`
    nextRowKey.current += 1
    setValues((current) => ({
      ...current,
      fixedStops: [...current.fixedStops, { key, name: '', startTime: '', duration: '' }],
    }))
    setFixedStopNotice('固定予定の入力欄を追加しました。')
    setFocusId(fixedStopFieldId(key, 'name'))
  }

  const removeFixedStop = (key: string) => {
    setValues((current) => ({
      ...current,
      fixedStops: current.fixedStops.filter((row) => row.key !== key),
    }))
    setFixedStopErrors(({ [key]: _removed, ...rest }) => rest)
    setFixedStopNotice('固定予定を削除しました。')
    // 消えたボタンの代わりに、追加ボタンへフォーカスを移す。
    addFixedStopRef.current?.focus()
  }

  const updateFixedStop = (key: string, field: FixedStopField, value: string) => {
    setValues((current) => ({
      ...current,
      fixedStops: current.fixedStops.map((row) => {
        if (row.key !== key) return row
        return field === 'startTime'
          ? { ...row, startTime: value }
          : field === 'duration'
            ? { ...row, duration: value }
            : { ...row, name: value }
      }),
    }))
    setFixedStopErrors((current) => ({
      ...current,
      [key]: { ...current[key], [field]: undefined },
    }))
    setFixedStopNotice('')
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isGenerating) return

    const built = buildGenerateTripRequest(values)
    if (!built.ok) {
      // ボタンは常に押せるようにし、押されたら不備の項目を示して最初の項目へ移動する。
      setErrors(built.errors)
      setFixedStopErrors(built.fixedStopErrors ?? {})
      const first = firstInvalidField(built.errors)
      if (first) {
        fieldRefs.current[first]?.focus()
      } else if (built.fixedStopErrors) {
        const target = firstInvalidFixedStop(values.fixedStops, built.fixedStopErrors)
        if (target) document.getElementById(fixedStopFieldId(target.key, target.field))?.focus()
      }
      return
    }
    setErrors({})
    setFixedStopErrors({})
    void run(built.request)
  }

  return (
    <div className="space-y-8">
      <form onSubmit={handleSubmit} noValidate aria-describedby="form-note" className="space-y-5">
        <p id="form-note" className="text-sm">
          旅行先と日付、希望条件から、日帰り旅行の旅程を提案します。
        </p>
        <fieldset disabled={isGenerating} className="space-y-5">
          <legend className="sr-only">旅行条件</legend>

          <div className="space-y-1">
            <label htmlFor="region" className="block font-medium">
              旅行先（必須）
            </label>
            <input
              id="region"
              name="region"
              type="text"
              ref={(element) => {
                fieldRefs.current.region = element
              }}
              value={values.region}
              onChange={(event) => update('region', event.target.value)}
              aria-required="true"
              aria-invalid={errors.region !== undefined}
              aria-describedby={errors.region ? 'region-error' : 'region-hint'}
              autoComplete="off"
              className={inputClassName}
            />
            <p id="region-hint" className="text-sm">
              例：京都市東山エリア
            </p>
            {errors.region && (
              <p id="region-error" className="text-sm font-medium">
                入力エラー：{errors.region}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="date" className="block font-medium">
              日付（必須）
            </label>
            <input
              id="date"
              name="date"
              type="date"
              ref={(element) => {
                fieldRefs.current.date = element
              }}
              value={values.date}
              onChange={(event) => update('date', event.target.value)}
              aria-required="true"
              aria-invalid={errors.date !== undefined}
              aria-describedby={errors.date ? 'date-error' : undefined}
              className={inputClassName}
            />
            {errors.date && (
              <p id="date-error" className="text-sm font-medium">
                入力エラー：{errors.date}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="preferences" className="block font-medium">
              希望条件（任意）
            </label>
            <textarea
              id="preferences"
              name="preferences"
              rows={4}
              ref={(element) => {
                fieldRefs.current.preferences = element
              }}
              value={values.preferences}
              onChange={(event) => update('preferences', event.target.value)}
              aria-invalid={errors.preferences !== undefined}
              aria-describedby={errors.preferences ? 'preferences-error' : 'preferences-hint'}
              className={inputClassName}
            />
            <p id="preferences-hint" className="text-sm">
              1行に1つ書いてください。例：ゆっくり歩きたい
            </p>
            {errors.preferences && (
              <p id="preferences-error" className="text-sm font-medium">
                入力エラー：{errors.preferences}
              </p>
            )}
          </div>

          <FixedStopsField
            rows={values.fixedStops}
            errors={fixedStopErrors}
            notice={fixedStopNotice}
            addButtonRef={addFixedStopRef}
            onAdd={addFixedStop}
            onRemove={removeFixedStop}
            onChange={updateFixedStop}
          />

          <button
            type="submit"
            className="min-h-12 w-full rounded-xl bg-gt-ink px-4 py-3 text-base font-semibold text-white"
          >
            {isGenerating ? '生成中…' : '旅程を作成する'}
          </button>
        </fieldset>
      </form>

      <div role="status" aria-live="polite">
        {isGenerating && <RouteLoading />}
      </div>

      {state.phase === 'failed' && (
        <RouteFailure
          title={failureGuidance[state.failure.kind].title}
          action={failureGuidance[state.failure.kind].action}
          message={state.failure.message}
          // 再生成に失敗すると、以前の旅程は表示から消える。保持されているのは、フォームの入力内容だけ。
          note="入力内容は保持されています。"
        />
      )}

      {state.phase === 'succeeded' && (
        <section aria-labelledby="result-heading" className="space-y-3">
          <h2
            id="result-heading"
            ref={resultHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold"
          >
            旅程の提案
          </h2>
          {renderTrip(state.trip)}
        </section>
      )}
    </div>
  )
}
