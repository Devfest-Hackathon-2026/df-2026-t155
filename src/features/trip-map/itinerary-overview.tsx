import { useState } from 'react'

import type { Trip } from '@/domain'
import { GoogleMapsSourceBox } from '@/features/legal/google-maps-attribution'
import { summarizeVerification } from '@/features/trip-verification/verification-summary'

import { isGoogleSource } from './model'

interface ItineraryOverviewProps {
  trip: Trip
  onSelectStop: (stopId: string, trigger: HTMLButtonElement) => void
}

export function ItineraryOverview({ trip, onSelectStop }: ItineraryOverviewProps) {
  const [expanded, setExpanded] = useState(false)
  const summary = summarizeVerification(trip)
  const fixedCount = trip.stops.filter((stop) => stop.isFixed).length
  const noEvidenceCount = trip.stops.filter((stop) => stop.evidence.length === 0).length

  return (
    <section
      aria-label="旅程の根拠"
      className="gt-itinerary-overview mb-4 min-w-0 rounded-xl border border-gt-rule bg-gt-paper p-3 sm:p-4"
    >
      <h2 className="text-base font-bold">旅程の根拠</h2>
      <p className="mt-1 text-sm text-gt-muted">固定予定：{fixedCount}件</p>
      <p className="mt-1 text-xs text-gt-muted">
        以下の件数は根拠の数です。旅程の全項目の照合完了を示すものではありません。
      </p>
      {summary.google.total > 0 ? (
        <GoogleMapsSourceBox caption="Google Maps由来の根拠" compact>
          <p>根拠：{summary.google.total}件</p>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <li>情報源と整合 {summary.google.counts.consistent}件</li>
            <li>矛盾あり {summary.google.counts.conflicting}件</li>
            <li>確認できない {summary.google.counts.unverifiable}件</li>
          </ul>
        </GoogleMapsSourceBox>
      ) : (
        <p className="mt-2 rounded-md border border-gt-rule bg-white p-2 text-sm">
          現在の旅程にはGoogle Mapsの照合結果がありません
        </p>
      )}
      <p className="mt-2 text-sm text-gt-muted">根拠なしの予定：{noEvidenceCount}件</p>
      {summary.otherTotal > 0 && (
        <p className="mt-1 text-sm text-gt-muted">Google Maps以外の根拠：{summary.otherTotal}件</p>
      )}
      <button
        type="button"
        className="mt-2 min-h-11 text-sm font-semibold text-gt-line-strong underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? '予定ごとの根拠を閉じる' : '予定ごとの根拠を見る'}
      </button>
      {expanded && (
        <ol className="mt-2 grid min-w-0 gap-2">
          {trip.stops.map((stop, index) => {
            const googleCount = stop.evidence.filter((item) =>
              isGoogleSource(item.source.kind),
            ).length
            const otherCount = stop.evidence.length - googleCount
            const evidenceSummary =
              stop.evidence.length === 0
                ? '根拠なし'
                : `Google Mapsの根拠${googleCount}件・その他の根拠${otherCount}件`
            return (
              <li key={stop.id} className="min-w-0 rounded-lg border border-gt-rule bg-white p-2">
                <button
                  type="button"
                  className="min-h-11 w-full min-w-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview"
                  onClick={(event) => onSelectStop(stop.id, event.currentTarget)}
                >
                  <span className="block text-xs text-gt-muted">
                    {stop.plannedStartTime}・{index + 1}番目
                  </span>
                  <span className="block wrap-anywhere font-semibold">
                    {stop.name}
                    {stop.isFixed ? '・固定予定' : ''}
                  </span>
                  <span className="block text-xs text-gt-muted">{evidenceSummary}</span>
                  <span className="sr-only">根拠・詳細を見る</span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
