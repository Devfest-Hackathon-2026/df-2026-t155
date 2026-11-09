'use client'

import type { RefObject } from 'react'

import {
  MAX_FIXED_STOPS,
  type FixedStopErrorMap,
  type FixedStopField,
  type FixedStopRow,
} from './form-model'

// 固定予定（時刻が決まっている予定）の入力欄。入力は利用者の申告として扱う。
// 固定は、予約・購入を意味しない。施設の確認は、旅程ができたあとの照合で行う。

export const fixedStopFieldId = (key: string, field: FixedStopField): string =>
  `fixed-${key}-${field}`

interface FixedStopsFieldProps {
  rows: readonly FixedStopRow[]
  errors: FixedStopErrorMap
  // 追加・削除の結果などの案内（読み上げ用）。
  notice: string
  addButtonRef: RefObject<HTMLButtonElement | null>
  onAdd: () => void
  onRemove: (key: string) => void
  onChange: (key: string, field: FixedStopField, value: string) => void
}

const inputClassName = 'gt-field px-3 py-3'
const buttonClassName = 'gt-button-secondary w-full'

export function FixedStopsField({
  rows,
  errors,
  notice,
  addButtonRef,
  onAdd,
  onRemove,
  onChange,
}: FixedStopsFieldProps) {
  const atMax = rows.length >= MAX_FIXED_STOPS

  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">固定予定（任意）</legend>
      <p id="fixed-stops-note" className="text-sm">
        時刻が決まっている予定（展示・新幹線・イベントなど）を入れると、その時刻と場所を動かさずに旅程を作ります。
        <b>固定は、予約・購入を意味しません。</b>
        入力した内容は、あなたの申告として扱い、旅程ができたあとに、施設が確認できるかを調べます。
      </p>

      {rows.map((row, index) => {
        const rowErrors = errors[row.key] ?? {}
        const field = (name: FixedStopField) => fixedStopFieldId(row.key, name)
        const describedBy = (name: FixedStopField) =>
          rowErrors[name] ? `${field(name)}-error` : undefined
        return (
          <fieldset
            key={row.key}
            aria-describedby="fixed-stops-note"
            className="gt-card min-w-0 space-y-3 bg-gt-bg"
          >
            <legend className="px-1 text-sm font-medium">固定予定 {index + 1}</legend>

            <div className="space-y-1">
              <label htmlFor={field('name')} className="block text-sm font-medium">
                予定の名前
              </label>
              <input
                id={field('name')}
                type="text"
                value={row.name}
                onChange={(event) => onChange(row.key, 'name', event.target.value)}
                aria-required="true"
                aria-invalid={rowErrors.name !== undefined}
                aria-describedby={describedBy('name')}
                autoComplete="off"
                className={inputClassName}
              />
              {rowErrors.name && (
                <p id={`${field('name')}-error`} className="text-sm font-medium">
                  入力エラー：{rowErrors.name}
                </p>
              )}
            </div>

            <div className="flex gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={field('startTime')} className="block text-sm font-medium">
                  開始時刻
                </label>
                <input
                  id={field('startTime')}
                  type="time"
                  value={row.startTime}
                  onChange={(event) => onChange(row.key, 'startTime', event.target.value)}
                  aria-required="true"
                  aria-invalid={rowErrors.startTime !== undefined}
                  aria-describedby={describedBy('startTime')}
                  className={inputClassName}
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={field('duration')} className="block text-sm font-medium">
                  滞在時間（分）
                </label>
                <input
                  id={field('duration')}
                  type="text"
                  inputMode="numeric"
                  value={row.duration}
                  onChange={(event) => onChange(row.key, 'duration', event.target.value)}
                  aria-required="true"
                  aria-invalid={rowErrors.duration !== undefined}
                  aria-describedby={describedBy('duration')}
                  autoComplete="off"
                  className={inputClassName}
                />
              </div>
            </div>
            {rowErrors.startTime && (
              <p id={`${field('startTime')}-error`} className="text-sm font-medium">
                入力エラー：{rowErrors.startTime}
              </p>
            )}
            {rowErrors.duration && (
              <p id={`${field('duration')}-error`} className="text-sm font-medium">
                入力エラー：{rowErrors.duration}
              </p>
            )}

            <button
              type="button"
              onClick={() => onRemove(row.key)}
              aria-label={`固定予定 ${index + 1} を削除`}
              className={buttonClassName}
            >
              この固定予定を削除
            </button>
          </fieldset>
        )
      })}

      <button
        type="button"
        ref={addButtonRef}
        onClick={onAdd}
        aria-describedby="fixed-stops-count"
        className={buttonClassName}
      >
        固定予定を追加
      </button>
      <p id="fixed-stops-count" className="text-sm">
        {rows.length} / {MAX_FIXED_STOPS}件{atMax ? '（これ以上は追加できません）' : ''}
      </p>
      <div
        role="status"
        aria-live="polite"
        aria-label="固定予定の案内"
        className="text-sm font-medium"
      >
        {notice}
      </div>
    </fieldset>
  )
}
