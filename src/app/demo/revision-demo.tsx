'use client'

import type { Revision } from '@/domain'
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

export function RevisionDemo() {
  return (
    <RevisionRouteView
      trip={sampleRouteTrip}
      meta={sampleRouteMeta}
      mock
      generate={demoCandidates}
    />
  )
}
