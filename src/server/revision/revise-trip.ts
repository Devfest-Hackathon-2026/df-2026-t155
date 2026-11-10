import {
  matchesRevisionReportTarget,
  RevisionContextSchema,
  ReviseTripResponseSchema,
  type ConstraintCheck,
  type Evidence,
  type ProposalFailure,
  type ReviseTripRequest,
  type ReviseTripResponse,
  type Revision,
  type RevisionContext,
  type RevisionRouteEndpoints,
  type Stop,
  type Trip,
  type TravelComparison,
  type TravelSegment,
  type TravelSegmentSlot,
} from '../../domain'
import {
  confirmedOriginalPlaceId,
  isRevisionEvidenceConflict,
  revisionReportUncertainty,
} from '../../domain/revision-evidence'
import {
  GeminiCallError,
  type GeminiCallFailureReason,
  type GeminiJsonClient,
} from '../gemini/client'
import type { MapsClient } from '../maps'
import { compareNames, parseName, type PlaceSelection } from '../verification/name-match'
import {
  measureSegment,
  normalizeModes,
  segmentEvidenceFields,
  type SegmentEvidenceFields,
  type SegmentMeasurement,
  type TravelModeSetting,
} from '../verification/segment'
import { availableMinutes, formatMinutes } from '../verification/travel'
import { evidence, hoursEvidence, identityEvidence, lookupPlace } from '../verification/verify-trip'
import { judgeCandidate, type CandidateJudgement, type CandidateViolation } from './constraints'
import { buildRevisionResponseJsonSchema, RevisionDraftSchema } from './draft'
import { buildRevisionPrompt } from './prompt'

// 利用者の入力やAIの出力本文は含めない。原因の区分だけを記録する。
type IdentityFailure = Exclude<PlaceSelection['status'], 'matched'>
type RouteUnknownReason = Extract<TravelSegment, { status: 'unknown' }>['reason']
type UnknownReason =
  | 'hours'
  | 'hours_conflict'
  | 'original_place'
  | 'report_or_conflict'
  | `${'from_previous' | 'to_next'}_${RouteUnknownReason}`
  | `${'from_previous' | 'to_next'}_place_lookup_failed`

type NameExclusion = 'invalid' | 'duplicate'
type CandidateCounts = {
  kind: 'candidate_counts'
  generated: number
  filtered: number
  nameExclusions: Partial<Record<NameExclusion, number>>
  identified: number
  unidentified: Partial<Record<IdentityFailure, number>>
  mapsFailed: number
  violated: number
  violations: Partial<Record<CandidateViolation | 'permanently_closed', number>>
  samePlace: number
  duplicatePlace: number
  unknown: number
  unknownReasons: Partial<Record<UnknownReason, number>>
  satisfied: number
}

export type RevisionFailureEvent =
  | { kind: 'gemini_call'; reason: GeminiCallFailureReason; status?: number }
  | { kind: 'unexpected_client_error'; errorName: string }
  | { kind: 'invalid_output'; detail: string }
  | { kind: 'original_place_lookup_failed' }
  | CandidateCounts

export interface ReviseDeps {
  client: GeminiJsonClient
  maps: Pick<MapsClient, 'searchPlaces' | 'computeRoute'>
  createId?: () => string
  now?: () => Date
  report?: (event: RevisionFailureEvent) => void
}

type MapsDeps = Pick<ReviseDeps, 'maps' | 'now'> & { travelModes?: readonly TravelModeSetting[] }

const GEMINI_FAILURE_MESSAGES: Record<GeminiCallFailureReason, string> = {
  not_configured: 'サーバーの設定が完了していないため、代替候補を作れません。',
  api_error:
    'AIによる代替候補の作成に接続できませんでした。時間をおいて、もう一度お試しください。元の旅程は、そのままです。',
  blocked: 'AIが入力内容を処理できませんでした。理由を見直して、もう一度お試しください。',
  incomplete: 'AIの処理が途中で終了しました。時間をおいて、もう一度お試しください。',
  empty_response: 'AIから候補が返されませんでした。時間をおいて、もう一度お試しください。',
}

const MAPS_FAILURE_MESSAGE =
  'Google Mapsとの通信に失敗したため、候補を確認できませんでした。時間をおいて、もう一度お試しください。元の旅程は、そのままです。'

// 変更対象外の予定との名称重複を避けるための比較キー。
const nameKey = (name: string): string => parseName(name).base

// 乗車・乗換の予定は、予定名だけでは実際の終了地点を確定できないため、施設として差し替えない。
const TRANSPORT_TARGET_MESSAGE = '乗車・乗換の予定は、施設として差し替えられません。'

const externalFailure = (message: string): ProposalFailure => ({
  status: 'external_service_error',
  message,
})

// 差し替え対象の、前後の予定と、そのPlace ID。旅程ごとに1回だけ調べ、候補どうしで共有する
// （Places・Routesの呼び出し回数を増やさないため）。前後の施設は、Place IDだけが必要なので、営業時間は要求しない。
interface Surroundings {
  target: Stop
  previous: Stop | null
  next: Stop | null
  previousPlaceId: string | null
  nextPlaceId: string | null
  originalPlaceId: string | null
  originalLookupFailed: boolean
  adjacentPlaceMismatch: boolean
  failedPlaceLookups: NonNullable<TravelComparison['failedPlaceLookups']>
}

async function resolveSurroundings(
  trip: Trip,
  index: number,
  maps: Pick<MapsClient, 'searchPlaces'>,
  priorOriginalEvidence: readonly Evidence[] = [],
): Promise<Surroundings> {
  const originalStop = trip.stops[index]
  // 保存から復元された旅程に根拠が無い場合も、提案時の未解決の本人報告で適用を止める。
  const conflicts = priorOriginalEvidence.filter((item) =>
    isRevisionEvidenceConflict(item, 'original'),
  )
  const target =
    conflicts.length > 0
      ? { ...originalStop, evidence: [...originalStop.evidence, ...conflicts] }
      : originalStop
  const previous = trip.stops[index - 1] ?? null
  const next = trip.stops[index + 1] ?? null
  // 通常保存のPlace IDは、独立した照合結果との不一致検出にだけ使う。
  // 乗車・乗換は施設ではないため、Placesを呼ばない（nullは「照会していない」。経路の根拠はunknownになる）。
  const placeId = async (stop: Stop | null) => {
    if (!stop || stop.kind === 'transport') return { id: null, mismatch: false, failed: false }
    const { place, lookup } = await lookupPlace(maps, trip, stop, { includeOpeningHours: false })
    return {
      id: confirmedOriginalPlaceId(stop, place?.placeId),
      mismatch: Boolean(place && stop.placeId !== null && place.placeId !== stop.placeId),
      failed: lookup.kind === 'failed',
    }
  }
  const [previousLookup, nextLookup, original] = await Promise.all([
    placeId(previous),
    placeId(next),
    lookupPlace(maps, trip, target, { includeOpeningHours: false }),
  ])
  const failedPlaceLookups: Surroundings['failedPlaceLookups'] = []
  if (previousLookup.failed) failedPlaceLookups.push('previous')
  if (nextLookup.failed) failedPlaceLookups.push('next')
  return {
    target,
    previous,
    next,
    previousPlaceId: previousLookup.id,
    nextPlaceId: nextLookup.id,
    adjacentPlaceMismatch: previousLookup.mismatch || nextLookup.mismatch,
    failedPlaceLookups,
    originalPlaceId: confirmedOriginalPlaceId(target, original.place?.placeId),
    originalLookupFailed: original.lookup.kind === 'failed',
  }
}

interface MeasuredSides {
  fromPrevious: SegmentMeasurement | null
  toNext: SegmentMeasurement | null
}

// 対象の予定が、ある施設（Place ID）に置き換わったときの、前後の移動を測る。
async function measureSides(
  surroundings: Surroundings,
  stop: Stop,
  placeId: string | null,
  deps: {
    maps: Pick<MapsClient, 'computeRoute'>
    modes: readonly TravelModeSetting[]
    checkedAt: string
  },
): Promise<MeasuredSides> {
  const { previous, next, previousPlaceId, nextPlaceId } = surroundings
  const { maps, modes, checkedAt } = deps
  const [fromPrevious, toNext] = await Promise.all([
    previous
      ? measureSegment(maps, {
          fromStopId: previous.id,
          toStopId: stop.id,
          fromPlaceId: previousPlaceId,
          toPlaceId: placeId,
          availableMinutes: availableMinutes({ previous, next: stop }),
          modes,
          checkedAt,
        })
      : Promise.resolve(null),
    next
      ? measureSegment(maps, {
          fromStopId: stop.id,
          toStopId: next.id,
          fromPlaceId: placeId,
          toPlaceId: nextPlaceId,
          availableMinutes: availableMinutes({ previous: stop, next }),
          modes,
          checkedAt,
        })
      : Promise.resolve(null),
  ])
  return { fromPrevious, toNext }
}

const slotOf = (
  measurement: SegmentMeasurement | null,
  reason: 'first_stop' | 'last_stop',
): TravelSegmentSlot =>
  measurement ? { presence: 'segment', segment: measurement.segment } : { presence: 'none', reason }

const evidenceFrom = (
  stop: Stop,
  suffix: string,
  fields: SegmentEvidenceFields | null,
  checkedAt: string,
  reportImpactUnknown: boolean,
): Evidence | null => {
  if (!fields) return null
  const explanation =
    reportImpactUnknown && fields.status === 'consistent'
      ? '元の時刻表で確保した時間内に収まる所要時間です。'
      : fields.explanation
  return evidence(stop, suffix, { ...fields, explanation }, checkedAt)
}

type Evaluation =
  | { kind: 'maps_failed' }
  | { kind: 'unidentified'; reason: IdentityFailure; explanation: string }
  | { kind: 'same_place'; explanation: string }
  | {
      kind: 'judged'
      after: Stop & { placeId: string }
      judgement: CandidateJudgement
      hoursStatus: Evidence['status']
      businessStatus?: string
      sides: MeasuredSides
      travelBefore: Evidence | null
      travelAfter: Evidence | null
      unknownReasons: UnknownReason[]
    }

// 候補（名称だけ差し替えた予定）を、Places・Routesで確認し、制約を判定する。
// 開始時刻・滞在時間・種別・固定は、元の予定のまま。他の予定の時刻も動かさない。
async function evaluateCandidate(
  trip: Trip,
  surroundings: Surroundings,
  candidateName: string,
  deps: MapsDeps & {
    modes: readonly TravelModeSetting[]
    checkedAt: string
    context: RevisionContext
    priorCandidateEvidence?: readonly Evidence[]
    candidateMeasurements?: Map<string, Promise<MeasuredSides>>
  },
): Promise<Evaluation> {
  const { maps, modes, checkedAt } = deps
  const { target, previous, next, originalPlaceId, previousPlaceId, nextPlaceId } = surroundings
  const candidate: Stop = { ...target, name: candidateName, placeId: null, evidence: [] }
  delete candidate.manualRevisionId

  const { lookup } = await lookupPlace(maps, trip, candidate, { includeOpeningHours: true })
  if (lookup.kind === 'failed') return { kind: 'maps_failed' }

  const identity = identityEvidence(trip, candidate, lookup, checkedAt)
  // 施設を特定できない候補は、候補にしないため、移動は調べない（Routesの呼び出しを節約）。
  if (lookup.selection.status !== 'matched') {
    return {
      kind: 'unidentified',
      reason: lookup.selection.status,
      explanation: identity.explanation,
    }
  }

  const { place } = lookup.selection
  if (place.placeId === originalPlaceId) {
    return { kind: 'same_place', explanation: '元の予定と同じ施設のため、差し替えられません。' }
  }
  if (place.placeId === previousPlaceId || place.placeId === nextPlaceId) {
    return { kind: 'same_place', explanation: '前後の予定と同じ施設のため、差し替えられません。' }
  }

  const hours = hoursEvidence(trip, candidate, place, checkedAt)
  const measurements = deps.candidateMeasurements
  const measured =
    measurements?.get(place.placeId) ??
    measureSides(surroundings, candidate, place.placeId, { maps, modes, checkedAt })
  measurements?.set(place.placeId, measured)
  const sides = await measured
  const reportUncertainty = revisionReportUncertainty(deps.context)

  // Routesを照会していない区間は、Routes由来の根拠を付けない（null）。
  const travelBefore =
    previous && sides.fromPrevious
      ? evidenceFrom(
          candidate,
          'travel',
          segmentEvidenceFields(sides.fromPrevious, {
            claim: '前の予定の終了後、この予定の開始時刻までに移動できる',
            applicability: `${trip.date} ${endTime(previous)}〜${candidate.plannedStartTime}（使える時間${availableMinutes({ previous, next: candidate })}分）`,
          }),
          checkedAt,
          reportUncertainty !== undefined,
        )
      : null
  const travelAfter =
    next && sides.toNext
      ? evidenceFrom(
          candidate,
          'travel-next',
          segmentEvidenceFields(sides.toNext, {
            claim: 'この予定の終了後、次の予定の開始時刻までに移動できる',
            applicability: `${trip.date} ${endTime(candidate)}〜${next.plannedStartTime}（使える時間${availableMinutes({ previous: candidate, next })}分）`,
          }),
          checkedAt,
          reportUncertainty !== undefined,
        )
      : null

  // 再照合は本人報告などの矛盾を上書きしない。出典をそのまま残し、成立の根拠には使わない。
  const priorConflicts =
    deps.priorCandidateEvidence?.filter((item) => isRevisionEvidenceConflict(item, 'candidate')) ??
    []
  const adjacentConflict = surroundings.adjacentPlaceMismatch
    ? evidence(
        candidate,
        'adjacent-place',
        {
          subject: 'other',
          claim: '前後の予定の施設が保存済みの施設と一致している',
          applicability: '変更対象の前後の予定',
          source: identity.source,
          status: 'conflicting',
          explanation: '前後の予定の施設検索で、保存済みの施設と異なる施設が見つかりました。',
        },
        checkedAt,
      )
    : null
  const after = {
    ...candidate,
    placeId: place.placeId,
    evidence: [
      identity,
      hours,
      ...(travelBefore ? [travelBefore] : []),
      ...(travelAfter ? [travelAfter] : []),
      ...(adjacentConflict ? [adjacentConflict] : []),
      ...priorConflicts,
    ],
  }
  const uncertainties: string[] = []
  const unknownReasons: UnknownReason[] = []
  if (!originalPlaceId) {
    uncertainties.push('元の施設を特定できず、候補と別の施設か確認できていません。')
    unknownReasons.push('original_place')
  }
  const hasEvidenceConflict =
    target.evidence.some((item) => isRevisionEvidenceConflict(item, 'original')) ||
    priorConflicts.length > 0 ||
    adjacentConflict !== null
  if (hasEvidenceConflict) {
    uncertainties.push('承認に関係する根拠の矛盾が解消できていません。')
  }
  if (reportUncertainty) uncertainties.push(reportUncertainty)
  if (hasEvidenceConflict || reportUncertainty) unknownReasons.push('report_or_conflict')
  if (hours.status === 'unverifiable') unknownReasons.push('hours')
  const { failedPlaceLookups } = surroundings
  if (failedPlaceLookups.includes('previous')) {
    unknownReasons.push('from_previous_place_lookup_failed')
    uncertainties.push('前の予定の施設検索に失敗しました。')
  } else if (sides.fromPrevious?.segment.status === 'unknown') {
    unknownReasons.push(`from_previous_${sides.fromPrevious.segment.reason}`)
  }
  if (failedPlaceLookups.includes('next')) {
    unknownReasons.push('to_next_place_lookup_failed')
    uncertainties.push('次の予定の施設検索に失敗しました。')
  } else if (sides.toNext?.segment.status === 'unknown') {
    unknownReasons.push(`to_next_${sides.toNext.segment.reason}`)
  }
  if (failedPlaceLookups.length > 0) uncertainties.push('時間をおいて、もう一度お試しください。')
  const overlaps = [sides.fromPrevious, sides.toNext].some(
    (side) => side?.fit.status === 'too_long' && side.segment.status === 'unknown',
  )
  const judgement = judgeCandidate({
    identity,
    hours,
    expectsTravelBefore: previous !== null,
    travelBefore,
    expectsTravelAfter: next !== null,
    travelAfter,
    overlaps,
    uncertainties,
  })
  return {
    kind: 'judged',
    after,
    judgement,
    hoursStatus: hours.status,
    businessStatus: place.businessStatus,
    sides,
    travelBefore,
    travelAfter,
    unknownReasons,
  }
}

const endTime = (stop: Stop): string =>
  formatMinutes(
    Number(stop.plannedStartTime.slice(0, 2)) * 60 +
      Number(stop.plannedStartTime.slice(3)) +
      stop.durationMinutes,
  )

// 適用の直前に、サーバー側で制約を再検証するための関数。`satisfied`と判定されたときだけ、適用できる。
// 成立の根拠は再取得する。既存の候補のEvidenceは、未解決の矛盾が残るかを見るためだけに使う。
// 所有者の認可・Tripの版の一致・変更前のStopとの一致は、呼び出し側（適用の処理）が別に検証する。
export type RevisionRecheck =
  | { status: 'checked'; constraintCheck: ConstraintCheck; after: Stop }
  | { status: 'not_possible'; explanation: string }
  | { status: 'external_service_error'; message: string }
  | { status: 'endpoints_changed' }

export async function checkRevisionConstraints(
  trip: Trip,
  revision: Pick<Revision, 'targetStopId' | 'diff' | 'context'>,
  deps: MapsDeps & { expectedEndpoints?: RevisionRouteEndpoints },
): Promise<RevisionRecheck> {
  const context = RevisionContextSchema.safeParse(revision.context)
  if (!context.success || !matchesRevisionReportTarget(context.data, revision.targetStopId)) {
    return { status: 'not_possible', explanation: '修正時の報告文脈を確認できません。' }
  }
  const index = trip.stops.findIndex((stop) => stop.id === revision.targetStopId)
  const target = trip.stops[index]
  if (!target) return { status: 'not_possible', explanation: '対象の予定が、旅程にありません。' }
  if (target.kind === 'transport') {
    return { status: 'not_possible', explanation: TRANSPORT_TARGET_MESSAGE }
  }
  if (target.isFixed) {
    return { status: 'not_possible', explanation: '固定予定は変更できません。' }
  }
  if (context.data.phase === 'on_site' && context.data.report.kind === 'simulated') {
    return { status: 'not_possible', explanation: '模擬報告の候補は適用できません。' }
  }
  if (revision.diff.before.id !== revision.targetStopId) {
    return { status: 'not_possible', explanation: '変更前の予定が、対象の予定と一致しません。' }
  }
  const afterName = revision.diff.after.name
  const afterKey = nameKey(afterName)
  if (!afterKey || compareNames(target.name, afterName) === 'exact') {
    return { status: 'not_possible', explanation: '差し替え先の施設名を確認してください。' }
  }
  if (
    trip.stops.some((stop) => stop.id !== revision.targetStopId && nameKey(stop.name) === afterKey)
  ) {
    return { status: 'not_possible', explanation: '他の予定と同じ名称には変更できません。' }
  }
  const surroundings = await resolveSurroundings(
    trip,
    index,
    deps.maps,
    revision.diff.before.evidence,
  )
  if (surroundings.originalLookupFailed) {
    return { status: 'external_service_error', message: MAPS_FAILURE_MESSAGE }
  }
  const { expectedEndpoints } = deps
  if (
    expectedEndpoints &&
    (surroundings.adjacentPlaceMismatch ||
      (surroundings.previousPlaceId !== null &&
        surroundings.previousPlaceId !== expectedEndpoints.previousPlaceId) ||
      (surroundings.nextPlaceId !== null &&
        surroundings.nextPlaceId !== expectedEndpoints.nextPlaceId))
  )
    return { status: 'endpoints_changed' }
  const checkedAt = (deps.now?.() ?? new Date()).toISOString()
  const evaluation = await evaluateCandidate(trip, surroundings, afterName, {
    ...deps,
    modes: normalizeModes(deps.travelModes),
    checkedAt,
    context: context.data,
    priorCandidateEvidence: revision.diff.after.evidence,
  })
  if (evaluation.kind === 'maps_failed') {
    return { status: 'external_service_error', message: MAPS_FAILURE_MESSAGE }
  }
  if (evaluation.kind === 'same_place' || evaluation.kind === 'unidentified') {
    return { status: 'not_possible', explanation: evaluation.explanation }
  }
  if (evaluation.judgement.status === 'excluded') {
    return { status: 'not_possible', explanation: evaluation.judgement.explanation }
  }
  return {
    status: 'checked',
    constraintCheck: evaluation.judgement.constraintCheck,
    after: evaluation.after,
  }
}

function impactSummary(
  before: Stop,
  after: Stop,
  evaluation: { travelBefore: Evidence | null; travelAfter: Evidence | null },
  constraint: ConstraintCheck,
): string {
  const parts = [
    `「${before.name}」を「${after.name}」に差し替える候補です。開始時刻（${after.plannedStartTime}）と滞在時間（${after.durationMinutes}分）は変えません。`,
  ]
  if (evaluation.travelBefore)
    parts.push(`前の予定からの移動：${evaluation.travelBefore.explanation}`)
  if (evaluation.travelAfter) parts.push(`次の予定への移動：${evaluation.travelAfter.explanation}`)
  parts.push(constraint.explanation)
  return parts.join('')
}

function noCandidatesAfterCheck(counts: CandidateCounts): ProposalFailure {
  if (counts.generated === 0) {
    return { status: 'no_candidates', message: 'AIから代替候補が返されませんでした。' }
  }

  const reasons: string[] = []
  if (counts.nameExclusions.invalid) reasons.push('使える施設名がない案を除きました。')
  if (counts.nameExclusions.duplicate)
    reasons.push('元の予定・他の予定・候補と名前が重なる案を除きました。')
  if (counts.samePlace) reasons.push('元の予定や前後の予定と同じ施設だった案を除きました。')
  const { no_candidates, mismatch, region_mismatch, ambiguous } = counts.unidentified
  if (no_candidates) reasons.push('Google Mapsで該当する施設が見つかりませんでした。')
  if (mismatch || region_mismatch)
    reasons.push('候補の名前と一致し、旅程の地域内にある施設を確認できませんでした。')
  if (ambiguous) reasons.push('同じ名前の施設が複数見つかり、1か所に絞れませんでした。')
  if (counts.violations.hours)
    reasons.push('予定の滞在時間帯に利用できる営業時間ではありませんでした。')
  if (counts.violations.permanently_closed) reasons.push('情報源で閉業と示された施設を除きました。')
  if (counts.violations.travel)
    reasons.push('照合した移動時間では、次の予定または候補の開始時刻に間に合いませんでした。')
  if (counts.violations.overlap) reasons.push('前後の予定と時刻が重なっていました。')
  return { status: 'no_candidates', message: reasons.join('') }
}

const HOURS_CONFLICT =
  '同じ施設の営業状態や営業時間の照合結果に食い違いがあり、予定の滞在時間帯に営業しているか確認できません。'
const TEMPORARY_CLOSURE_CONFLICT =
  '同じ施設について一時休業の情報と別の照合結果が食い違い、予定の滞在時間帯に営業しているか確認できません。'

// 1地点の部分修正の候補（未承認のRevision）を作る。元のTripは更新しない。承認・保存・適用はしない。
// 旅行前（planning）と現地報告（on_site）で、同じ処理を使う。
// 変更前後の移動区間の比較（comparisons）も、同じリクエストの中で、構造化された結果として返す。
export async function reviseTrip(
  request: ReviseTripRequest,
  deps: ReviseDeps,
): Promise<ReviseTripResponse> {
  const { client, maps, createId = () => crypto.randomUUID(), now, report } = deps
  const { trip, targetStopId } = request
  const modes = normalizeModes(request.travelModes)
  const index = trip.stops.findIndex((stop) => stop.id === targetStopId)
  const target = trip.stops[index]
  if (!target || target.isFixed) {
    // 契約の検証で弾かれるはずの入力。呼び出し側が検証を省いた場合の、最後の防波堤。
    return { status: 'no_candidates', message: '固定されていない予定を指定してください。' }
  }
  // Gemini・Mapsを呼ぶ前に弾く（乗車・乗換は施設として照合しない）。
  if (target.kind === 'transport') {
    return { status: 'insufficient_information', message: TRANSPORT_TARGET_MESSAGE }
  }
  if (!matchesRevisionReportTarget(request.context, targetStopId)) {
    return {
      status: 'insufficient_information',
      message: '報告対象を修正対象と一致させてください。',
    }
  }

  const { systemInstruction, prompt } = buildRevisionPrompt(request)
  let text: string
  try {
    // 課金対象のGemini呼び出しは1回だけ。失敗時の自動再試行はしない。
    text = await client.generateJson({
      systemInstruction,
      prompt,
      responseJsonSchema: buildRevisionResponseJsonSchema(),
    })
  } catch (error) {
    if (error instanceof GeminiCallError) {
      report?.({ kind: 'gemini_call', reason: error.reason, status: error.status })
      return externalFailure(GEMINI_FAILURE_MESSAGES[error.reason])
    }
    report?.({
      kind: 'unexpected_client_error',
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return externalFailure(GEMINI_FAILURE_MESSAGES.api_error)
  }

  const invalidOutput = (detail: string): ProposalFailure => {
    report?.({ kind: 'invalid_output', detail })
    return {
      status: 'external_service_error',
      message:
        'AIの結果が条件を満たさなかったため、候補を作れませんでした。もう一度お試しください。',
    }
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return invalidOutput('JSONとして解釈できない')
  }
  const parsed = RevisionDraftSchema.safeParse(json)
  if (!parsed.success) return invalidOutput('下書きの形式が不正')
  const draft = parsed.data
  const counts: CandidateCounts = {
    kind: 'candidate_counts',
    generated: draft.candidates.length,
    filtered: 0,
    nameExclusions: {},
    identified: 0,
    unidentified: {},
    mapsFailed: 0,
    violated: 0,
    violations: {},
    samePlace: 0,
    duplicatePlace: 0,
    unknown: 0,
    unknownReasons: {},
    satisfied: 0,
  }
  if (draft.failure) {
    if (counts.generated > 0) return invalidOutput('失敗の申告と候補が混在')
    report?.(counts)
    return { status: draft.failure.status, message: `AIの回答: ${draft.failure.reason}` }
  }

  // 元の予定と名称が完全一致する案や、他の予定と名称が重複する案は照会しない。
  // 元の予定と似た名称（別支店など）は、Place IDで比較する。
  const otherNames = new Set(
    trip.stops.filter((stop) => stop.id !== targetStopId).map((stop) => nameKey(stop.name)),
  )
  const taken = new Set<string>()
  const candidates = draft.candidates.filter((candidate) => {
    const { base, full } = parseName(candidate.name)
    if (!base) {
      counts.nameExclusions.invalid = (counts.nameExclusions.invalid ?? 0) + 1
      return false
    }
    if (
      taken.has(full) ||
      otherNames.has(base) ||
      compareNames(target.name, candidate.name) === 'exact'
    ) {
      counts.nameExclusions.duplicate = (counts.nameExclusions.duplicate ?? 0) + 1
      return false
    }
    taken.add(full)
    return true
  })
  counts.filtered = candidates.length
  if (candidates.length === 0) {
    report?.(counts)
    return noCandidatesAfterCheck(counts)
  }

  const checkedAt = (now?.() ?? new Date()).toISOString()
  const surroundings = await resolveSurroundings(trip, index, maps)
  if (surroundings.originalLookupFailed) {
    report?.({ kind: 'original_place_lookup_failed' })
    return externalFailure(MAPS_FAILURE_MESSAGE)
  }

  // 変更前の移動区間は、同じリクエストの中で、1回だけ測る（候補どうしで共有する）。
  const beforeSides = await measureSides(surroundings, target, surroundings.originalPlaceId, {
    maps,
    modes,
    checkedAt,
  })

  const candidateMeasurements = new Map<string, Promise<MeasuredSides>>()
  const evaluations = await Promise.all(
    candidates.map((candidate) =>
      evaluateCandidate(trip, surroundings, candidate.name, {
        maps,
        modes,
        checkedAt,
        context: request.context,
        candidateMeasurements,
      }),
    ),
  )
  // 除外した別名の根拠も集約する。営業時間の欠落と、具体的な営業状態は区別する。
  const hoursByPlace = new Map<
    string,
    {
      consistent: boolean
      conflicting: boolean
      businessStatuses: Set<string>
      hasCandidate: boolean
    }
  >()
  for (const evaluation of evaluations) {
    if (evaluation.kind !== 'judged') continue
    const { after, hoursStatus, businessStatus, judgement } = evaluation
    const observed = hoursByPlace.get(after.placeId) ?? {
      consistent: false,
      conflicting: false,
      businessStatuses: new Set<string>(),
      hasCandidate: false,
    }
    observed.consistent ||= hoursStatus === 'consistent'
    observed.conflicting ||= hoursStatus === 'conflicting'
    observed.hasCandidate ||= judgement.status === 'candidate'
    if (
      businessStatus === 'OPERATIONAL' ||
      businessStatus === 'CLOSED_TEMPORARILY' ||
      businessStatus === 'CLOSED_PERMANENTLY' ||
      businessStatus === 'FUTURE_OPENING'
    ) {
      observed.businessStatuses.add(businessStatus)
    }
    hoursByPlace.set(after.placeId, observed)
  }
  const hoursConflicts = new Map<string, string>()
  for (const [placeId, { consistent, conflicting, businessStatuses }] of hoursByPlace) {
    const temporaryClosure = businessStatuses.has('CLOSED_TEMPORARILY')
    const restricted =
      temporaryClosure ||
      businessStatuses.has('FUTURE_OPENING') ||
      businessStatuses.has('CLOSED_PERMANENTLY')
    if (businessStatuses.size > 1 || (consistent && (conflicting || restricted))) {
      hoursConflicts.set(placeId, temporaryClosure ? TEMPORARY_CLOSURE_CONFLICT : HOURS_CONFLICT)
    }
  }

  const byPlace = new Map<
    string,
    {
      after: Stop
      sides: MeasuredSides
      constraintCheck: ConstraintCheck
      travelBefore: Evidence | null
      travelAfter: Evidence | null
      unknownReasons: UnknownReason[]
    }
  >()
  for (const evaluation of evaluations) {
    if (evaluation.kind === 'maps_failed') {
      counts.mapsFailed += 1
      continue
    }
    if (evaluation.kind === 'unidentified') {
      const { reason } = evaluation
      counts.unidentified[reason] = (counts.unidentified[reason] ?? 0) + 1
      continue
    }
    counts.identified += 1
    if (evaluation.kind === 'same_place') {
      counts.samePlace += 1
      continue
    }
    const {
      after,
      judgement,
      hoursStatus,
      businessStatus,
      sides,
      travelBefore,
      travelAfter,
      unknownReasons,
    } = evaluation
    const observed = hoursByPlace.get(after.placeId)
    if (judgement.status === 'excluded') {
      if (
        hoursStatus === 'conflicting' &&
        observed?.hasCandidate &&
        hoursConflicts.has(after.placeId)
      ) {
        counts.duplicatePlace += 1
      } else {
        counts.violated += 1
        if (judgement.reason === 'violated') {
          for (const reason of judgement.violations) {
            const observedReason =
              reason === 'hours' && businessStatus === 'CLOSED_PERMANENTLY'
                ? 'permanently_closed'
                : reason
            counts.violations[observedReason] = (counts.violations[observedReason] ?? 0) + 1
          }
        }
      }
      continue
    }
    // 営業時間が欠落した別名で、同じ施設・同じ滞在時間帯の営業時間外を打ち消さない。
    if (observed?.conflicting && !hoursConflicts.has(after.placeId)) {
      counts.duplicatePlace += 1
      continue
    }
    const constraintCheck = judgement.constraintCheck
    const existing = byPlace.get(after.placeId)
    if (existing) counts.duplicatePlace += 1
    if (
      !existing ||
      (existing.constraintCheck.status !== 'satisfied' &&
        (constraintCheck.status === 'satisfied' ||
          (existing.unknownReasons.includes('hours') && hoursStatus === 'consistent')))
    ) {
      byPlace.set(after.placeId, {
        after,
        sides,
        constraintCheck,
        travelBefore,
        travelAfter,
        unknownReasons,
      })
    }
  }

  for (const [placeId, candidate] of byPlace) {
    const conflict = hoursConflicts.get(placeId)
    if (!conflict) continue
    const { after, constraintCheck } = candidate
    // 照合結果どうしの矛盾を根拠に残し、保存時に失われる矛盾を既存の署名処理で拒む。
    candidate.after = {
      ...after,
      evidence: after.evidence.map((item) =>
        item.subject === 'opening_hours'
          ? {
              ...item,
              status: 'conflicting',
              claim: '同じ施設に対する営業状態と営業時間の照合結果が一致している',
              explanation: conflict,
            }
          : item,
      ),
    }
    candidate.constraintCheck = {
      status: 'unknown',
      explanation:
        conflict +
        (constraintCheck.status === 'unknown'
          ? constraintCheck.explanation
          : '確認できるまで、承認できません。'),
    }
    candidate.unknownReasons = [
      ...candidate.unknownReasons.filter((reason) => reason !== 'hours'),
      'hours_conflict',
    ]
  }

  // 同じ判定の候補はGeminiの順序を保つ。未確認の候補より、成立を確認できた候補を先に比較できる。
  const ordered = [...byPlace.values()].sort(
    (a, b) =>
      Number(b.constraintCheck.status === 'satisfied') -
      Number(a.constraintCheck.status === 'satisfied'),
  )
  for (const { constraintCheck, unknownReasons } of ordered) {
    if (constraintCheck.status === 'satisfied') {
      counts.satisfied += 1
    } else {
      counts.unknown += 1
      for (const reason of unknownReasons)
        counts.unknownReasons[reason] = (counts.unknownReasons[reason] ?? 0) + 1
    }
  }
  report?.(counts)
  if (ordered.length === 0) {
    return counts.mapsFailed > 0
      ? externalFailure(MAPS_FAILURE_MESSAGE)
      : noCandidatesAfterCheck(counts)
  }

  const revisions: Revision[] = []
  const comparisons: TravelComparison[] = []
  for (const { after, sides, constraintCheck, travelBefore, travelAfter } of ordered) {
    const id = `revision-${createId()}`
    revisions.push({
      id,
      tripId: trip.id,
      baseTripVersion: trip.version,
      targetStopId,
      reason: request.reason,
      context: request.context,
      diff: { before: target, after },
      impactSummary: impactSummary(target, after, { travelBefore, travelAfter }, constraintCheck),
      constraintCheck,
      approval: { status: 'pending' },
    })
    comparisons.push({
      revisionId: id,
      originalPlaceId: surroundings.originalPlaceId,
      routeEndpoints: {
        previousPlaceId: surroundings.previousPlaceId,
        nextPlaceId: surroundings.nextPlaceId,
      },
      ...(surroundings.failedPlaceLookups.length > 0
        ? { failedPlaceLookups: surroundings.failedPlaceLookups }
        : {}),
      before: {
        fromPrevious: slotOf(beforeSides.fromPrevious, 'first_stop'),
        toNext: slotOf(beforeSides.toNext, 'last_stop'),
      },
      after: {
        fromPrevious: slotOf(sides.fromPrevious, 'first_stop'),
        toNext: slotOf(sides.toNext, 'last_stop'),
      },
    })
  }

  // 返却前に、共通契約で検証する。契約に反する結果を、呼び出し側へ流さない。
  const checked = ReviseTripResponseSchema.safeParse({ status: 'proposed', revisions, comparisons })
  if (!checked.success) return invalidOutput('応答が共通契約に違反')
  return checked.data
}
