'use client'

import Image from 'next/image'
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'

import type { TripDraftChanges, TripDraftEdits } from '@/features/trip-planner/form-model'

import { discoveryDestinations, type DiscoveryDestination } from './destinations'

export type DiscoveryMode = 'home' | 'bookmarks' | 'records' | 'create'

interface DiscoveryHomeProps {
  mode: DiscoveryMode
  headingRef?: Ref<HTMLHeadingElement>
  detailEdits?: TripDraftEdits
  currentTrip?: { region: string; date: string }
  onOpenHome: (keyboard: boolean) => void
  onResumeTrip?: () => void
  onOpenTrips: (keyboard: boolean) => void
  onCreate: (draft: TripDraftChanges) => void
  bookmarksContent?: ReactNode
  recordsContent?: ReactNode
  createContent?: ReactNode
}

export function DiscoveryHome({
  mode,
  headingRef,
  detailEdits,
  currentTrip,
  onOpenHome,
  onResumeTrip,
  onOpenTrips,
  onCreate,
  bookmarksContent,
  recordsContent,
  createContent,
}: DiscoveryHomeProps) {
  const [manualRegion, setManualRegion] = useState('')
  const [photoRegion, setPhotoRegion] = useState<{ region: string; explicit: boolean } | null>(null)
  const [hope, setHope] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<DiscoveryDestination | null>(null)
  // 前回渡したホームの値を基準に、ここで変更した項目だけを渡す。
  const lastSubmitted = useRef({ region: '', preferences: '' })
  const appliedDetails = useRef<TripDraftEdits | undefined>(undefined)
  const region = photoRegion?.region ?? manualRegion

  useEffect(() => {
    const previous = appliedDetails.current
    appliedDetails.current = detailEdits
    if (detailEdits?.region && detailEdits.region !== previous?.region) {
      setManualRegion(detailEdits.region.value)
      setPhotoRegion(null)
      lastSubmitted.current.region = detailEdits.region.value.trim()
    }
    if (detailEdits?.preferences && detailEdits.preferences !== previous?.preferences) {
      const value = detailEdits.preferences.value.trim()
      const theme = selected?.preferences
      if (theme && (value === theme || value.startsWith(`${theme}\n`))) {
        const text = value.slice(theme.length).trim()
        setHope(text)
        lastSubmitted.current.preferences = [theme, text].filter(Boolean).join('\n')
      } else {
        setHope(value)
        setSelected(null)
        lastSubmitted.current.preferences = value
      }
    }
  }, [detailEdits, selected])

  const normalized = query.trim().toLocaleLowerCase('ja-JP')
  const filtered = discoveryDestinations.filter((destination) =>
    `${destination.title} ${destination.theme} ${destination.region}`
      .toLocaleLowerCase('ja-JP')
      .includes(normalized),
  )
  const selectTheme = (theme: DiscoveryDestination | null) => {
    if (selected === theme) return
    setSelected(theme)
    if (theme === null) setPhotoRegion(null)
    else if (!photoRegion?.explicit && manualRegion.trim() === '')
      setPhotoRegion({ region: theme.region, explicit: false })
  }

  return (
    <div>
      <div hidden={mode !== 'home'} data-discovery-landing className="space-y-6">
        <div className="mx-auto max-w-xl space-y-4">
          <h1
            ref={mode === 'home' ? headingRef : undefined}
            tabIndex={-1}
            className="text-2xl leading-tight font-bold"
          >
            今日は、どこへ行こう。
          </h1>
          <form
            className="gt-card space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              const next = {
                region: region.trim(),
                preferences: [selected?.preferences, hope.trim()].filter(Boolean).join('\n'),
              }
              const previous = lastSubmitted.current
              const changes: TripDraftChanges = {}
              if (next.region !== previous.region) changes.region = next.region
              if (next.preferences !== previous.preferences) changes.preferences = next.preferences
              lastSubmitted.current = next
              onCreate(changes)
            }}
          >
            <div className="space-y-1">
              <label htmlFor="discovery-region" className="block text-sm font-semibold">
                行き先
              </label>
              <input
                id="discovery-region"
                type="text"
                value={region}
                onChange={(event) => {
                  setManualRegion(event.target.value)
                  setPhotoRegion(null)
                }}
                placeholder="例：京都市東山区、奈良市"
                className="gt-field min-h-12 px-3"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="discovery-hope" className="block text-sm font-semibold">
                旅の希望（任意）
              </label>
              <textarea
                id="discovery-hope"
                value={hope}
                onChange={(event) => setHope(event.target.value)}
                rows={2}
                placeholder="例：ゆっくり歩きたい、喫茶店に寄りたい"
                className="gt-field px-3 py-2"
              />
            </div>
            {selected && (
              <div className="flex flex-wrap items-center gap-x-3 text-sm text-gt-muted">
                <p>写真から選んだテーマ：{selected.theme}</p>
                {region.trim() !== selected.region && (
                  <button
                    type="button"
                    className="min-h-11 underline underline-offset-2"
                    onClick={() => setPhotoRegion({ region: selected.region, explicit: true })}
                  >
                    {selected.region}を行き先に使う
                  </button>
                )}
                <button
                  type="button"
                  className="min-h-11 underline underline-offset-2"
                  onClick={() => selectTheme(null)}
                >
                  テーマを外す
                </button>
              </div>
            )}
            {!selected && photoRegion && (
              <div className="flex flex-wrap items-center gap-x-3 text-sm text-gt-muted">
                <p>写真から採用した行き先：{photoRegion.region}</p>
                <button
                  type="button"
                  className="min-h-11 underline underline-offset-2"
                  onClick={() => setPhotoRegion(null)}
                >
                  写真の行き先を解除
                </button>
              </div>
            )}
            <p className="text-xs text-gt-muted">
              次の画面で日付や詳しい条件を設定できます。入力済みの条件には、ここで変更した項目だけを反映します。
            </p>
            <button type="submit" className="gt-button-primary w-full">
              旅の条件へ進む
            </button>
          </form>

          {currentTrip && onResumeTrip && (
            <button
              type="button"
              className="gt-card w-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
              onClick={onResumeTrip}
            >
              <span className="block text-sm font-bold">現在の旅程を開く</span>
              <span className="mt-1 block text-sm text-gt-muted">
                {currentTrip.region}・{currentTrip.date}
              </span>
            </button>
          )}
          <button
            type="button"
            className="min-h-11 rounded-lg px-2 text-left text-sm font-semibold text-gt-action underline underline-offset-4"
            onClick={(event) => onOpenTrips(event.detail === 0)}
          >
            保存した旅程を開く
          </button>
        </div>

        <section aria-labelledby="discovery-themes-heading" className="space-y-2">
          <h2 id="discovery-themes-heading" className="text-lg font-bold">
            写真から旅のテーマを探す（任意）
          </h2>
          <p className="text-sm text-gt-muted">
            名古屋の写真からテーマを選ぶと、行き先と旅の希望に反映できます。
          </p>
          <div className="space-y-1 sm:max-w-sm">
            <label htmlFor="discovery-search" className="block text-sm font-semibold">
              写真テーマを絞り込む
            </label>
            <input
              id="discovery-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例：名古屋城、熱田、栄"
              className="gt-field min-h-11 px-3"
              autoComplete="off"
            />
          </div>
          {filtered.length > 0 ? (
            <div className="flex snap-x gap-3 overflow-x-auto p-1 lg:grid lg:grid-cols-3 lg:overflow-visible">
              {filtered.map((destination) => (
                <button
                  type="button"
                  key={destination.id}
                  aria-label={`${destination.title}の写真をテーマに選ぶ（${destination.theme}）`}
                  aria-pressed={selected === destination}
                  onClick={() => selectTheme(destination)}
                  className="gt-discovery-theme group min-h-11 min-w-0 shrink-0 snap-start overflow-hidden rounded-2xl border-2 border-transparent bg-white text-left shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview aria-pressed:border-gt-action"
                >
                  <span className="relative block aspect-[4/3] overflow-hidden">
                    <Image
                      src={destination.image}
                      alt={destination.imageAlt}
                      fill
                      sizes="(max-width: 400px) 72vw, 18rem"
                      className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                    />
                    {selected === destination && (
                      <span className="absolute right-2 top-2 rounded-full bg-white px-2 py-1 text-xs font-bold text-gt-ink">
                        選択中
                      </span>
                    )}
                  </span>
                  <span className="block p-3">
                    <span className="block text-xs font-semibold text-gt-action">
                      {destination.theme}
                    </span>
                    <span className="mt-0.5 block font-bold">{destination.title}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p role="status" className="text-sm text-gt-muted">
              一致する写真テーマはありません。行き先を入力して旅の条件へ進めます。
            </p>
          )}
          <p className="text-xs leading-relaxed text-gt-muted">
            写真はテーマのイメージです。訪問先は旅程の提案後に確認・選択できます。
          </p>
        </section>
      </div>

      <section hidden={mode !== 'bookmarks'} className="min-h-[55vh] space-y-4">
        <h1
          ref={mode === 'bookmarks' ? headingRef : undefined}
          tabIndex={-1}
          className="gt-screen-title"
        >
          しおり
        </h1>
        <p className="text-sm text-gt-muted">自分で保存した旅程を開けます。</p>
        {bookmarksContent}
      </section>

      <section hidden={mode !== 'records'} className="min-h-[55vh] space-y-4">
        <h1
          ref={mode === 'records' ? headingRef : undefined}
          tabIndex={-1}
          className="gt-screen-title"
        >
          記録
        </h1>
        <p className="text-sm text-gt-muted">
          保存した旅を振り返り、次の旅に活かす学びを確認できます。
        </p>
        {mode === 'records' && recordsContent}
      </section>

      <section hidden={mode !== 'create'} className="space-y-4">
        <button
          type="button"
          onClick={(event) => onOpenHome(event.detail === 0)}
          className="gt-button-secondary"
        >
          ホームの入力へ戻る
        </button>
        {createContent}
      </section>
    </div>
  )
}
