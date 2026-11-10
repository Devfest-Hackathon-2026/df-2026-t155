'use client'

import { useState } from 'react'

import type { Revision, Trip } from '@/domain'
import { sampleRevision } from '@/domain/samples'
import type { GenerateRevisions, TravelSlot } from '@/features/revision-review/api-client'
import { RevisionRouteView } from '@/features/revision-review/revision-route-view'
import { sampleRouteMeta, sampleRouteTrip } from '@/features/trip-map/sample'

const demoCandidates: GenerateRevisions = async (request) => {
  const index = request.trip.stops.findIndex((stop) => stop.id === request.targetStopId)
  const before = request.trip.stops[index]
  if (!before || before.isFixed || before.id !== sampleRevision.targetStopId) {
    return { status: 'no_candidates', message: 'この架空デモの候補は昼食に用意しています。' }
  }
  const previous = request.trip.stops[index - 1]
  const next = request.trip.stops[index + 1]
  const checkedAt = '2026-11-08T11:46:00+09:00'
  const segment = (fromStopId: string, toStopId: string, durationMinutes: number): TravelSlot => ({
    presence: 'segment',
    segment: {
      status: 'known',
      fromStopId,
      toStopId,
      mode: 'walk',
      durationMinutes,
      source: { kind: 'simulation', label: 'デモ用の架空の経路' },
      checkedAt,
      explanation: '画面確認用の架空データ',
    },
  })
  const base: Revision = {
    ...sampleRevision,
    baseTripVersion: request.trip.version,
    reason: request.reason,
    context: request.context,
    diff: { before, after: sampleRevision.diff.after },
    constraintCheck: {
      status: 'unknown',
      explanation: 'デモではこの候補の営業時間を確認できない想定です。',
    },
  }
  const alternative: Revision = {
    ...base,
    id: 'revision-lunch-c',
    diff: {
      before,
      after: {
        ...base.diff.after,
        name: '食堂いちょう（架空候補）',
        evidence: base.diff.after.evidence.map((evidence) => ({
          ...evidence,
          claim: '食堂いちょうが当日営業している',
          status: 'consistent',
          explanation: 'デモの模擬情報源と整合。',
        })),
      },
    },
    impactSummary: '架空の比較では、昼食だけを変更し、前後の予定の場所と時刻を維持します。',
    constraintCheck: {
      status: 'satisfied',
      explanation: '架空の営業時間と移動条件では成立しています。',
    },
  }
  return {
    status: 'proposed',
    revisions: [alternative, base],
    comparisons: [
      {
        revisionId: alternative.id,
        before: {
          fromPrevious: segment(previous.id, before.id, 10),
          toNext: segment(before.id, next.id, 10),
        },
        after: {
          fromPrevious: segment(previous.id, before.id, 8),
          toNext: segment(before.id, next.id, 6),
        },
      },
    ],
  }
}

function approveDemoCandidate(trip: Trip, revision: Revision): Trip | null {
  const target = trip.stops.find(({ id }) => id === revision.targetStopId)
  if (
    trip.id !== sampleRouteTrip.id ||
    trip.id !== revision.tripId ||
    trip.version !== revision.baseTripVersion ||
    !target ||
    target.id !== sampleRevision.targetStopId ||
    target.isFixed ||
    revision.constraintCheck.status !== 'satisfied'
  )
    return null

  return {
    ...trip,
    version: trip.version + 1,
    stops: trip.stops.map((stop) => (stop.id === target.id ? revision.diff.after : stop)),
  }
}

export function RevisionDemo() {
  const [resetCount, setResetCount] = useState(0)
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4">
        <p className="text-sm text-gt-muted">
          このデモでは架空の旅程を操作できます。実際の保存やAPIでの適用は行いません。
        </p>
        <button
          type="button"
          className="min-h-11 text-sm font-semibold text-gt-line-strong underline underline-offset-4"
          onClick={() => setResetCount((count) => count + 1)}
        >
          デモをリセット
        </button>
      </div>
      <RevisionRouteView
        key={resetCount}
        trip={sampleRouteTrip}
        meta={sampleRouteMeta}
        mock
        generate={demoCandidates}
        simulateApproval={approveDemoCandidate}
      />
    </>
  )
}
