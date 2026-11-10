import type { ConstraintCheck, Revision, Stop, Trip } from '@/domain'

import {
  GoogleMapsAttribution,
  GoogleMapsSourceBox,
} from '@/features/legal/google-maps-attribution'
import {
  EvidenceDetail,
  StatusBadge,
  UnverifiedBadge,
  checkedAtFormat,
} from '@/features/trip-map/evidence-badge'
import { LockIcon } from '@/features/trip-map/icons'
import { endTime } from '@/features/trip-map/model'

import type { TravelComparison, TravelSlot } from './api-client'
import { checkStopEvidence, routesSegment } from './proposal-checks'

const constraints = {
  satisfied: { tone: 'consistent', label: '予定に収まる' },
  violated: { tone: 'conflicting', label: '予定に合わない' },
  unknown: { tone: 'unverifiable', label: '確認が必要' },
  not_checked: { tone: 'unverified', label: '未確認' },
} as const

export function ConstraintBadge({ status }: { status: ConstraintCheck['status'] }) {
  const { tone, label } = constraints[status]
  return <StatusBadge tone={tone}>{label}</StatusBadge>
}

const travelUnknown = {
  not_queried: '未照会',
  no_route: '経路が見つからない',
  api_error: '経路の取得に失敗',
  transit_unsupported: '公共交通は照会対象外',
}

const travelModes = { walk: '徒歩', drive: '車', transit: '公共交通' }

export function sharedRevisionBlockers(
  trip: Trip,
  revision: Revision,
  comparison?: TravelComparison,
) {
  const index = trip.stops.findIndex(({ id }) => id === revision.targetStopId)
  const blockers: string[] = []
  if (comparison?.originalPlaceId === null) {
    blockers.push('元の施設を特定できず、別の施設への変更か確認できません。')
  }
  const sides = [
    {
      stop: trip.stops[index - 1],
      label: '前の予定',
      placeId: comparison?.routeEndpoints?.previousPlaceId,
    },
    {
      stop: trip.stops[index + 1],
      label: '次の予定',
      placeId: comparison?.routeEndpoints?.nextPlaceId,
    },
  ]
  for (const { stop, label, placeId } of sides) {
    if (stop?.kind === 'transport') {
      blockers.push(
        `${label}「${stop.name}」は乗車・乗換のため、この機能では経路の端点として照合できません。`,
      )
    } else if (stop && placeId === null) {
      blockers.push(`${label}「${stop.name}」の施設を特定できず、移動時間を照合できません。`)
    }
  }
  return blockers
}

function knownSegment(slot?: TravelSlot) {
  return slot?.presence === 'segment' && slot.segment.status === 'known' ? slot.segment : undefined
}

function travelDifference(before?: TravelSlot, after?: TravelSlot) {
  const original = knownSegment(before)
  const candidate = knownSegment(after)
  if (
    !original ||
    !candidate ||
    original.mode !== candidate.mode ||
    original.source.kind !== candidate.source.kind ||
    original.source.label !== candidate.source.label ||
    Date.parse(original.checkedAt) !== Date.parse(candidate.checkedAt)
  )
    return null
  const difference = candidate.durationMinutes - original.durationMinutes
  if (difference === 0) return '同じ所要時間'
  return difference < 0 ? `${-difference}分短い` : `${difference}分長い`
}

function TravelValue({
  slot,
  baseline,
  compare = false,
  inline = false,
  showCheckedAt = true,
  showSource = !inline,
}: {
  slot?: TravelSlot
  baseline?: TravelSlot
  compare?: boolean
  inline?: boolean
  showCheckedAt?: boolean
  showSource?: boolean
}) {
  if (slot?.presence === 'none') return <>該当区間なし</>
  const segment = slot?.segment
  const simulated = segment?.status === 'known' && segment.source.kind === 'simulation'
  const checkedAt = segment?.checkedAt && checkedAtFormat.format(new Date(segment.checkedAt))
  const content = (
    <>
      {!segment ? (
        '移動時間は未取得'
      ) : segment.status === 'known' ? (
        <>
          {travelModes[segment.mode]}
          {segment.durationMinutes}分{simulated && '（模擬）'}
        </>
      ) : (
        <>
          {travelModes[segment.mode]}・未確認（{travelUnknown[segment.reason]}）
        </>
      )}
      {compare && (
        <span className="block text-sm font-semibold">
          {travelDifference(baseline, slot) ?? '時間差：未確認'}
        </span>
      )}
      {showSource && segment?.status === 'known' && (
        <span className="block text-xs text-gt-muted">{segment.source.label}</span>
      )}
      {checkedAt && showCheckedAt && (
        <span className={inline ? undefined : 'block text-xs text-gt-muted'}>
          {inline && '（'}
          {simulated ? '模擬日時' : '照合'} {checkedAt}
          {inline && '）'}
        </span>
      )}
    </>
  )
  return segment?.status === 'known' && segment.source.kind === 'routes' ? (
    <div
      role="group"
      aria-label="Google Mapsの移動時間"
      className="rounded border border-[#5e5e5e] bg-white px-[3px] py-1 text-gt-ink"
    >
      <div>{content}</div>
      <GoogleMapsAttribution />
    </div>
  ) : (
    content
  )
}

function VerificationScope({
  stop,
  previous,
  next,
  comparison,
  compact = false,
}: {
  stop: Stop
  previous?: Stop
  next?: Stop
  comparison?: TravelComparison
  compact?: boolean
}) {
  const items = [
    { label: '施設の特定', evidence: checkStopEvidence(stop, 'place_identity') },
    { label: '営業時間', evidence: checkStopEvidence(stop, 'opening_hours') },
  ]
  const placeEvidence = stop.evidence.filter(
    ({ subject }) => subject === 'place_identity' || subject === 'opening_hours',
  )
  const googleEvidence = placeEvidence.filter(({ source }) => source.kind === 'places')
  const otherSources = new Set(
    placeEvidence
      .filter(({ source }) => source.kind !== 'places')
      .map(({ source }) =>
        source.kind === 'simulation' ? `${source.label}（模擬）` : source.label,
      ),
  )
  return (
    <div className="space-y-1 text-sm leading-relaxed text-gt-muted">
      <p className="font-semibold">この候補の確認範囲</p>
      <ul className="space-y-0.5 wrap-anywhere">
        {items.map(({ label, evidence }) => (
          <li key={label}>
            {label}：
            {evidence.status === 'consistent'
              ? `情報源と整合（照合 ${checkedAtFormat.format(new Date(evidence.checkedAt))}）`
              : evidence.status === 'conflicting'
                ? '情報源と矛盾あり'
                : '未確認'}
          </li>
        ))}
        {previous && (
          <li>
            前の予定から：
            <TravelValue
              slot={comparison?.after.fromPrevious}
              baseline={comparison?.before.fromPrevious}
              compare={compact}
              showSource={compact}
              inline
            />
          </li>
        )}
        {next && (
          <li>
            次の予定まで：
            <TravelValue
              slot={comparison?.after.toNext}
              baseline={comparison?.before.toNext}
              compare={compact}
              showSource={compact}
              inline
            />
          </li>
        )}
      </ul>
      {googleEvidence.length > 0 &&
        (compact ? (
          <div className="flex flex-wrap items-center justify-between gap-x-2 rounded border border-[#5e5e5e] bg-white px-2 py-1">
            <span>
              候補の照合に使った出典：
              {[...new Set(googleEvidence.map(({ source }) => source.label))].join('、')}
            </span>
            <GoogleMapsAttribution />
          </div>
        ) : (
          <GoogleMapsSourceBox caption="候補のGoogle Maps照合">
            {googleEvidence.map((evidence) => (
              <EvidenceDetail key={evidence.id} evidence={evidence} />
            ))}
          </GoogleMapsSourceBox>
        ))}
      {compact && otherSources.size > 0 && <p>その他の出典：{[...otherSources].join('、')}</p>}
      <p>臨時休業・渋滞・遅延は確認の対象外です。{compact && '混雑も確認していません。'}</p>
    </div>
  )
}

function StopEvidence({ stop, label }: { stop: Stop; label: string }) {
  const google = stop.evidence.filter(
    ({ source }) => source.kind === 'places' || source.kind === 'routes',
  )
  const other = stop.evidence.filter(
    ({ source }) => source.kind !== 'places' && source.kind !== 'routes',
  )
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-bold">{label}</h4>
      {stop.evidence.length ? (
        <>
          {other.map((evidence) => (
            <EvidenceDetail key={evidence.id} evidence={evidence} />
          ))}
          {google.length > 0 && (
            <GoogleMapsSourceBox caption="Google Maps Platformで確認した内容">
              {google.map((evidence) => (
                <EvidenceDetail key={evidence.id} evidence={evidence} />
              ))}
            </GoogleMapsSourceBox>
          )}
        </>
      ) : (
        <UnverifiedBadge />
      )}
    </div>
  )
}

export function CandidatePreviewSummary({
  trip,
  revision,
  comparison,
}: {
  trip: Trip
  revision: Revision
  comparison?: TravelComparison
}) {
  const { after } = revision.diff
  const index = trip.stops.findIndex(({ id }) => id === revision.targetStopId)
  const fixedStops = trip.stops.filter(({ isFixed }) => isFixed)
  return (
    <dl className="grid grid-cols-[minmax(0,32%)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm wrap-anywhere">
      <dt className="font-semibold">時刻・滞在</dt>
      <dd>
        {after.plannedStartTime}〜{endTime(after)}（{after.durationMinutes}分）
      </dd>
      <dt className="font-semibold">前の予定から</dt>
      <dd>
        {index === 0 ? (
          '該当区間なし'
        ) : (
          <TravelValue slot={comparison?.after.fromPrevious} inline showCheckedAt={false} />
        )}
      </dd>
      <dt className="font-semibold">次の予定まで</dt>
      <dd>
        {index === trip.stops.length - 1 ? (
          '該当区間なし'
        ) : (
          <TravelValue slot={comparison?.after.toNext} inline showCheckedAt={false} />
        )}
      </dd>
      <dt className="font-semibold">固定予定</dt>
      <dd>
        {fixedStops.length ? (
          <>
            <p>場所・時刻を維持</p>
            <ul className="text-gt-muted">
              {fixedStops.map((stop) => (
                <li key={stop.id}>
                  {stop.plannedStartTime} {stop.name}
                </li>
              ))}
            </ul>
          </>
        ) : (
          '固定予定なし'
        )}
      </dd>
    </dl>
  )
}

export function CandidateComparison({
  trip,
  revision,
  label,
  comparison,
  compact = false,
}: {
  trip: Trip
  revision: Revision
  label: string
  comparison?: TravelComparison
  compact?: boolean
}) {
  const { before, after } = revision.diff
  const index = trip.stops.findIndex((stop) => stop.id === revision.targetStopId)
  const previous = trip.stops[index - 1]
  const next = trip.stops[index + 1]
  const fixedStops = trip.stops.filter((stop) => stop.isFixed)
  const arrivesInTime =
    revision.constraintCheck.status === 'satisfied' &&
    next &&
    routesSegment(comparison?.after.toNext)
  const rows = [
    { label: '場所', before: before.name, after: after.name },
    {
      label: '時刻・滞在',
      before: `${before.plannedStartTime}〜${endTime(before)}（${before.durationMinutes}分）`,
      after: `${after.plannedStartTime}〜${endTime(after)}（${after.durationMinutes}分）`,
    },
    {
      label: '前の予定から',
      before: previous ? <TravelValue slot={comparison?.before.fromPrevious} /> : '該当区間なし',
      after: previous ? (
        <TravelValue
          slot={comparison?.after.fromPrevious}
          baseline={comparison?.before.fromPrevious}
          compare
        />
      ) : (
        '該当区間なし'
      ),
    },
    {
      label: '次の予定まで',
      before: next ? <TravelValue slot={comparison?.before.toNext} /> : '該当区間なし',
      after: next ? (
        <TravelValue slot={comparison?.after.toNext} baseline={comparison?.before.toNext} compare />
      ) : (
        '該当区間なし'
      ),
    },
  ]
  const table = (
    <div className="gt-revision-table overflow-hidden rounded-[14px] border border-gt-rule">
      <table className="w-full table-fixed border-collapse text-left text-xs leading-relaxed wrap-anywhere">
        <caption className="sr-only">現在の予定と選択中の候補の差分</caption>
        <thead>
          <tr>
            <th scope="col" className="w-[20%] px-[5px] py-2">
              項目
            </th>
            <th scope="col" className="w-[40%] px-[5px] py-2">
              変更前
            </th>
            <th scope="col" className="px-[5px] py-2 text-gt-preview">
              {label}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className="gt-revision-table-row border-t border-gt-rule bg-gt-paper"
            >
              <th scope="row" className="px-[5px] py-2 align-top text-xs text-gt-muted">
                {row.label}
              </th>
              <td className="px-[5px] py-2 align-top">{row.before}</td>
              <td className="bg-gt-preview-bg/50 px-[5px] py-2 align-top font-semibold text-gt-preview">
                {row.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return (
    <div className="gt-enter gt-revision-paper space-y-4">
      {!compact && table}
      <section aria-label="予定への影響" className="gt-card space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-bold">予定への影響</h4>
          <ConstraintBadge status={revision.constraintCheck.status} />
        </div>
        <VerificationScope
          stop={after}
          previous={previous}
          next={next}
          comparison={comparison}
          compact={compact}
        />
        {arrivesInTime && (
          <p className="text-base font-semibold">
            {next.plannedStartTime}の予定に間に合う見込みです。
          </p>
        )}
        {revision.constraintCheck.status !== 'satisfied' && (
          <p className="text-sm leading-relaxed wrap-anywhere">
            {revision.constraintCheck.explanation}
          </p>
        )}
        <p className="text-sm leading-relaxed wrap-anywhere">{revision.impactSummary}</p>
        {!compact &&
          (fixedStops.length > 0 ? (
            <>
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <LockIcon size={14} />
                場所・時刻が変わらない固定予定
              </p>
              <ul className="space-y-1 pl-5 text-sm wrap-anywhere">
                {fixedStops.map((stop) => (
                  <li key={stop.id}>
                    {stop.plannedStartTime} {stop.name}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-gt-muted">この旅程に固定予定はありません。</p>
          ))}
      </section>
      {compact ? (
        <details className="gt-card p-0">
          <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-semibold">
            詳細な比較・根拠を見る
          </summary>
          <div className="space-y-3 px-3 pb-3">
            {table}
            <section aria-label="根拠と照合日時" className="space-y-3">
              <StopEvidence stop={before} label="今の予定" />
              <StopEvidence stop={after} label={label} />
            </section>
          </div>
        </details>
      ) : (
        <section className="gt-card space-y-2" aria-label="根拠と照合日時">
          <details>
            <summary className="min-h-11 cursor-pointer py-2.5 font-semibold">
              根拠・情報源を見る
            </summary>
            <div className="space-y-3 pb-2">
              <StopEvidence stop={before} label="今の予定" />
              <StopEvidence stop={after} label={label} />
            </div>
          </details>
        </section>
      )}
      <p className="rounded-xl border border-gt-unk/50 bg-gt-unk-bg p-2.5 text-xs font-semibold text-gt-unk">
        ⓘ 整合は、現実の正しさの保証ではありません。
      </p>
    </div>
  )
}
