import { revisionTargetRestriction, type Stop, type Trip } from '@/domain'
import { GoogleMapsAttribution } from '@/features/legal/google-maps-attribution'

import { EvidenceBadge, UnverifiedBadge } from './evidence-badge'
import { segmentEvidence, type SegmentEvidenceItem } from './evidence-scope'
import { LockIcon } from './icons'
import { evidenceStatusLabels } from '@/domain'

import {
  endTime,
  evidenceSubjectLabels,
  routeStopKind,
  stopKindLabels,
  worstEvidence,
  type RouteMeta,
  type RouteStopMeta,
  type StopKind,
  type RouteSegmentLabel,
} from './model'

interface RouteMapProps {
  trip: Trip
  meta?: RouteMeta
  selectedStopId?: string | null
  onSelectStop?: (stopId: string) => void
  onReviseStop?: (stopId: string) => void
  preview?: { stop: Stop; label: string; revisionId: string }
  appliedStopId?: string
  idPrefix?: string
}

// 予定のボタンのid。詳細シートを閉じたあとのフォーカスの復帰先に使う。
export const stopButtonId = (stopId: string) => `stop-button-${stopId}`
export function focusRouteStop(stopId: string) {
  const button = document.getElementById(stopButtonId(stopId))
  button?.focus({ preventScroll: true })
  button?.scrollIntoView?.({ block: 'center' })
}

export const reviseButtonId = (stopId: string) => `revise-button-${stopId}`

// 路線図の一覧のid。選択中の予定が（親のTripの更新で）無くなったとき、フォーカスの退避先に使う。
export const ROUTE_LIST_ID = 'trip-route-list'

const NODE_CENTER_Y = 22

// 駅番号に、固定を表す鍵を重ねる。
function Node({
  stop,
  index,
  muted,
  center,
}: {
  stop: Stop
  index: number
  muted: boolean
  center: number
}) {
  return (
    <>
      <span
        aria-hidden="true"
        data-station-number
        style={{ top: center - 13 }}
        className={`absolute left-[5px] grid size-[27px] place-items-center rounded-full border-[3px] bg-gt-paper text-xs font-bold ${muted || stop.isFixed ? 'border-gt-ink' : 'border-gt-line'}`}
      >
        {index + 1}
      </span>
      {stop.isFixed && (
        <span
          aria-hidden="true"
          data-fixed-mark
          style={{ top: center - 7 }}
          className="absolute left-[34px] grid size-3.5 place-items-center rounded bg-gt-ink text-white"
        >
          <LockIcon size={10} />
        </span>
      )}
    </>
  )
}

export function FixedChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-gt-ink bg-gt-paper px-2 py-0.5 text-[11px] leading-tight font-bold text-gt-ink">
      <LockIcon size={11} />
      固定予定
    </span>
  )
}

function Evidence({ stop }: { stop: Stop }) {
  const worst = worstEvidence(stop.evidence)
  const google = worst?.source.kind === 'places' || worst?.source.kind === 'routes'
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {stop.manualRevisionId && (
        <span className="text-xs font-bold text-gt-ink">本人の確認で採用</span>
      )}
      {worst ? (
        google ? (
          <span className="inline-flex flex-wrap items-center gap-1 rounded border border-[#5E5E5E] bg-white p-1">
            <EvidenceBadge evidence={worst} />
            <GoogleMapsAttribution />
          </span>
        ) : (
          <EvidenceBadge evidence={worst} />
        )
      ) : (
        <UnverifiedBadge
          subject={stop.kind === 'meal' ? '営業時間' : stop.kind === 'sight' ? '施設' : undefined}
        />
      )}
      {stop.evidence.length > 1 && (
        <span className="text-xs text-gt-muted">ほか{stop.evidence.length - 1}件</span>
      )}
    </span>
  )
}

// 移動区間のラベル。構造化された区間（分数）があればそれを出し、なければ区間についての根拠の「状態」だけを出す。
// 区間についての根拠は、segmentEvidence（前の予定 → 次の予定の方向が合うRoutes由来の根拠だけ）が決める。
// 詳細シートの「前の地点から」も、同じ判定に従う。区間を特定できない根拠は、使わない（未確認として扱う）。
// 所要時間・距離などRoutesが返す値は、取得していないので推測も表示もしない（詳細シートの表記と同じ）。
// 「整合」は、確認できた情報と一致したという意味で、移動が実際に間に合う保証ではない。
// 現在の照合APIは徒歩だけを確認する（docs/TRIP_VERIFICATION.md）。車などを照合するようになったら、手段を根拠から取り直す。
function SegmentLabel({
  segment,
  evidence,
}: {
  segment?: RouteSegmentLabel
  evidence: readonly SegmentEvidenceItem[]
}) {
  const travelEvidence = worstEvidence(evidence.map((item) => item.evidence))
  let text = '次の地点まで：移動時間は未確認'
  if (segment?.status === 'known') {
    text = `次の地点まで：${segment.mode === 'walk' ? '徒歩' : '車'}${segment.minutes}分`
  } else if (travelEvidence?.status === 'consistent') {
    text = '次の地点まで：徒歩移動は情報源と整合（所要時間の数値は取得していません）'
  } else if (travelEvidence?.status === 'conflicting') {
    text = '次の地点まで：徒歩移動の条件に矛盾あり'
  } else if (travelEvidence?.status === 'unverifiable') {
    text = '次の地点まで：徒歩移動を確認できません'
  }
  return (
    <p
      className={`mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-gt-muted ${travelEvidence ? 'rounded border border-[#5E5E5E] bg-white p-1' : ''}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 4v15M6 13l6 6 6-6" />
      </svg>
      <span className="min-w-0">
        <span className="block text-[11px]">次の予定までの移動</span>
        <span className="block font-semibold">{text}</span>
        {travelEvidence && <GoogleMapsAttribution />}
      </span>
    </p>
  )
}

const stopDetailsLabel = '根拠・詳細を見る'

function StopDetailsCue() {
  return (
    <span
      aria-hidden="true"
      className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-gt-line-strong underline underline-offset-2"
    >
      {stopDetailsLabel}
      <svg
        className="size-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </span>
  )
}

function StopCard({
  stop,
  index,
  meta,
  kind,
  selected,
  onSelect,
  onRevise,
}: {
  stop: Stop
  index: number
  meta: RouteStopMeta
  kind: StopKind
  selected?: boolean
  onSelect?: () => void
  onRevise?: () => void
}) {
  const worst = worstEvidence(stop.evidence)
  // 読み上げでも、時刻・滞在時間・固定の有無・根拠の代表状態が分かるようにする。
  const evidenceLabel = worst
    ? `${evidenceSubjectLabels[worst.subject]}：${evidenceStatusLabels[worst.status]}`
    : '未照合'
  const label = `${stop.plannedStartTime}から${stop.durationMinutes}分 ${stop.name}${stop.isFixed ? '（固定予定）' : ''}、${stop.manualRevisionId ? '本人の確認で採用、' : ''}${evidenceLabel}。${stopDetailsLabel}`
  const selectedRing = selected ? 'outline outline-[3px] outline-offset-2 outline-gt-muted' : ''
  const Card = onSelect ? 'button' : 'div'
  const buttonProps = onSelect
    ? {
        id: stopButtonId(stop.id),
        type: 'button' as const,
        onClick: onSelect,
        'aria-label': label,
        'aria-pressed': selected,
      }
    : {}
  // チケットにするかは、予定の「種類」だけで決める（食事・要予約）。固定かどうかでは変えない。
  const isTicket = kind === 'meal' || kind === 'reserved'
  const number = index + 1

  if (!isTicket) {
    return (
      <Card
        {...buttonProps}
        data-variant="station"
        data-kind={kind}
        className={`gt-itinerary-stop-card gt-itinerary-stop-card--station min-h-11 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview ${selectedRing}`}
      >
        <span className="gt-itinerary-stop-content">
          <span aria-hidden="true" className="block text-lg font-semibold text-gt-muted">
            {stop.plannedStartTime}
          </span>
          <span className="sr-only">
            {stop.plannedStartTime}〜{endTime(stop)}・{stop.durationMinutes}分
          </span>
          <span className="block text-xl leading-tight font-bold wrap-anywhere">{stop.name}</span>
          <span className="mt-1 block text-xs text-gt-muted">
            滞在約{stop.durationMinutes}分（予定）
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-2">
            {stop.isFixed && <FixedChip />}
            <Evidence stop={stop} />
          </span>
          {onSelect && <StopDetailsCue />}
        </span>
        <TicketStub index={number} isFixed={stop.isFixed} />
      </Card>
    )
  }

  return (
    <div
      data-variant="ticket"
      data-kind={kind}
      className={`gt-food-ticket gt-itinerary-stop-card ${selectedRing}`}
    >
      <Card
        {...buttonProps}
        data-variant="ticket"
        className="gt-itinerary-stop-content block w-full rounded-[13px] text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gt-preview"
      >
        <span className="flex flex-wrap items-center justify-between gap-x-2">
          <span className="text-lg leading-tight font-bold">{stop.plannedStartTime}</span>
          <span className="rounded-sm border border-current bg-white px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-gt-line-strong">
            {stopKindLabels[kind]}
          </span>
        </span>
        <span className="mt-1.5 block text-base leading-snug font-bold wrap-anywhere">
          {stop.name}
        </span>
        <span className="sr-only">
          {stop.plannedStartTime}〜{endTime(stop)}・{stop.durationMinutes}分
        </span>
        <span className="mt-1 block text-xs text-gt-muted">
          {stopKindLabels[kind]}・滞在約{stop.durationMinutes}分（予定）
          {meta.price ? `・${meta.price}` : ''}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-2">
          {stop.isFixed && <FixedChip />}
          <Evidence stop={stop} />
        </span>
        {onSelect && <StopDetailsCue />}
      </Card>
      <TicketStub index={number} isFixed={stop.isFixed} />
      {onRevise && (
        <div className="gt-itinerary-ticket-action">
          <button
            id={reviseButtonId(stop.id)}
            type="button"
            onClick={onRevise}
            className="min-h-11 w-full text-left text-xs font-bold text-gt-line-strong focus-visible:outline-2 focus-visible:outline-gt-preview"
          >
            この予定だけ変更して比較
          </button>
        </div>
      )}
    </div>
  )
}

function TicketStub({ index, isFixed }: { index: number; isFixed: boolean }) {
  return (
    <span aria-hidden="true" className="gt-itinerary-stub">
      <span className="text-[10px] font-semibold">予定</span>
      <span className="gt-itinerary-stub-number">{index}</span>
      {isFixed && <span className="text-[10px] font-semibold">固定</span>}
    </span>
  )
}

// 旅程を一本の路線図として表示する。駅＝予定。食事・要予約の予定は、種類に応じてチケットにする。
// 固定は、種類とは別の軸として、ロックの印と「固定予定」のラベルで示す（固定しても、駅はチケットにならない）。
// 路線図は旅の順番を表すもので、実際の地図ではない。
export function RouteMap({
  trip,
  meta = {},
  selectedStopId = null,
  onSelectStop,
  onReviseStop,
  preview,
  appliedStopId,
  idPrefix,
}: RouteMapProps) {
  const last = trip.stops.length - 1
  const targetIndex = preview ? trip.stops.findIndex((stop) => stop.id === preview.stop.id) : -1
  const firstVisible = targetIndex < 0 ? 0 : Math.max(0, targetIndex - 1)
  const lastVisible = targetIndex < 0 ? last : Math.min(last, targetIndex + 1)
  return (
    // tabIndex=-1：キー操作の順序には入れず、フォーカスを退避できるようにする（outlineは出さない）。
    <ol
      id={idPrefix ? `${idPrefix}-${ROUTE_LIST_ID}` : ROUTE_LIST_ID}
      tabIndex={-1}
      aria-label="旅程の路線図"
      className={`m-0 list-none p-0 outline-none ${preview ? '' : 'pt-3'}`}
    >
      {trip.stops.slice(firstVisible, lastVisible + 1).map((stop, offset) => {
        const index = firstVisible + offset
        const stopMeta = meta[stop.id] ?? {}
        const kind = routeStopKind(stop, stopMeta) ?? 'other'
        const branch = preview?.stop.id === stop.id ? preview : undefined
        const center = !preview && (kind === 'meal' || kind === 'reserved') ? 45 : NODE_CENTER_Y
        const nextId = trip.stops[index + 1]?.id
        const nextMeta = nextId ? meta[nextId] : undefined
        const showSegment = nextId && !preview
        const lineStyle =
          last === 0
            ? { display: 'none' }
            : index === firstVisible
              ? { top: center, bottom: 0 }
              : index === lastVisible
                ? { top: 0, height: center }
                : { top: 0, bottom: 0 }
        return (
          <li
            key={stop.id}
            id={`${idPrefix ? `${idPrefix}-` : ''}stop-${stop.id}`}
            tabIndex={branch ? -1 : undefined}
            className="relative flex scroll-mt-4"
          >
            <div className="relative w-[49px] flex-none" aria-hidden="true">
              <span
                className={`absolute left-4 w-[6px] ${preview ? 'bg-gt-rail' : 'bg-gt-line'}`}
                style={lineStyle}
              />
              {branch && (
                <svg
                  aria-hidden="true"
                  className="gt-branch-enter absolute inset-y-0 left-[19px] h-full w-[66px] overflow-visible text-gt-preview"
                  viewBox="0 0 55 100"
                  preserveAspectRatio="none"
                >
                  <path
                    d="M0 0 C0 11 49 14 49 30 V70 C49 86 0 89 0 100"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="4"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
              {branch ? (
                <span className="absolute top-[24px] left-2 size-[22px] rounded-full border-2 border-dotted border-gt-rail bg-gt-bg" />
              ) : (
                <Node
                  stop={stop}
                  index={index}
                  muted={Boolean(preview) || index === last}
                  center={center}
                />
              )}
            </div>
            <div className={`min-w-0 flex-1 pt-1.5 ${preview ? 'pb-3' : 'pb-6'}`}>
              {appliedStopId === stop.id && (
                <p className="gt-enter mb-2 border-l-2 border-gt-line pl-2 text-sm font-semibold text-gt-line-strong">
                  変更を反映済み
                </p>
              )}
              {preview ? (
                <div
                  data-variant="station"
                  className={`flex flex-wrap items-center gap-x-2 text-sm font-bold ${branch ? 'ml-12 font-normal text-gt-muted' : ''}`}
                >
                  {branch && <p className="w-full text-xs">元の予定（承認まで維持）</p>}
                  <span>{stop.plannedStartTime}</span>
                  <span className="wrap-anywhere">{stop.name}</span>
                  {stop.isFixed && <FixedChip />}
                </div>
              ) : (
                <StopCard
                  stop={stop}
                  index={index}
                  meta={stopMeta}
                  kind={kind}
                  selected={selectedStopId === stop.id}
                  onSelect={onSelectStop ? () => onSelectStop(stop.id) : undefined}
                  onRevise={
                    onReviseStop && revisionTargetRestriction(stop) === null
                      ? () => onReviseStop(stop.id)
                      : undefined
                  }
                />
              )}
              {showSegment && (
                <SegmentLabel
                  segment={nextMeta?.segmentFromPrevious}
                  evidence={segmentEvidence(trip.stops, index + 1)}
                />
              )}
              {branch && (
                <div
                  key={branch.revisionId}
                  data-variant={kind === 'meal' || kind === 'reserved' ? 'ticket' : 'station'}
                  className="gt-branch-enter relative mt-2 ml-11 rounded-xl border-2 border-gt-preview bg-gt-paper p-2.5"
                >
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 -left-8 grid size-7 -translate-y-1/2 place-items-center rounded-full border-[3px] border-gt-preview bg-gt-paper text-[11px] font-bold text-gt-preview"
                  >
                    {branch.label.split(' ').at(-1)}
                  </span>
                  <div className="flex flex-wrap justify-between gap-x-1 text-xs font-bold">
                    <span>{branch.stop.plannedStartTime}</span>
                    <span className="text-[11px] text-gt-preview">{branch.label}・未承認</span>
                  </div>
                  <p className="mt-1 text-sm font-bold wrap-anywhere">{branch.stop.name}</p>
                  <p className="mt-1 text-[11px] text-gt-muted">変更は未適用</p>
                  {index < last && (
                    <p className="mt-1 text-[11px] text-gt-muted">この先は元の旅程に合流</p>
                  )}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
