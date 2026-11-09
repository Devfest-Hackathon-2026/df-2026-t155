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
import { compareNames, parseName } from '../verification/name-match'
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
import { judgeCandidate, type CandidateChecks, type CandidateJudgement } from './constraints'
import { buildRevisionResponseJsonSchema, RevisionDraftSchema } from './draft'
import { buildRevisionPrompt } from './prompt'

// 利用者の入力やAIの出力本文は含めない。原因の区分だけを記録する。
export type RevisionFailureEvent =
  | { kind: 'gemini_call'; reason: GeminiCallFailureReason; status?: number }
  | { kind: 'unexpected_client_error'; errorName: string }
  | { kind: 'invalid_output'; detail: string }
  | {
      kind: 'candidate_counts'
      generated: number
      filtered: number
      identified: number
      mapsFailed: number
      violated: number
      samePlace: number
      unknown: number
      satisfied: number
    }

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
  // 乗車・乗換は施設ではないため、Placesを呼ばない（nullは「照会していない」。経路の根拠はunknownになる）。
  const placeId = async (stop: Stop | null) => {
    if (!stop || stop.kind === 'transport') return { id: null, mismatch: false }
    const { place } = await lookupPlace(maps, trip, stop, { includeOpeningHours: false })
    return {
      id: confirmedOriginalPlaceId(stop, place?.placeId),
      mismatch: Boolean(place && stop.placeId !== null && place.placeId !== stop.placeId),
    }
  }
  const [previousLookup, nextLookup, original] = await Promise.all([
    placeId(previous),
    placeId(next),
    lookupPlace(maps, trip, target, { includeOpeningHours: false }),
  ])
  return {
    target,
    previous,
    next,
    previousPlaceId: previousLookup.id,
    nextPlaceId: nextLookup.id,
    adjacentPlaceMismatch: previousLookup.mismatch || nextLookup.mismatch,
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
  | { kind: 'excluded'; explanation: string }
  | {
      kind: 'judged'
      after: Stop
      judgement: CandidateJudgement
      sides: MeasuredSides
      travelBefore: Evidence | null
      travelAfter: Evidence | null
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
  const { target, previous, next, originalPlaceId } = surroundings
  const candidate: Stop = { ...target, name: candidateName, placeId: null, evidence: [] }

  const { lookup, place } = await lookupPlace(maps, trip, candidate, { includeOpeningHours: true })
  if (lookup.kind === 'failed') return { kind: 'maps_failed' }

  const identity = identityEvidence(trip, candidate, lookup, checkedAt)
  const noSides: MeasuredSides = { fromPrevious: null, toNext: null }
  // 施設を特定できない候補は、候補にしないため、移動は調べない（Routesの呼び出しを節約）。
  if (!place) {
    const checks: CandidateChecks = {
      identity,
      hours: null,
      expectsTravelBefore: previous !== null,
      travelBefore: null,
      expectsTravelAfter: next !== null,
      travelAfter: null,
    }
    return {
      kind: 'judged',
      after: candidate,
      judgement: judgeCandidate(checks),
      sides: noSides,
      travelBefore: null,
      travelAfter: null,
    }
  }

  if (place.placeId === originalPlaceId) {
    return { kind: 'excluded', explanation: '元の予定と同じ施設のため、差し替えられません。' }
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
  const after: Stop = {
    ...candidate,
    placeId: place.placeId,
    evidence: [
      identity,
      hours,
      ...(travelBefore ? [travelBefore] : []),
      ...(travelAfter ? [travelAfter] : []),
      ...priorConflicts,
    ],
  }
  const uncertainties: string[] = []
  if (!originalPlaceId) {
    uncertainties.push('元の施設を特定できず、候補と別の施設か確認できていません。')
  }
  if (
    target.evidence.some((item) => isRevisionEvidenceConflict(item, 'original')) ||
    priorConflicts.length > 0
  ) {
    uncertainties.push('承認に関係する根拠の矛盾が解消できていません。')
  }
  if (reportUncertainty) uncertainties.push(reportUncertainty)
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
  return { kind: 'judged', after, judgement, sides, travelBefore, travelAfter }
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
  if (evaluation.kind === 'excluded') {
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

const NO_CANDIDATES_AFTER_CHECK =
  '元の予定と同じ施設、施設を特定できない、または営業時間・前後の移動の条件を満たさない候補を除いた結果、提案できる候補がありません。理由や条件を変えて、もう一度お試しください。元の旅程は、そのままです。'

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
  if (draft.failure) {
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
    if (
      !base ||
      taken.has(full) ||
      otherNames.has(base) ||
      compareNames(target.name, candidate.name) === 'exact'
    )
      return false
    taken.add(full)
    return true
  })
  if (candidates.length === 0) {
    report?.({
      kind: 'candidate_counts',
      generated: draft.candidates.length,
      filtered: 0,
      identified: 0,
      mapsFailed: 0,
      violated: 0,
      samePlace: 0,
      unknown: 0,
      satisfied: 0,
    })
    return {
      status: 'no_candidates',
      message:
        '元の予定や他の予定と異なる候補を作れませんでした。理由や条件を変えて、もう一度お試しください。',
    }
  }

  const checkedAt = (now?.() ?? new Date()).toISOString()
  const surroundings = await resolveSurroundings(trip, index, maps)
  if (surroundings.originalLookupFailed) return externalFailure(MAPS_FAILURE_MESSAGE)

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
  report?.({
    kind: 'candidate_counts',
    generated: draft.candidates.length,
    filtered: candidates.length,
    identified: evaluations.filter(
      (e) => e.kind === 'excluded' || (e.kind === 'judged' && !!e.after.placeId),
    ).length,
    mapsFailed: evaluations.filter((e) => e.kind === 'maps_failed').length,
    violated: evaluations.filter(
      (e) =>
        e.kind === 'judged' &&
        e.judgement.status === 'excluded' &&
        e.judgement.reason === 'violated',
    ).length,
    samePlace: evaluations.filter((e) => e.kind === 'excluded').length,
    unknown: evaluations.filter(
      (e) =>
        e.kind === 'judged' &&
        e.judgement.status === 'candidate' &&
        e.judgement.constraintCheck.status === 'unknown',
    ).length,
    satisfied: evaluations.filter(
      (e) =>
        e.kind === 'judged' &&
        e.judgement.status === 'candidate' &&
        e.judgement.constraintCheck.status === 'satisfied',
    ).length,
  })
  if (evaluations.every((evaluation) => evaluation.kind === 'maps_failed')) {
    return externalFailure(MAPS_FAILURE_MESSAGE)
  }

  const byPlace = new Map<
    string,
    {
      after: Stop
      sides: MeasuredSides
      constraintCheck: ConstraintCheck
      travelBefore: Evidence | null
      travelAfter: Evidence | null
    }
  >()
  for (const evaluation of evaluations) {
    if (evaluation.kind !== 'judged' || evaluation.judgement.status !== 'candidate') continue
    const { after, judgement, sides, travelBefore, travelAfter } = evaluation
    if (!after.placeId) continue
    const constraintCheck = judgement.constraintCheck
    const existing = byPlace.get(after.placeId)
    if (
      !existing ||
      (existing.constraintCheck.status !== 'satisfied' && constraintCheck.status === 'satisfied')
    ) {
      byPlace.set(after.placeId, { after, sides, constraintCheck, travelBefore, travelAfter })
    }
  }

  const revisions: Revision[] = []
  const comparisons: TravelComparison[] = []
  for (const { after, sides, constraintCheck, travelBefore, travelAfter } of byPlace.values()) {
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

  if (revisions.length === 0) return { status: 'no_candidates', message: NO_CANDIDATES_AFTER_CHECK }

  // 返却前に、共通契約で検証する。契約に反する結果を、呼び出し側へ流さない。
  const checked = ReviseTripResponseSchema.safeParse({ status: 'proposed', revisions, comparisons })
  if (!checked.success) return invalidOutput('応答が共通契約に違反')
  return checked.data
}
