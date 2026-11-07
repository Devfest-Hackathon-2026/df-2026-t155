'use client'

import { useState } from 'react'

import type { Stop, Trip } from '@/domain'

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
import { CheckIcon, FixedChip, ProgressChip, StatusLine } from './progress-parts'

interface TripProgressViewProps {
  trip: Trip
  // 最初に「いまの予定」とする位置（0始まり）。省略時は最初の予定。範囲外は範囲内に収める。
  initialIndex?: number
  // 再計画の入口。渡されたときだけ、変更ボタンを表示する（未実装の操作を見せない）。
  onReplan?: (stopId: string) => void
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
const cardBase = 'rounded-xl border-2 p-4'
const buttonBase =
  'inline-flex min-h-11 w-full items-center justify-center rounded-lg border-2 px-4 py-2 text-center text-base font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-(color:--tp-ink)'

const formatStopLabel = (stop: Stop) => `${stop.name}（${stop.plannedStartTime}）`

// 旅行中の画面：いまの予定と次の予定、縦の路線、手動の進行操作。
// 位置情報・現在時刻は使わない。進行状況は、本人のボタン操作だけで更新する。
export function TripProgressView({ trip, initialIndex = 0, onReplan }: TripProgressViewProps) {
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

  if (!current) {
    return (
      <section
        style={paletteStyle}
        aria-label="旅行中の進行状況"
        className="mx-auto w-full max-w-xl bg-(color:--tp-page) p-4 text-(color:--tp-ink)"
      >
        <p className="text-sm">表示できる予定がありません。</p>
      </section>
    )
  }

  const announce = (message: string, index: number) =>
    setState((prev) => ({ ...prev, index, notice: message, tick: prev.tick + 1 }))

  const handleForward = () => {
    const result = stepForward(currentIndex, stops.length)
    if (!result.moved) {
      announce('旅程の最後です。これ以上は進めません。', result.index)
      return
    }
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
    <section
      style={paletteStyle}
      aria-labelledby="trip-progress-heading"
      className="mx-auto w-full max-w-xl bg-(color:--tp-page) p-4 text-(color:--tp-ink)"
    >
      <h2 id="trip-progress-heading" className="text-xl font-black">
        旅行中の進行状況
      </h2>
      <p className={`mt-1 text-sm text-(color:--tp-muted) ${wrapClass}`}>
        位置情報は使っていません。進行状況は、ボタンで更新します。この状況は保存されません。
      </p>

      <CurrentCard stop={current} onReplan={onReplan} />
      <NextCard current={current} next={next} />

      <div role="group" aria-label="進行状況の更新" className="mt-4 grid gap-3">
        <button
          type="button"
          onClick={handleForward}
          className={`${buttonBase} border-(color:--tp-accent) bg-(color:--tp-accent) text-white`}
        >
          次の予定へ進む
        </button>
        <button
          type="button"
          onClick={handleBack}
          className={`${buttonBase} border-(color:--tp-edge) bg-(color:--tp-card) text-(color:--tp-ink)`}
        >
          ひとつ前に戻す
        </button>
      </div>

      {/* 操作の結果を、常設のライブリージョンで伝える。フォーカスは押したボタンに残す。 */}
      <p
        role="status"
        className={`mt-3 min-h-6 border-l-4 border-(color:--tp-edge) pl-3 text-sm font-bold ${wrapClass}`}
      >
        {/* 更新のたびに中の要素を作り直し、同じ文言でもテキスト内容の更新として通知させる。 */}
        <span key={view.tick}>{view.notice}</span>
      </p>

      <Route stops={stops} currentIndex={currentIndex} />
    </section>
  )
}

function CurrentCard({ stop, onReplan }: { stop: Stop; onReplan?: (stopId: string) => void }) {
  const lines = evidenceLines(stop)
  return (
    <section
      aria-labelledby="trip-progress-current"
      className={`${cardBase} mt-4 border-(color:--tp-accent) bg-(color:--tp-tint)`}
    >
      <h3 id="trip-progress-current" className="text-sm font-black text-(color:--tp-accent)">
        いまの予定
      </h3>
      {stop.isFixed && (
        <p className="mt-2">
          <FixedChip />
        </p>
      )}
      <p className="mt-2 font-mono text-sm font-semibold text-(color:--tp-muted)">
        {stop.plannedStartTime}〜{stopEndTime(stop)}・滞在{stop.durationMinutes}分
      </p>
      <p className={`text-2xl font-black leading-snug ${wrapClass}`}>{stop.name}</p>
      <ul aria-label="根拠の状態" className="mt-3 grid gap-1.5">
        {lines.length === 0 ? (
          <li>
            <StatusLine kind="unchecked">根拠：未照合（まだ確認していません）</StatusLine>
          </li>
        ) : (
          lines.map((line) => (
            <li key={`${line.subject}-${line.simulated ? 'demo' : 'real'}`}>
              <StatusLine
                kind={line.status}
                simulated={line.simulated}
              >{`${line.subjectLabel}：${line.statusLabel}`}</StatusLine>
            </li>
          ))
        )}
      </ul>
      {lines.some((line) => line.simulated) && (
        <p className={`mt-1.5 text-xs text-(color:--tp-muted) ${wrapClass}`}>
          「デモ用の想定」は、{simulatedNote}。
        </p>
      )}
      {onReplan &&
        (stop.isFixed ? (
          <p className={`mt-3 text-sm text-(color:--tp-muted) ${wrapClass}`}>
            固定予定のため、固定を解除するまで、変更の対象にできません。
          </p>
        ) : (
          <button
            type="button"
            onClick={() => onReplan(stop.id)}
            className={`${buttonBase} mt-3 border-(color:--tp-ink) bg-(color:--tp-card) text-(color:--tp-ink)`}
          >
            予定が変わった？この予定だけ変更する
          </button>
        ))}
    </section>
  )
}

function NextCard({ current, next }: { current: Stop; next: Stop | undefined }) {
  return (
    <section
      aria-labelledby="trip-progress-next"
      className={`${cardBase} mt-3 border-(color:--tp-edge) bg-(color:--tp-card)`}
    >
      <h3 id="trip-progress-next" className="text-sm font-black text-(color:--tp-muted)">
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
      {next.isFixed && (
        <p className="mt-2">
          <FixedChip />
        </p>
      )}
      <p className="mt-2 font-mono text-sm font-semibold text-(color:--tp-muted)">
        {next.plannedStartTime}から
      </p>
      <p className={`text-xl font-black leading-snug ${wrapClass}`}>{next.name}</p>
      <div className="mt-3 grid gap-1.5">
        <p className="text-xs font-bold text-(color:--tp-muted)">次の予定までの移動</p>
        {bases.map((basis) => (
          <StatusLine
            key={basis.simulated ? 'demo' : 'real'}
            kind={basis.kind}
            simulated={basis.simulated}
          >
            {basis.text}
          </StatusLine>
        ))}
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
  visited: 'border-(color:--tp-edge) bg-(color:--tp-visited) text-(color:--tp-muted)',
  current: 'border-(color:--tp-accent) bg-(color:--tp-accent) text-white',
  upcoming: 'border-(color:--tp-edge) bg-(color:--tp-card) text-(color:--tp-muted)',
}

const itemStyles: Record<StopProgress, string> = {
  visited: 'border-(color:--tp-edge) bg-(color:--tp-visited) text-(color:--tp-muted)',
  current: 'border-(color:--tp-accent) bg-(color:--tp-tint)',
  upcoming: 'border-(color:--tp-edge) bg-(color:--tp-card)',
}

// 縦の路線。訪問済み＝グレー、いま＝オレンジ、先＝グレーの枠線。訪問順の模式図で、地図ではない。
function Route({ stops, currentIndex }: { stops: readonly Stop[]; currentIndex: number }) {
  return (
    <div className="mt-6">
      <h3 className="text-base font-black">今日の路線</h3>
      <p className={`mt-1 text-xs text-(color:--tp-muted) ${wrapClass}`}>
        訪問順を示す模式図です。地図上の位置ではありません。
      </p>
      <ol aria-label="旅程の進行" className="mt-3">
        {stops.map((stop, index) => {
          const progress = progressOf(index, currentIndex)
          const last = index === stops.length - 1
          return (
            <li
              key={stop.id}
              aria-current={progress === 'current' ? 'step' : undefined}
              className={`relative flex gap-3 ${last ? '' : 'pb-4'}`}
            >
              {!last && (
                <span
                  aria-hidden="true"
                  className={`absolute bottom-0 left-[18px] top-10 w-0 border-l-[3px] ${
                    progress === 'current'
                      ? 'border-(color:--tp-accent)'
                      : progress === 'visited'
                        ? 'border-(color:--tp-edge)'
                        : 'border-dashed border-(color:--tp-edge)'
                  }`}
                />
              )}
              <span
                aria-hidden="true"
                className={`relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border-2 font-mono text-sm font-black ${nodeStyles[progress]}`}
              >
                {progress === 'visited' ? <CheckIcon size={18} /> : index + 1}
              </span>
              <div
                className={`${wrapClass} flex-1 rounded-lg border-2 p-3 ${itemStyles[progress]}`}
              >
                <p className="flex flex-wrap items-center gap-1.5">
                  <ProgressChip progress={progress} />
                  {stop.isFixed && <FixedChip />}
                </p>
                <p className="mt-1.5 font-mono text-sm font-semibold">
                  {stop.plannedStartTime}〜{stopEndTime(stop)}・{stop.durationMinutes}分
                </p>
                <p className="text-base font-black leading-snug">{stop.name}</p>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
