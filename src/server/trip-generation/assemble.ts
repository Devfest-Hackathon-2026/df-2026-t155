import { TripSchema, type GenerateTripRequest, type Stop, type Trip } from '../../domain'
import type { GeneratedTripDraft } from './draft'

export type AssembleResult = { ok: true; trip: Trip } | { ok: false; reason: string }

const fail = (reason: string): AssembleResult => ({ ok: false, reason })

const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

// Geminiの下書きを共通のTripに変換する。AIの出力を信用せず、次をサーバー側で保証する。
// - 固定予定は入力どおり（名前・種別・時刻・滞在）に置き換え、過不足なく1回ずつ含める。
//   入力のPlace IDと根拠は未検証の自己申告なので引き継がない。
// - 固定でない地点のIDはサーバーが採番し、AIが指定した予定種別を引き継ぐ。Place IDはnull、根拠は空にする。
// - 地点は時刻順で重ならない（移動時間や営業時間の照合ではない。それは別機能の責務）。
// - 学びの反映は入力にある承認済みの学びだけを、存在する地点に対して記録する。
//   ただし説明文が実際の反映内容と一致するかまでは検証できない。
export function assembleTrip(
  request: GenerateTripRequest,
  draft: GeneratedTripDraft,
  createId: () => string,
): AssembleResult {
  const fixedById = new Map(request.fixedStops.map((stop) => [stop.id, stop]))
  const usedFixedIds = new Set<string>()

  const stops: Stop[] = []
  for (const draftStop of draft.stops) {
    if (draftStop.fixedStopId === null) {
      stops.push({
        id: createId(),
        name: draftStop.name,
        ...(draftStop.kind === undefined ? {} : { kind: draftStop.kind }),
        placeId: null,
        plannedStartTime: draftStop.plannedStartTime,
        durationMinutes: draftStop.durationMinutes,
        isFixed: false,
        evidence: [],
      })
      continue
    }
    const fixed = fixedById.get(draftStop.fixedStopId)
    if (!fixed) {
      return fail('入力にない固定予定IDが指定されました')
    }
    if (usedFixedIds.has(fixed.id)) {
      return fail('同じ固定予定が複数回含まれています')
    }
    usedFixedIds.add(fixed.id)
    // 固定予定の名前・時刻・滞在時間は、AIの出力ではなく利用者が入力した内容をそのまま使う。
    // 一方、Place IDと根拠（evidence）はHTTP入力の自己申告であり、サーバーが照合した結果では
    // ないため引き継がない。未照合として返し、照合はPlaces・Routes連携（#7）で行う。
    stops.push({ ...fixed, placeId: null, evidence: [] })
  }

  if (usedFixedIds.size !== fixedById.size) {
    return fail('固定予定が旅程に含まれていません')
  }

  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1]
    const previousEnd = toMinutes(previous.plannedStartTime) + previous.durationMinutes
    if (toMinutes(stops[index].plannedStartTime) < previousEnd) {
      return fail('地点の時刻が重なっているか、時刻順に並んでいません')
    }
  }

  const approvedLearningIds = new Set(request.learnings.map((learning) => learning.id))
  const appliedLearningIds = new Set<string>()
  const learningApplications: Trip['learningApplications'] = []
  for (const application of draft.learningApplications) {
    if (!approvedLearningIds.has(application.learningId)) {
      return fail('入力にない学びが反映済みとして記録されました')
    }
    if (appliedLearningIds.has(application.learningId)) {
      return fail('同じ学びが複数回記録されています')
    }
    appliedLearningIds.add(application.learningId)

    const targetStopIds: string[] = []
    for (const stopIndex of application.stopIndexes) {
      const stop = stops[stopIndex]
      if (!stop) {
        return fail('学びの反映先に存在しない地点が指定されました')
      }
      if (!targetStopIds.includes(stop.id)) {
        targetStopIds.push(stop.id)
      }
    }
    learningApplications.push({
      learningId: application.learningId,
      targetStopIds,
      explanation: application.explanation,
    })
  }

  const parsed = TripSchema.safeParse({
    id: createId(),
    version: 0,
    date: request.date,
    region: request.region,
    timeZone: request.timeZone,
    preferences: request.preferences,
    stops,
    learningApplications,
  })
  if (!parsed.success) {
    // 値は含めず、どの項目が契約に反したかだけを返す。
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')
    return fail(`共通データモデルの検証に失敗しました（${[...new Set(paths)].join(', ')}）`)
  }
  return { ok: true, trip: parsed.data }
}
