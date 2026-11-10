'use client'

import { useId, useLayoutEffect, useRef, useState } from 'react'

import type { Revision } from '@/domain'
import {
  MANUAL_CONFIRMATION_MAX,
  MANUAL_UNVERIFIED,
  ManualConfirmationSchema,
  manualOperationId,
  type ManualApplyBody,
  type ManualRevisionGrant,
} from '@/domain/manual-revision'

export function ManualConfirmationForm({
  revision,
  grant,
  busy,
  disabled,
  onApprove,
}: {
  revision: Revision
  grant: ManualRevisionGrant
  busy: boolean
  disabled: boolean
  onApprove: (confirmation: ManualApplyBody['confirmation'], operationId: string) => void
}) {
  const id = useId()
  const [preview, setPreview] = useState<{
    confirmation: ManualApplyBody['confirmation']
    operationId: string
  }>()
  const [preparing, setPreparing] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [source, setSource] = useState('')
  const [checked, setChecked] = useState('')
  const [remaining, setRemaining] = useState('')
  const summary = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    if (preview) summary.current?.focus()
  }, [preview])
  const confirmation = preview?.confirmation

  const { before, after } = revision.diff
  return (
    <div className="space-y-3">
      <p className="text-sm wrap-anywhere">
        {before.plannedStartTime}・{before.durationMinutes}分　{before.name} →{' '}
        <strong>{after.name}</strong>
      </p>
      <p className="text-sm">変更するのはこの1地点です。開始時刻と滞在時間はそのままです。</p>
      <div className="gt-notice space-y-1 text-sm">
        <p className="font-bold">システムの判定：未確認</p>
        <p>
          {revision.constraintCheck.explanation.replace(/確認できるまで、承認できません。$/, '')}
        </p>
        <p>{MANUAL_UNVERIFIED}</p>
      </div>
      {preview && confirmation ? (
        <div className="space-y-3">
          <h3 ref={summary} tabIndex={-1} className="font-bold">
            本人の確認記録
          </h3>
          <dl className="space-y-2 text-sm whitespace-pre-wrap wrap-anywhere">
            <div>
              <dt className="font-semibold">情報源</dt>
              <dd>{confirmation.source}</dd>
            </div>
            <div>
              <dt className="font-semibold">確認内容</dt>
              <dd>{confirmation.checked}</dd>
            </div>
            {confirmation.remaining && (
              <div>
                <dt className="font-semibold">本人が確認できなかった事項</dt>
                <dd>{confirmation.remaining}</dd>
              </div>
            )}
          </dl>
          <p className="text-sm">この記録は本人の申告として保存されます。</p>
          <div className="grid gap-2">
            <button
              type="button"
              className="gt-button-primary min-h-11"
              disabled={busy || disabled}
              onClick={() => onApprove(confirmation, preview.operationId)}
            >
              {busy ? '適用を確認中…' : '本人の判断で承認して適用'}
            </button>
            <button
              type="button"
              className="gt-button-secondary min-h-11"
              disabled={busy || disabled}
              onClick={() => setPreview(undefined)}
            >
              確認記録を編集
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault()
            if (disabled || preparing) return
            const result = ManualConfirmationSchema.safeParse({
              source,
              checked,
              ...(remaining.trim() ? { remaining } : {}),
            })
            if (!result.success) return
            setPreparing(true)
            setPreviewFailed(false)
            try {
              const operationId = await manualOperationId(grant, result.data)
              setPreview({ confirmation: result.data, operationId })
            } catch {
              setPreviewFailed(true)
            } finally {
              setPreparing(false)
            }
          }}
        >
          <fieldset disabled={busy || disabled || preparing} className="min-w-0 space-y-2">
            <legend className="sr-only">本人の確認記録を入力</legend>
            <label htmlFor={`${id}-source`} className="block text-sm font-semibold">
              確認した情報源（URL、公式サイト名、電話など）
            </label>
            <textarea
              id={`${id}-source`}
              className="gt-field px-3 py-2"
              rows={2}
              required
              maxLength={MANUAL_CONFIRMATION_MAX}
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
            <label htmlFor={`${id}-checked`} className="block text-sm font-semibold">
              自分で確認した内容
            </label>
            <textarea
              id={`${id}-checked`}
              className="gt-field px-3 py-2"
              rows={2}
              required
              maxLength={MANUAL_CONFIRMATION_MAX}
              value={checked}
              onChange={(event) => setChecked(event.target.value)}
            />
            <label htmlFor={`${id}-remaining`} className="block text-sm font-semibold">
              確認できなかった事項（任意）
            </label>
            <textarea
              id={`${id}-remaining`}
              className="gt-field px-3 py-2"
              rows={2}
              maxLength={MANUAL_CONFIRMATION_MAX}
              value={remaining}
              onChange={(event) => setRemaining(event.target.value)}
            />
          </fieldset>
          {previewFailed && <p role="alert">承認の準備に失敗しました。もう一度お試しください。</p>}
          <button
            type="submit"
            className="gt-button-primary min-h-11 w-full"
            disabled={disabled || preparing || !source.trim() || !checked.trim()}
          >
            本人の確認記録を確認する
          </button>
        </form>
      )}
    </div>
  )
}
