'use client'

import { useEffect, useState } from 'react'

import type { Trip } from '@/domain'

import { ROUTE_LIST_ID, RouteMap, stopButtonId } from './route-map'
import { setStopFixed, type RouteMeta } from './model'
import { StopSheet } from './stop-sheet'

interface TripRouteViewProps {
  trip: Trip
  meta?: RouteMeta
  // モックデータであることを明示する（実際の店舗・照合結果ではない）。
  mock?: boolean
  // 固定の切り替えなどで旅程が変わったとき、最新のTripを親へ渡す（保存は親の責務）。
  // 親は、受け取ったTripを以後のprops.tripとして渡し続けること。
  onTripChange?: (trip: Trip) => void
  // 部分修正を始める（候補の比較・承認は部分修正の機能の責務）。未指定なら修正の操作は出さない。
  onStartRevision?: (stopId: string) => void
}

// 旅程の一覧（路線図）の表示と、予定の選択・固定の切り替え。
// 固定の切り替えは画面上の状態であり、保存や認可は行わない（保存は#10）。
//
// Tripの同期：表示するTripは、親から渡されたtripを起点にする。固定の切り替えは、ローカルで反映し、
// 最新のTripを`onTripChange`で親へ渡す。**親から渡されるtripの参照が変わったとき**（新しい生成・
// 外部の更新・親が`onTripChange`の値を渡し直したとき）は、ローカルの変更を破棄して親のtripに合わせ、
// 選択中の予定が新しいtripに無ければ選択も解除する。
export function TripRouteView({
  trip: tripProp,
  meta,
  mock = false,
  onTripChange,
  onStartRevision,
}: TripRouteViewProps) {
  const [trip, setTrip] = useState(tripProp)
  const [lastProp, setLastProp] = useState(tripProp)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  // シートを閉じたあとにフォーカスを戻す予定のID。
  const [restoreFocusId, setRestoreFocusId] = useState<string | null>(null)
  // 親のTripの更新で、選択中の予定が無くなり、詳細が閉じた。フォーカスが失われていたら、一覧へ退避する。
  const [rescueFocus, setRescueFocus] = useState(false)

  if (tripProp !== lastProp) {
    // 親のtripが変わった：ローカルの変更を捨てて、親に合わせる（描画中の状態調整）。
    setLastProp(tripProp)
    setTrip(tripProp)
    setNotice('')
    if (selectedId !== null && !tripProp.stops.some((stop) => stop.id === selectedId)) {
      setSelectedId(null)
      setRescueFocus(true)
    }
  }

  // 閉じたあとは、直前に選択していた予定のボタンへフォーカスを戻す（キーボード・読み上げの操作を途切れさせない）。
  useEffect(() => {
    if (restoreFocusId === null) return
    document.getElementById(stopButtonId(restoreFocusId))?.focus()
    setRestoreFocusId(null)
  }, [restoreFocusId])

  // 詳細が開いていたのに、親のTripの更新で閉じられたときは、フォーカスがbodyへ落ちる。
  // その場合だけ、路線図の一覧へフォーカスを移す。利用者が、すでに別の場所へ移していれば、奪わない。
  useEffect(() => {
    if (!rescueFocus) return
    const active = document.activeElement
    if (!active || active === document.body) {
      document.getElementById(ROUTE_LIST_ID)?.focus()
    }
    setRescueFocus(false)
  }, [rescueFocus])

  const selectedIndex = trip.stops.findIndex((stop) => stop.id === selectedId)
  const selected = selectedIndex >= 0 ? trip.stops[selectedIndex] : null

  const toggleFixed = (stopId: string, fixed: boolean) => {
    const next = setStopFixed(trip, stopId, fixed)
    if (!next) return
    setTrip(next)
    onTripChange?.(next)
    const name = next.stops.find((stop) => stop.id === stopId)?.name ?? ''
    setNotice(
      `「${name}」を${fixed ? '固定しました' : '固定解除しました'}。画面上の変更で、まだ保存されていません。`,
    )
  }

  const closeSheet = () => {
    // 別の予定へ切り替えたあとに閉じた場合も、最後に選択していた予定へ戻す。
    setRestoreFocusId(selectedId)
    setSelectedId(null)
  }

  return (
    <div
      className="rounded-2xl bg-gt-bg p-4 pb-6 text-gt-ink"
      style={{ paddingBottom: selected ? '60vh' : undefined }}
    >
      {mock && (
        <p
          role="note"
          className="mb-4 rounded-md border-[1.5px] border-dashed border-gt-unk bg-gt-unk-bg px-3 py-2 text-xs leading-relaxed text-gt-unk"
        >
          <b>モックデータ（架空）</b>
          ：店名・営業時間・照合結果は、画面確認用のサンプルです。実在の情報ではありません。
        </p>
      )}
      <RouteMap trip={trip} meta={meta} selectedStopId={selectedId} onSelectStop={setSelectedId} />
      <p role="status" aria-live="polite" className="mt-3 text-[13px] text-gt-muted">
        {notice}
      </p>
      <p className="mt-2 text-[11.5px] text-gt-muted">
        路線図は旅の順番を表すもので、実際の地図ではありません。
      </p>
      {selected && (
        <StopSheet
          stop={selected}
          index={selectedIndex}
          meta={meta?.[selected.id] ?? {}}
          kind={meta?.[selected.id]?.kind}
          onStartRevision={onStartRevision}
          onToggleFixed={toggleFixed}
          onClose={closeSheet}
        />
      )}
    </div>
  )
}
