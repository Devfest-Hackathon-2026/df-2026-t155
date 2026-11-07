'use client'

import { useEffect, useRef } from 'react'

import type { Stop } from '@/domain'

import { EvidenceDetail, UnverifiedBadge } from './evidence-badge'
import { LockIcon } from './icons'
import { endTime, stopKindLabels, type RouteStopMeta, type StopKind } from './model'

interface StopSheetProps {
  stop: Stop
  index: number
  meta: RouteStopMeta
  // 種別が取得できていなければundefined（「予定」と中立に表示する。観光とは決めつけない）。
  kind?: StopKind
  // 部分修正を始める。未提供なら、修正の操作は表示しない（未実装の操作を見せない）。
  onStartRevision?: (stopId: string) => void
  onToggleFixed: (stopId: string, fixed: boolean) => void
  onClose: () => void
}

// 選択した予定の詳細と操作。地図（路線図）を隠さない、非モーダルの下部シート。
export function StopSheet({
  stop,
  index,
  meta,
  kind,
  onStartRevision,
  onToggleFixed,
  onClose,
}: StopSheetProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  // 開いたら見出しへフォーカスを移し、読み上げと操作の起点を合わせる。
  useEffect(() => {
    headingRef.current?.focus()
  }, [stop.id])

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="stop-sheet-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
      className="fixed inset-x-0 bottom-0 z-20 mx-auto max-h-[58vh] max-w-xl overflow-y-auto rounded-t-3xl border border-b-0 border-gt-ink bg-gt-paper px-5 pb-0 pt-3 text-gt-ink shadow-[0_-14px_30px_rgba(0,0,0,.18)]"
    >
      <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-gt-rule" />
      <h2
        id="stop-sheet-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-xl font-black leading-snug outline-none"
      >
        {stop.name}
      </h2>
      <p className="text-[13px] text-gt-muted">
        {index + 1}番目・{kind ? stopKindLabels[kind] : '予定'}・{stop.plannedStartTime}〜
        {endTime(stop)}（{stop.durationMinutes}分）
      </p>

      {stop.isFixed && (
        <p className="mt-3 flex gap-2 rounded-lg border-[1.5px] border-gt-ink bg-gt-ink/5 p-2.5 text-[13.5px]">
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
              : '移動時間は未確認'}
        </dd>
      </dl>

      <div className="mt-2">
        {stop.evidence.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2 py-1">
            <UnverifiedBadge />
            <span className="text-xs text-gt-muted">施設情報や移動時間と照合していません。</span>
          </div>
        ) : (
          stop.evidence.map((item) => <EvidenceDetail key={item.id} evidence={item} />)
        )}
      </div>

      <p className="mt-2 text-xs text-gt-muted">
        この表示はGroundTrip上の予定を操作するためのものです。予約の状態は反映されません。
      </p>

      <div className="sticky bottom-0 mt-3 flex flex-wrap gap-2 border-t border-gt-rule bg-gt-paper py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <button
          type="button"
          aria-pressed={stop.isFixed}
          onClick={() => onToggleFixed(stop.id, !stop.isFixed)}
          className="min-h-12 rounded-xl border-2 border-gt-ink px-4 text-[15px] font-black aria-pressed:bg-gt-ink aria-pressed:text-white"
        >
          {stop.isFixed ? '固定を解除する' : 'この予定を固定する'}
        </button>
        {onStartRevision && (
          <button
            type="button"
            disabled={stop.isFixed}
            onClick={() => onStartRevision(stop.id)}
            className="min-h-12 flex-1 rounded-xl bg-gt-line-strong px-4 text-[15px] font-black text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {stop.isFixed ? '固定中は変更できません' : 'この予定だけ変更'}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="min-h-12 rounded-xl border-[1.5px] border-gt-rule px-4 text-[15px] font-bold"
        >
          閉じる
        </button>
      </div>
    </section>
  )
}
