'use client'

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'

import { revisionTargetRestriction, type Stop } from '@/domain'
import { GoogleMapsSourceBox } from '@/features/legal/google-maps-attribution'
import { TRANSPORT_REVISION_UNAVAILABLE } from '@/features/plain-wording/wording'

import { EvidenceDetail, UnverifiedBadge } from './evidence-badge'
import type { SegmentEvidenceItem } from './evidence-scope'
import { LockIcon } from './icons'
import { endTime, isGoogleSource, stopKindLabels, type RouteStopMeta, type StopKind } from './model'

interface StopSheetProps {
  stop: Stop
  notice: string
  index: number
  meta: RouteStopMeta
  closing: boolean
  onExited: () => void
  // 前の地点からこの予定への移動についての根拠（路線図の区間ラベルと同じ判定：segmentEvidence）。
  // 逆向きの根拠や、区間を特定できない根拠は含まれない。
  segment: readonly SegmentEvidenceItem[]
  // 種別が取得できていなければundefined（「予定」と中立に表示する。観光とは決めつけない）。
  kind?: StopKind
  // 部分修正を始める。未提供なら、修正の操作は表示しない（未実装の操作を見せない）。
  onStartRevision?: (stopId: string) => void
  revisionUnavailableReason?: string
  onToggleFixed: (stopId: string, fixed: boolean) => void
  onClose: () => void
}

const DISMISS_DISTANCE = 96

// 背景を操作不可にし、閉じるアニメーションが終わるまでモーダルを維持する。
export function StopSheet({
  stop,
  notice,
  index,
  meta,
  segment,
  kind,
  closing,
  onExited,
  onStartRevision,
  revisionUnavailableReason,
  onToggleFixed,
  onClose,
}: StopSheetProps) {
  const titleId = useId()
  const revisionRestriction = revisionTargetRestriction(stop)
  const googleEvidence = stop.evidence.filter((item) => isGoogleSource(item.source.kind))
  const otherEvidence = stop.evidence.filter((item) => !isGoogleSource(item.source.kind))
  const dialogRef = useRef<HTMLDialogElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const drag = useRef<{
    pointerId: number
    startY: number
    offset: number
    handle: HTMLDivElement
  } | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const [dragPhase, setDragPhase] = useState<'dragging' | 'returning' | null>(null)

  useLayoutEffect(() => {
    if (!closing) {
      setDragOffset(0)
      return
    }
    // 閉じるボタンやEscで終了したときも、ポインターの捕捉を解除する。
    setDragPhase(null)
    const active = drag.current
    if (active) {
      drag.current = null
      if (active.handle.hasPointerCapture(active.pointerId))
        active.handle.releasePointerCapture(active.pointerId)
    }
  }, [closing])

  const visibleDragOffset = () => {
    const translation = sheetRef.current && getComputedStyle(sheetRef.current).translate
    return Number.parseFloat(translation?.split(' ')[1] ?? '') || 0
  }

  const dismiss = () => {
    if (closing) return
    if (dragPhase === 'returning') setDragOffset(visibleDragOffset())
    onClose()
  }

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (closing || drag.current || !event.isPrimary || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    // 短いドラッグから戻る途中でつかみ直した場合は、現在の表示位置から追従する。
    const offset = visibleDragOffset()
    drag.current = { pointerId: event.pointerId, startY: event.clientY, offset, handle }
    setDragOffset(offset)
    setDragPhase('dragging')
  }

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (active?.pointerId === event.pointerId)
      setDragOffset(Math.max(0, active.offset + event.clientY - active.startY))
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const active = drag.current
    if (active?.pointerId !== event.pointerId) return
    drag.current = null
    if (active.handle.hasPointerCapture(active.pointerId))
      active.handle.releasePointerCapture(active.pointerId)
    const distance = event.clientY - active.startY
    if (!cancelled && distance >= DISMISS_DISTANCE) {
      setDragPhase(null)
      setDragOffset(active.offset + distance)
      onClose()
    } else {
      setDragPhase('returning')
      setDragOffset(0)
    }
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    headingRef.current?.focus()
    return () => dialog.close()
  }, [])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const active = document.activeElement
    if (dialog?.open && (!dialog.contains(active) || active?.matches(':disabled'))) {
      headingRef.current?.focus()
    }
  }, [stop.isFixed])

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
    }
    if (event.key !== 'Tab') return

    // 根拠の開閉や固定状態の変更に合わせ、現在Tabで到達できる操作を取り直す。
    const controls = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), summary, a[href]',
      ),
    ].filter((element) => {
      const closedDetails = element.closest('details:not([open])')
      return !closedDetails || element === closedDetails.firstElementChild
    })
    const first = controls[0]
    const last = controls.at(-1)
    const active = document.activeElement
    if (
      (event.shiftKey && (active === first || active === headingRef.current)) ||
      (!event.shiftKey && active === last)
    ) {
      event.preventDefault()
      const destination = event.shiftKey ? last : first
      destination?.focus()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
      onCancel={(event) => {
        event.preventDefault()
        dismiss()
      }}
      onClickCapture={(event) => {
        if (closing) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-gt-ink backdrop:bg-transparent"
    >
      {!closing && (
        <div
          aria-hidden="true"
          data-sheet-backdrop
          className="fixed inset-0 z-[19] bg-gt-ink/25"
          onClick={dismiss}
        />
      )}
      <section
        ref={sheetRef}
        data-sheet-state={closing ? 'closing' : 'open'}
        data-sheet-dragging={dragPhase === 'dragging' || undefined}
        data-sheet-returning={dragPhase === 'returning' || undefined}
        style={{ translate: `0 ${dragOffset}px` }}
        onAnimationEnd={(event) => {
          if (
            closing &&
            event.target === event.currentTarget &&
            event.animationName === 'gt-sheet-out'
          )
            onExited()
        }}
        className="gt-sheet fixed inset-x-0 bottom-0 z-20 mx-auto flex max-h-[min(58dvh,28rem)] max-w-[34rem] flex-col overflow-hidden rounded-t-3xl border border-b-0 border-gt-rule bg-gt-paper text-gt-ink shadow-[0_-12px_36px_rgba(24,33,43,.15)]"
      >
        <div
          aria-hidden="true"
          data-sheet-handle
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => endDrag(event)}
          onPointerCancel={(event) => endDrag(event, true)}
          onLostPointerCapture={(event) => endDrag(event, true)}
          className="flex h-9 shrink-0 touch-none cursor-grab select-none items-center justify-center active:cursor-grabbing"
        >
          <span className="h-1 w-10 rounded-full bg-gt-muted/50" />
        </div>
        <div data-sheet-scroll className="min-h-0 overflow-y-auto overscroll-contain px-4 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <h2
              id={titleId}
              ref={headingRef}
              tabIndex={-1}
              className="pt-1 text-xl font-bold leading-snug wrap-anywhere outline-none"
            >
              {stop.name}
            </h2>
            <button
              type="button"
              onClick={dismiss}
              className="min-h-11 shrink-0 rounded-xl px-3 text-sm font-semibold text-gt-muted hover:bg-gt-bg"
            >
              閉じる
            </button>
          </div>
          <p className="text-sm text-gt-muted">
            {index + 1}番目・{kind ? stopKindLabels[kind] : '予定'}・{stop.plannedStartTime}〜
            {endTime(stop)}（{stop.durationMinutes}分）
          </p>

          {stop.isFixed && (
            <p className="mt-3 flex gap-2 rounded-lg bg-gt-bg p-2.5 text-sm">
              <span className="mt-0.5 flex-none">
                <LockIcon size={15} />
              </span>
              <span>
                <b>固定予定です。</b>
                他の予定を変更しても、この時刻・場所は動きません。この予定は部分修正の対象にできません。
              </span>
            </p>
          )}

          <dl className="mt-3 grid grid-cols-[6.2em_1fr] gap-x-2.5 gap-y-1 text-sm">
            <dt className="text-gt-muted">価格の目安</dt>
            <dd>{meta.price ?? <span className="font-bold text-gt-unk">未確認</span>}</dd>
            <dt className="text-gt-muted">前の地点から</dt>
            <dd>
              {meta.segmentFromPrevious?.status === 'known'
                ? `${meta.segmentFromPrevious.mode === 'walk' ? '徒歩' : '車'}${meta.segmentFromPrevious.minutes}分`
                : index === 0
                  ? '—'
                  : segment.length === 0
                    ? '移動時間は未確認'
                    : segment.some((item) => item.owner === 'destination')
                      ? '所要時間の数値は取得していません（下の根拠を参照）'
                      : '所要時間の数値は取得していません（前の予定の詳細の根拠を参照）'}
            </dd>
          </dl>

          <div className="mt-2">
            {stop.evidence.length === 0 ? (
              <div className="flex flex-wrap items-center gap-2 py-1">
                <UnverifiedBadge />
                <span className="text-sm text-gt-muted">
                  施設情報や移動時間と照合していません。
                </span>
              </div>
            ) : (
              <>
                {otherEvidence.map((item) => (
                  <EvidenceDetail key={item.id} evidence={item} />
                ))}
                {googleEvidence.length > 0 && (
                  // Places・Routes由来の根拠は枠で囲み、枠の下に常に見える帰属を付ける。
                  <div className={otherEvidence.length > 0 ? 'mt-2' : undefined}>
                    <GoogleMapsSourceBox caption="Google Maps Platformで確認した内容">
                      {googleEvidence.map((item) => (
                        <EvidenceDetail key={item.id} evidence={item} />
                      ))}
                    </GoogleMapsSourceBox>
                  </div>
                )}
              </>
            )}
          </div>

          <p className="mt-2 text-sm text-gt-muted">
            この表示はGroundTrip上の予定を操作するためのものです。予約の状態は反映されません。
          </p>

          <div className="sticky bottom-0 mt-3 space-y-2 border-t border-gt-rule bg-gt-paper py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
            <p role="status" aria-atomic="true" className="text-sm text-gt-muted empty:sr-only">
              {notice}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={stop.isFixed}
                onClick={() => onToggleFixed(stop.id, !stop.isFixed)}
                className="min-h-12 rounded-xl border border-gt-muted px-3 text-sm font-semibold aria-pressed:bg-gt-ink aria-pressed:text-white"
              >
                {stop.isFixed ? '固定を解除する' : 'この予定を固定する'}
              </button>
              {onStartRevision && revisionRestriction !== 'transport' && (
                <button
                  type="button"
                  disabled={revisionRestriction === 'fixed'}
                  onClick={() => onStartRevision(stop.id)}
                  className="min-h-12 flex-1 rounded-xl bg-gt-ink px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {revisionRestriction === 'fixed' ? '固定中は変更できません' : 'この予定だけ変更'}
                </button>
              )}
            </div>
            {revisionRestriction === 'transport' ? (
              <p className="text-sm text-gt-muted">{TRANSPORT_REVISION_UNAVAILABLE}</p>
            ) : revisionRestriction === null && !onStartRevision && revisionUnavailableReason ? (
              <p className="text-sm text-gt-muted">{revisionUnavailableReason}</p>
            ) : null}
          </div>
        </div>
      </section>
    </dialog>
  )
}
