import type { ConstraintCheck, Revision, Stop, Trip } from '@/domain'

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
}: {
  slot?: TravelSlot
  baseline?: TravelSlot
  compare?: boolean
  inline?: boolean
}) {
  if (slot?.presence === 'none') return <>該当区間なし</>
  const segment = slot?.segment
  const simulated = segment?.status === 'known' && segment.source.kind === 'simulation'
  const checkedAt = segment?.checkedAt && checkedAtFormat.format(new Date(segment.checkedAt))
  return (
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
      {!inline && segment?.status === 'known' && (
        <span className="block text-xs text-gt-muted">{segment.source.label}</span>
      )}
      {checkedAt && (
        <span className={inline ? undefined : 'block text-xs text-gt-muted'}>
          {inline && '（'}
          {simulated ? '模擬日時' : '照合'} {checkedAt}
          {inline && '）'}
        </span>
      )}
    </>
  )
}

function VerificationScope({
  stop,
  previous,
  next,
  comparison,
}: {
  stop: Stop
  previous?: Stop
  next?: Stop
  comparison?: TravelComparison
}) {
  const items = [
    { label: '施設の特定', evidence: checkStopEvidence(stop, 'place_identity') },
    { label: '営業時間', evidence: checkStopEvidence(stop, 'opening_hours') },
  ]
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
            <TravelValue slot={comparison?.after.fromPrevious} inline />
          </li>
        )}
        {next && (
          <li>
            次の予定まで：
            <TravelValue slot={comparison?.after.toNext} inline />
          </li>
        )}
      </ul>
      <p>臨時休業・渋滞・遅延は確認の対象外です。</p>
    </div>
  )
}

function StopEvidence({ stop, label }: { stop: Stop; label: string }) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-bold">{label}</h4>
      {stop.evidence.length ? (
        stop.evidence.map((evidence) => <EvidenceDetail key={evidence.id} evidence={evidence} />)
      ) : (
        <UnverifiedBadge />
      )}
    </div>
  )
}

export function CandidateComparison({
  trip,
  revision,
  label,
  comparison,
}: {
  trip: Trip
  revision: Revision
  label: string
  comparison?: TravelComparison
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
  return (
    <div className="gt-enter space-y-4">
      <section aria-label="予定への影響" className="space-y-2 border-t border-gt-rule pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-bold">予定への影響</h4>
          <ConstraintBadge status={revision.constraintCheck.status} />
        </div>
        <VerificationScope stop={after} previous={previous} next={next} comparison={comparison} />
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
        {fixedStops.length > 0 ? (
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
        )}
      </section>
      <table className="w-full table-fixed border-collapse text-left text-sm leading-relaxed wrap-anywhere">
        <caption className="sr-only">現在の予定と選択中の候補の差分</caption>
        <thead>
          <tr>
            <th scope="col" className="w-[26%] p-1.5">
              項目
            </th>
            <th scope="col" className="w-[37%] p-1.5">
              今の予定
            </th>
            <th scope="col" className="p-1.5 text-gt-preview">
              {label}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-gt-rule">
              <th scope="row" className="p-1.5 align-top text-sm">
                {row.label}
              </th>
              <td className="p-1.5 align-top">{row.before}</td>
              <td className="p-1.5 align-top">{row.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="space-y-2 border-t border-gt-rule pt-3" aria-label="根拠と照合日時">
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
    </div>
  )
}
