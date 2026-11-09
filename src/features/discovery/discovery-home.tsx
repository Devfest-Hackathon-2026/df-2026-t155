'use client'

import Image from 'next/image'
import { useMemo, useState, type ReactNode } from 'react'

import { discoveryDestinations } from './destinations'

export type DiscoveryMode = 'home' | 'bookmarks' | 'records' | 'create'
export interface DiscoveryDraft {
  region: string
  preferences: string
}

interface DiscoveryHomeProps {
  mode: DiscoveryMode
  currentTrip?: { region: string; date: string }
  onOpenHome: () => void
  onResumeTrip?: () => void
  onOpenTrips: () => void
  onOpenRecords: () => void
  onCreate: (draft: DiscoveryDraft) => void
  bookmarksContent?: ReactNode
  recordsContent?: ReactNode
  createContent?: ReactNode
}

export function DiscoveryHome({
  mode,
  currentTrip,
  onOpenHome,
  onResumeTrip,
  onOpenTrips,
  onOpenRecords,
  onCreate,
  bookmarksContent,
  recordsContent,
  createContent,
}: DiscoveryHomeProps) {
  const [query, setQuery] = useState('')
  const [hope, setHope] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ja-JP')
    if (!normalized) return discoveryDestinations
    return discoveryDestinations.filter((destination) =>
      `${destination.title} ${destination.theme} ${destination.region}`
        .toLocaleLowerCase('ja-JP')
        .includes(normalized),
    )
  }, [query])
  const selected = discoveryDestinations.find((destination) => destination.id === selectedId)
  const region = selected?.region ?? query.trim()
  const createFromDraft = () => {
    onCreate({
      region,
      preferences: [selected?.preferences, hope.trim()].filter(Boolean).join('\n'),
    })
  }

  return (
    <div className="gt-discovery-shell" data-discovery-home>
      <div className="flex justify-end pb-2">
        <Image
          src="/brand/groundtrip-logo.png"
          alt="GroundTrip"
          width={100}
          height={80}
          className="h-10 w-auto"
          priority
        />
      </div>
      <div hidden={mode !== 'home'} className="space-y-5 pb-24">
        <h1 className="text-2xl leading-tight font-bold">今日は、どこへ行こう。</h1>

        <button
          type="button"
          className="gt-discovery-hero block w-full text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gt-preview"
          aria-pressed={selectedId === 'castle'}
          onClick={() => setSelectedId('castle')}
          aria-label="名古屋城の写真をテーマに選ぶ"
        >
          <Image
            src="/images/nagoya/castle.webp"
            alt=""
            fill
            priority
            sizes="(max-aspect-ratio: 4/3) 134vh, 100vw"
            className="object-cover"
            style={{ objectPosition: 'center 43%' }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-[#162d2b]/75 via-transparent to-[#162d2b]/5"
          />
          <div className="absolute inset-x-4 bottom-4 text-white [text-shadow:0_1px_8px_rgb(0_0_0/40%)] sm:inset-x-6 sm:bottom-6">
            <p className="text-sm font-semibold tracking-wide">旅を見つける、つくる、楽しむ</p>
            <p className="mt-1 text-2xl font-bold">名古屋を、歩いてみよう。</p>
          </div>
          {selectedId === 'castle' && (
            <span className="absolute right-3 top-3 rounded-full bg-white px-3 py-1 text-xs font-bold text-gt-ink">
              選択中
            </span>
          )}
        </button>

        <div className="space-y-1">
          <label htmlFor="discovery-search" className="block text-sm font-semibold">
            行き先やテーマを探す
          </label>
          <input
            id="discovery-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedId(null)
            }}
            placeholder="名古屋城・熱田・栄"
            className="gt-field min-h-12 px-4"
            autoComplete="off"
          />
        </div>

        <section aria-labelledby="discovery-themes-heading" className="space-y-2">
          <div className="flex items-end justify-between gap-3">
            <h2 id="discovery-themes-heading" className="text-lg font-bold">
              名古屋のおすすめ
            </h2>
            <p className="text-xs text-gt-muted">写真は旅のテーマ例です</p>
          </div>
          {filtered.length > 0 ? (
            <div className="flex snap-x gap-3 overflow-x-auto pb-2">
              {filtered.map((destination) => (
                <button
                  type="button"
                  key={destination.id}
                  aria-pressed={selectedId === destination.id}
                  onClick={() => setSelectedId(destination.id)}
                  className="gt-discovery-theme group min-h-11 shrink-0 snap-start overflow-hidden rounded-2xl border-2 border-transparent bg-white text-left shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview aria-pressed:border-gt-action"
                >
                  <span className="relative block aspect-[4/3] overflow-hidden">
                    <Image
                      src={destination.image}
                      alt={destination.imageAlt}
                      fill
                      sizes="(max-width: 640px) 72vw, 18rem"
                      className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                    />
                    {selectedId === destination.id && (
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
            <p className="rounded-xl bg-white p-3 text-sm text-gt-muted">
              写真テーマは見つかりません。入力した地域名で旅程づくりへ進めます。
            </p>
          )}
          <p className="text-xs leading-relaxed text-gt-muted">
            写真はテーマのイメージです。訪問先は旅程の提案後に確認・選択できます。
          </p>
        </section>

        <section aria-labelledby="discovery-hope-heading" className="gt-card space-y-3">
          <div>
            <h2 id="discovery-hope-heading" className="text-base font-bold">
              どんな旅にしたい？
            </h2>
            <p className="mt-1 text-xs text-gt-muted">旅行先や日付は、次の画面で確認できます。</p>
          </div>
          <label htmlFor="discovery-hope" className="sr-only">
            旅の希望（任意）
          </label>
          <textarea
            id="discovery-hope"
            value={hope}
            onChange={(event) => setHope(event.target.value)}
            rows={2}
            placeholder="例：ゆっくり歩きたい、喫茶店に寄りたい"
            className="gt-field px-3 py-3"
          />
          <button type="button" className="gt-button-primary w-full" onClick={createFromDraft}>
            旅の条件へ進む
          </button>
        </section>

        <button
          type="button"
          className="w-full rounded-xl px-4 py-3 text-left text-sm font-semibold text-gt-action underline underline-offset-4"
          onClick={onOpenTrips}
        >
          保存した旅程を開く
        </button>
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
      </div>

      <section hidden={mode !== 'bookmarks'} className="min-h-[55vh] space-y-4 pb-24">
        <h1 className="gt-screen-title">しおり</h1>
        <p className="text-sm text-gt-muted">自分で保存した旅程を開けます。</p>
        {bookmarksContent}
      </section>

      <section hidden={mode !== 'records'} className="min-h-[55vh] space-y-4 pb-24">
        <h1 className="gt-screen-title">記録</h1>
        <p className="text-sm text-gt-muted">
          保存した旅を振り返り、次の旅に活かす学びを確認できます。
        </p>
        {mode === 'records' && recordsContent}
      </section>

      <section hidden={mode !== 'create'} className="space-y-4 pb-24">
        <button type="button" onClick={onOpenHome} className="gt-button-secondary">
          写真から探す
        </button>
        {createContent}
      </section>

      <nav
        aria-label="メインナビゲーション"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-gt-rule bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgb(25_29_32/8%)] backdrop-blur"
      >
        <div className="mx-auto grid max-w-xl grid-cols-3">
          <button
            type="button"
            aria-current={mode === 'home' ? 'page' : undefined}
            onClick={onOpenHome}
            className="min-h-14 px-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-gt-preview aria-[current=page]:text-gt-action"
          >
            ホーム
          </button>
          <button
            type="button"
            aria-current={mode === 'bookmarks' ? 'page' : undefined}
            onClick={onOpenTrips}
            className="min-h-14 px-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-gt-preview aria-[current=page]:text-gt-action"
          >
            しおり
          </button>
          <button
            type="button"
            aria-current={mode === 'records' ? 'page' : undefined}
            onClick={onOpenRecords}
            className="min-h-14 px-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-gt-preview aria-[current=page]:text-gt-action"
          >
            記録
          </button>
        </div>
      </nav>
    </div>
  )
}
