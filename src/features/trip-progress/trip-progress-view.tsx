'use client'

import { useState, type MouseEventHandler } from 'react'

import { revisionTargetRestriction, type Stop, type Trip } from '@/domain'
import { GoogleMapsAttribution } from '@/features/legal/google-maps-attribution'
import { TRANSPORT_REVISION_UNAVAILABLE } from '@/features/plain-wording/wording'

import { paletteStyle } from './palette'
import {
  clampIndex,
  evidenceLines,
  gapMinutes,
  progressOf,
  stepBack,
  stepForward,
  stopEndTime,
  simulatedNote,
  travelBasesOf,
  type StopProgress,
} from './progress-model'
import { CheckIcon, ProgressChip, StatusLine } from './progress-parts'
import { LockIcon } from '@/features/trip-map/icons'
import { FixedChip } from '@/features/trip-map/route-map'

export type FinishTripAction =
  | { onFinish: MouseEventHandler<HTMLButtonElement>; unavailableReason?: never }
  | { onFinish?: never; unavailableReason: string }

interface TripProgressViewProps {
  trip: Trip
  // 最初に「いまの予定」とする位置（0始まり）。省略時は最初の予定。範囲外は範囲内に収める。
  initialIndex?: number
  // 再計画の入口。渡されたときだけ、変更ボタンを表示する（未実装の操作を見せない）。
  onReplan?: (stopId: string) => void
  finishAction?: FinishTripAction
}

// 進行状態は画面内の状態（保存しない）。利用者の手動操作だけで変わる。
interface ProgressState {
  tripId: string
  index: number
  notice: string
  // 同じ文言が続いても読み上げ直されるよう、更新のたびに数える。
  tick: number
}

const wrapClass = 'min-w-0 [overflow-wrap:anywhere]'
const secondaryAction =
  'gt-button-secondary min-h-[46px] w-full border-2 border-gt-ink text-base font-bold'

const formatStopLabel = (stop: Stop) => `${stop.name}（${stop.plannedStartTime}）`

// 旅行中の画面：いまの予定と次の予定、縦の路線、手動の進行操作。
// 位置情報・現在時刻は使わない。進行状況は、本人のボタン操作だけで更新する。
export function TripProgressView({
  trip,
  initialIndex = 0,
  onReplan,
  finishAction,
}: TripProgressViewProps) {
  const stops = trip.stops
  const [state, setState] = useState<ProgressState>(() => ({
    tripId: trip.id,
    index: clampIndex(initialIndex, stops.length),
    notice: '',
    tick: 0,
  }))

  // 別の旅程になったら、前の旅程の進行状態を消す（描画中の状態調整）。
  let view = state
  if (state.tripId !== trip.id) {
    view = {
      tripId: trip.id,
      index: clampIndex(initialIndex, stops.length),
      notice: '',
      tick: 0,
    }
    setState(view)
  }

  const currentIndex = clampIndex(view.index, stops.length)
  const current = stops[currentIndex]
  const next = stops[currentIndex + 1]
  const finishUnavailableReason = next ? undefined : finishAction?.unavailableReason

  if (!current) {
    return (
      <section style={paletteStyle} aria-label="旅行中の進行状況" className="text-gt-ink">
        <p className="text-sm">表示できる予定がありません。</p>
      </section>
    )
  }

  const announce = (message: string, index: number) =>
    setState((prev) => ({ ...prev, index, notice: message, tick: prev.tick + 1 }))

  const handleForward = () => {
    const result = stepForward(currentIndex, stops.length)
    announce(`いまの予定：${formatStopLabel(stops[result.index])}に進みました`, result.index)
  }

  const handleBack = () => {
    const result = stepBack(currentIndex, stops.length)
    if (!result.moved) {
      announce('最初の予定です。これ以上は戻せません。', result.index)
      return
    }
    announce(`いまの予定：${formatStopLabel(stops[result.index])}に戻しました`, result.index)
  }

  return (
    <section style={paletteStyle} aria-labelledby="trip-progress-heading" className="text-gt-ink">
      <h2 id="trip-progress-heading" className="sr-only">
        旅行中の進行状況
      </h2>

      <div className="gt-onsite-progress-meta mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-xs">
        <p className="font-bold tabular-nums">
          進行位置：{currentIndex + 1} / {stops.length} 件
        </p>
        <p>手動更新・未保存・位置情報不使用</p>
      </div>
      <CurrentCard
        stop={current}
        index={currentIndex}
        total={stops.length}
        showReplanRestriction={Boolean(onReplan)}
      />
      <NextCard current={current} next={next} />

      <div role="group" aria-label="進行状況の更新" className="mt-4 grid gap-2.5">
        {(next || finishAction) && (
          <button
            type="button"
            onClick={next ? handleForward : finishAction?.onFinish}
            aria-disabled={finishUnavailableReason ? true : undefined}
            aria-describedby={finishUnavailableReason ? 'trip-finish-unavailable' : undefined}
            className="gt-button-primary min-h-[52px] w-full text-base font-bold"
          >
            {next ? '次の予定へ進む' : '旅行を終えて振り返る'}
          </button>
        )}
        {finishUnavailableReason && (
          <p id="trip-finish-unavailable" className="text-sm text-gt-muted">
            {finishUnavailableReason}
          </p>
        )}
        <button type="button" onClick={handleBack} className={secondaryAction}>
          ひとつ前に戻す
        </button>
        {onReplan && revisionTargetRestriction(current) === null && (
          <button
            type="button"
            onClick={() => onReplan(current.id)}
            className={`${secondaryAction} text-sm`}
          >
            予定が変わった？この予定だけ変更する
          </button>
        )}
      </div>

      <p
        role="status"
        className={`text-sm font-semibold not-empty:mt-2 not-empty:border-l-4 not-empty:border-gt-muted not-empty:pl-3 ${wrapClass}`}
      >
        <span key={view.tick}>{view.notice}</span>
      </p>
      <p className={`mt-2 text-xs text-gt-muted ${wrapClass}`}>
        位置情報は使っていません。進行状況は、ボタンで更新します。この状況は保存されません。
      </p>
      <h3 className="mt-5 text-sm font-bold">旅のながれ</h3>
      <p className={`mt-1 text-xs text-gt-muted ${wrapClass}`}>
        路線図は予定の順番を示す模式図で、位置や距離を示しません。
      </p>
      <Route stops={stops} currentIndex={currentIndex} />
    </section>
  )
}

function CurrentCard({
  stop,
  index,
  total,
  showReplanRestriction,
}: {
  stop: Stop
  index: number
  total: number
  showReplanRestriction: boolean
}) {
  const lines = evidenceLines(stop)
  const restriction = revisionTargetRestriction(stop)
  return (
    <section
      aria-labelledby="trip-progress-current"
      className="gt-onsite-current-ticket rounded-[14px] border border-gt-line px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <h3 id="trip-progress-current" className="text-sm font-bold text-gt-line-strong">
          いまの予定
        </h3>
        <span className="text-xs font-semibold text-gt-muted">
          予定 {index + 1} / {total}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-2xl leading-none font-bold tabular-nums">
          <span aria-hidden="true">{stop.plannedStartTime}</span>
          <span className="sr-only">
            {stop.plannedStartTime}〜{stopEndTime(stop)}・滞在{stop.durationMinutes}分
          </span>
        </p>
        {stop.isFixed && <FixedChip />}
      </div>
      <p className={`mt-1 text-2xl leading-tight font-bold ${wrapClass}`}>{stop.name}</p>
      <ul aria-label="根拠の状態" className="mt-1.5 grid gap-1">
        {lines.length === 0 ? (
          <li>
            <StatusLine kind="unchecked">根拠：未照合（まだ確認していません）</StatusLine>
          </li>
        ) : (
          lines.map((line) => {
            const source = stop.evidence.find(
              (item) =>
                item.subject === line.subject &&
                item.status === line.status &&
                (item.source.kind === 'simulation') === line.simulated,
            )?.source.kind
            const google = source === 'places' || source === 'routes'
            return (
              <li key={`${line.subject}-${line.simulated ? 'demo' : 'real'}`}>
                <span
                  className={
                    google
                      ? 'inline-flex flex-wrap items-center gap-1 rounded border border-[#5E5E5E] bg-white p-1'
                      : undefined
                  }
                >
                  <StatusLine
                    kind={line.status}
                    simulated={line.simulated}
                  >{`${line.subjectLabel}：${line.statusLabel}`}</StatusLine>
                  {google && <GoogleMapsAttribution />}
                </span>
              </li>
            )
          })
        )}
      </ul>
      {lines.some((line) => line.simulated) && (
        <p className={`mt-1.5 text-xs text-(color:--tp-muted) ${wrapClass}`}>
          「デモ用の想定」は、{simulatedNote}。
        </p>
      )}
      {(restriction === 'transport' || (showReplanRestriction && restriction === 'fixed')) && (
        <p className={`mt-2 text-sm text-gt-muted ${wrapClass}`}>
          {restriction === 'transport'
            ? TRANSPORT_REVISION_UNAVAILABLE
            : '固定予定のため、固定を解除するまで、変更の対象にできません。'}
        </p>
      )}
    </section>
  )
}

function NextCard({ current, next }: { current: Stop; next: Stop | undefined }) {
  return (
    <section
      aria-labelledby="trip-progress-next"
      className="mt-2.5 rounded-[14px] border border-gt-rail bg-gt-paper px-3.5 py-2.5"
    >
      <h3 id="trip-progress-next" className="text-xs font-bold text-gt-muted">
        次の予定
      </h3>
      {next ? (
        <NextBody current={current} next={next} />
      ) : (
        <p className="mt-2 text-base font-bold">最後の予定です</p>
      )}
    </section>
  )
}

function NextBody({ current, next }: { current: Stop; next: Stop }) {
  const bases = travelBasesOf(next)
  const gap = gapMinutes(current, next)
  return (
    <>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
        <p className={`text-base leading-tight font-bold ${wrapClass}`}>
          <span aria-hidden="true">{next.plannedStartTime}</span>
          <span className="sr-only">{next.plannedStartTime}から</span> <span>{next.name}</span>
        </p>
        {next.isFixed && <FixedChip />}
      </div>
      <div className="mt-1.5 grid gap-1">
        <p className="sr-only">次の予定までの移動</p>
        {bases.map((basis) => {
          const source = next.evidence.find(
            (item) =>
              item.subject === 'travel_time' &&
              item.status === basis.kind &&
              (item.source.kind === 'simulation') === basis.simulated,
          )?.source.kind
          const google = source === 'routes' || source === 'places'
          return (
            <div
              key={basis.simulated ? 'demo' : 'real'}
              className={google ? 'rounded border border-[#5E5E5E] bg-white p-1' : undefined}
            >
              <StatusLine kind={basis.kind} simulated={basis.simulated}>
                {basis.text}
              </StatusLine>
              {google && <GoogleMapsAttribution />}
            </div>
          )
        })}
        {bases.some((basis) => basis.simulated) && (
          <p className={`text-xs text-(color:--tp-muted) ${wrapClass}`}>
            「デモ用の想定」は、{simulatedNote}。
          </p>
        )}
        <p className={`text-xs text-(color:--tp-muted) ${wrapClass}`}>
          {gap >= 0
            ? `予定上の間隔：${stopEndTime(current)}の終了から${gap}分`
            : `予定が重なっています：${stopEndTime(current)}の終了より${-gap}分早く始まる予定です`}
        </p>
      </div>
    </>
  )
}

const nodeStyles: Record<StopProgress, string> = {
  visited: 'border-gt-muted bg-gt-muted text-white',
  current: 'border-gt-action bg-gt-action text-white',
  upcoming: 'border-gt-rail bg-gt-paper text-gt-muted',
}

function Route({ stops, currentIndex }: { stops: readonly Stop[]; currentIndex: number }) {
  return (
    <ol aria-label="旅程の進行" className="mt-4">
      {stops.map((stop, index) => {
        const progress = progressOf(index, currentIndex)
        const last = index === stops.length - 1
        return (
          <li
            key={stop.id}
            aria-current={progress === 'current' ? 'step' : undefined}
            className={`relative grid min-h-[76px] grid-cols-[49px_minmax(0,1fr)] ${last ? '' : 'pb-3'}`}
          >
            {!last && (
              <span
                aria-hidden="true"
                className={`absolute -bottom-px left-[14px] top-6 w-[6px] rounded-full ${progress === 'visited' ? 'bg-gt-rail/60' : 'bg-gt-line'}`}
              />
            )}
            <div aria-hidden="true" className="relative z-10 flex items-start gap-[3px] pl-[4px]">
              <span
                data-station-number={stop.isFixed || progress !== 'visited' ? '' : undefined}
                className={`grid size-[26px] shrink-0 place-items-center rounded-full border-[3px] text-[11px] font-bold ${nodeStyles[progress]}`}
              >
                {progress === 'visited' && !stop.isFixed ? <CheckIcon size={14} /> : index + 1}
              </span>
              {stop.isFixed && (
                <span
                  data-fixed-mark
                  className="mt-[6px] grid size-[14px] shrink-0 place-items-center rounded bg-gt-ink text-white"
                >
                  <LockIcon size={10} />
                </span>
              )}
            </div>
            <div className={`${wrapClass} ${progress === 'visited' ? 'text-gt-muted' : ''}`}>
              <p className="text-xs font-semibold text-gt-muted">
                {stop.plannedStartTime}
                <span className="sr-only">
                  〜{stopEndTime(stop)}・{stop.durationMinutes}分
                </span>
              </p>
              <p className="text-xl leading-tight font-bold">{stop.name}</p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5">
                {stop.isFixed && <FixedChip />}
                <ProgressChip progress={progress} />
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
