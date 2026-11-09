import type { Stop, Trip } from '@/domain'
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
  preview?: { stop: Stop; label: string; revisionId: string }
  appliedStopId?: string
}

// 予定のボタンのid。詳細シートを閉じたあとのフォーカスの復帰先に使う。
export const stopButtonId = (stopId: string) => `stop-button-${stopId}`

// 路線図の一覧のid。選択中の予定が（親のTripの更新で）無くなったとき、フォーカスの退避先に使う。
export const ROUTE_LIST_ID = 'trip-route-list'

const RAIL_WIDTH = 68
const NODE_CENTER_Y = 34

// 駅の印。形（輪・二重輪）は予定の「種類」で決め、固定は種類とは別に、ロックの印を重ねて示す。
function Node({ stop, index, kind }: { stop: Stop; index: number; kind: StopKind }) {
  const station = kind === 'station'
  const size = station ? 34 : 28
  return (
    <span
      aria-hidden="true"
      className="absolute"
      style={{ left: station ? 17 : 20, top: NODE_CENTER_Y - size / 2, width: size, height: size }}
    >
      <span
        className={`flex size-full items-center justify-center rounded-full bg-gt-paper font-mono text-[11px] font-black ${
          station ? 'border-[6px] border-gt-ink' : 'border-[5px] border-gt-muted'
        }`}
      >
        {index + 1}
      </span>
      {stop.isFixed && (
        <span
          data-fixed-mark
          className="absolute -right-2.5 -top-2.5 flex size-[18px] items-center justify-center rounded-full border-2 border-gt-bg bg-gt-ink text-white"
        >
          <LockIcon size={9} />
        </span>
      )}
    </span>
  )
}

// 「固定予定」のラベル。固定は予約済みを意味しない。表示の形（駅・チケット）とは独立に付ける。
function FixedChip() {
  return (
    <span className="mb-1 inline-flex items-center gap-1 rounded-[5px] border-[1.5px] border-gt-ink bg-gt-paper py-px pl-1.5 pr-2 text-xs font-semibold text-gt-ink">
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
        <UnverifiedBadge />
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
      className={`mt-2 flex flex-wrap items-center gap-1.5 text-xs text-gt-muted ${travelEvidence ? 'rounded border border-[#5E5E5E] bg-white p-1' : ''}`}
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
      <span>{text}</span>
      {travelEvidence && <GoogleMapsAttribution />}
    </p>
  )
}

function StopCard({
  stop,
  meta,
  kind,
  selected,
  onSelect,
}: {
  stop: Stop
  meta: RouteStopMeta
  kind: StopKind
  selected?: boolean
  onSelect?: () => void
}) {
  const worst = worstEvidence(stop.evidence)
  // 読み上げでも、時刻・滞在時間・固定の有無・根拠の代表状態が分かるようにする。
  const evidenceLabel = worst
    ? `${evidenceSubjectLabels[worst.subject]}：${evidenceStatusLabels[worst.status]}`
    : '未照合'
  const label = `${stop.plannedStartTime}から${stop.durationMinutes}分 ${stop.name}${stop.isFixed ? '（固定予定）' : ''}、${evidenceLabel}。詳細を開く`
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

  if (!isTicket) {
    return (
      <Card
        {...buttonProps}
        data-variant="station"
        className={`block min-h-11 w-full rounded-lg py-1 text-left ${selectedRing}`}
      >
        {stop.isFixed && <FixedChip />}
        <span className="block font-mono text-sm font-semibold text-gt-muted">
          {stop.plannedStartTime}〜{endTime(stop)}・{stop.durationMinutes}分
        </span>
        <span className="block wrap-anywhere text-lg font-bold leading-snug">{stop.name}</span>
        <span className="mt-1 block">
          <Evidence stop={stop} />
        </span>
      </Card>
    )
  }

  return (
    <Card
      {...buttonProps}
      data-variant="ticket"
      className={`relative flex w-full rounded-[14px] bg-gt-paper text-left shadow-[0_1px_0_rgba(0,0,0,.06),0_8px_18px_-10px_rgba(0,0,0,.35)] ${selectedRing}`}
    >
      <span className="flex w-[70px] flex-none flex-col justify-center gap-1 border-r-2 border-dashed border-gt-rule py-3 pl-3 pr-2">
        <span className="font-mono text-[18px] font-semibold leading-none">
          {stop.plannedStartTime}
        </span>
        <span className="text-xs font-bold text-gt-muted">
          {kind === 'meal' ? stopKindLabels.meal : stopKindLabels.reserved}
        </span>
      </span>
      <span
        aria-hidden="true"
        className="absolute -top-2 left-[62px] size-4 rounded-full bg-gt-bg"
      />
      <span
        aria-hidden="true"
        className="absolute -bottom-2 left-[62px] size-4 rounded-full bg-gt-bg"
      />
      <span className="min-w-0 flex-1 px-3 py-2.5">
        {stop.isFixed && <FixedChip />}
        <span className="block wrap-anywhere text-base font-bold leading-snug">{stop.name}</span>
        <span className="mt-0.5 block text-sm text-gt-muted">
          {stop.plannedStartTime}〜{endTime(stop)}・{stop.durationMinutes}分
          {meta.price ? `・${meta.price}` : ''}
        </span>
        <span className="mt-1.5 block">
          <Evidence stop={stop} />
        </span>
      </span>
    </Card>
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
  preview,
  appliedStopId,
}: RouteMapProps) {
  const last = trip.stops.length - 1
  return (
    // tabIndex=-1：キー操作の順序には入れず、フォーカスを退避できるようにする（outlineは出さない）。
    <ol
      id={ROUTE_LIST_ID}
      tabIndex={-1}
      aria-label="旅程の路線図"
      className="m-0 list-none p-0 outline-none"
    >
      {trip.stops.map((stop, index) => {
        const stopMeta = meta[stop.id] ?? {}
        const kind = routeStopKind(stop, stopMeta) ?? 'other'
        const branch = preview?.stop.id === stop.id ? preview : undefined
        const nextId = trip.stops[index + 1]?.id
        const nextMeta = nextId ? meta[nextId] : undefined
        const showSegment = nextId && !branch && preview?.stop.id !== nextId
        const lineStyle =
          index === 0
            ? { top: branch ? 0 : NODE_CENTER_Y, bottom: 0 }
            : index === last
              ? { top: 0, height: NODE_CENTER_Y }
              : { top: 0, bottom: 0 }
        return (
          <li
            key={stop.id}
            id={`stop-${stop.id}`}
            tabIndex={branch ? -1 : undefined}
            className="relative flex scroll-mt-4"
          >
            <div className="relative flex-none" style={{ width: RAIL_WIDTH }} aria-hidden="true">
              <span
                className="absolute left-[30px] w-2 rounded-sm bg-gt-muted/55"
                style={lineStyle}
              />
              {branch && (
                <span
                  key={branch.revisionId}
                  className="gt-branch-enter absolute inset-y-0 left-[34px] w-6"
                >
                  <svg
                    className="absolute left-0 top-0 text-gt-preview"
                    width="26"
                    height="20"
                    viewBox="0 0 26 20"
                    fill="none"
                  >
                    <path d="M0 0C0 9 24 9 24 20" stroke="currentColor" strokeWidth="3" />
                  </svg>
                  <span
                    className={`absolute left-[22.5px] top-[19px] w-[3px] bg-gt-preview ${index < last ? 'bottom-[19px]' : 'bottom-10'}`}
                  />
                  {index < last && (
                    <svg
                      className="absolute bottom-0 left-0 text-gt-preview"
                      width="26"
                      height="20"
                      viewBox="0 0 26 20"
                      fill="none"
                    >
                      <path d="M24 0C24 11 0 11 0 20" stroke="currentColor" strokeWidth="3" />
                    </svg>
                  )}
                </span>
              )}
              <Node stop={stop} index={index} kind={kind} />
            </div>
            <div className={`min-w-0 flex-1 pb-5 pt-2 ${preview ? '' : 'pr-3'}`}>
              {branch && <p className="mb-1 text-sm font-semibold text-gt-muted">現在の予定</p>}
              {appliedStopId === stop.id && (
                <p className="gt-enter mb-2 border-l-2 border-gt-line pl-2 text-sm font-semibold text-gt-line-strong">
                  変更を反映済み
                </p>
              )}
              <StopCard
                stop={stop}
                meta={stopMeta}
                kind={kind}
                selected={selectedStopId === stop.id}
                onSelect={onSelectStop ? () => onSelectStop(stop.id) : undefined}
              />
              {showSegment && (
                <SegmentLabel
                  segment={nextMeta?.segmentFromPrevious}
                  evidence={segmentEvidence(trip.stops, index + 1)}
                />
              )}
              {branch && (
                <div
                  key={branch.revisionId}
                  className="gt-branch-enter relative mt-3 rounded-xl bg-gt-preview-bg p-2 ring-1 ring-gt-preview/40"
                >
                  <span
                    aria-hidden="true"
                    className={`absolute -left-[18px] size-4 rounded-full border-[3px] border-gt-preview bg-gt-paper ${index < last ? 'top-3' : 'bottom-3'}`}
                  />
                  <p className="mb-1 text-sm font-semibold text-gt-preview">
                    {branch.label}・変更案
                  </p>
                  <StopCard stop={branch.stop} kind={kind} meta={{}} />
                  {index < last && (
                    <p className="mt-2 text-sm text-gt-muted">この先は元の旅程に合流</p>
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
