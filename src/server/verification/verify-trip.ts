import { TripSchema, type Evidence, type Stop, type Trip } from '../../domain'
import { MapsCallError, type MapsClient, type PlaceCandidate } from '../maps'
import { selectPlace, type PlaceSelection } from './name-match'
import { checkOpeningHours } from './opening-hours'
import {
  measureSegment,
  normalizeModes,
  segmentEvidenceFields,
  type SegmentMeasurement,
  type TravelModeSetting,
} from './segment'
import { availableMinutes, formatMinutes, hasTimeConflict, toMinutes } from './travel'

// 旅程の各予定を、Google Maps Platform（Places・Routes）の情報と照合し、根拠（Evidence）を付ける。
// - AIの提案（生成）と、照合は別の責務。ここでは、提案された予定を変更せず、根拠だけを付ける。
// - 結果は「情報源と整合」「矛盾あり」「確認できない」の3状態。整合は、現実の正しさの保証ではない。
// - 施設の存在（place_identity）、対象日の営業時間（opening_hours）、前の予定からの移動（travel_time）は別の根拠。
// - 呼び出しの失敗・候補なし・名称の不一致は、いずれも「確認できない」とし、推測で埋めない。
// - 保存してよいのはPlace IDだけ。Placesの名称・営業時間・Routesの所要時間は、ここで使うだけで保存しない。
//   また、Places由来の事実（名称・営業時間の値）は、根拠の説明文に載せない
//   （Googleマップ以外の画面に出すときの帰属表示の条件を、満たす前に値を表示しないため）。
//   移動だけは、計画上の余裕から導いた「余裕◯分／◯分不足」を載せる。Routesの所要時間そのものではなく
//   判断の結果で、利用者が移動の無理を判断するために必要なため。出典（Routes API）は根拠に付ける。

const SOURCE_LABEL_PLACES = 'Google Maps Platform（Places API）'

export interface VerifyDeps {
  maps: Pick<MapsClient, 'searchPlaces' | 'computeRoute'>
  now?: () => Date
  // 移動が間に合うかを確認する、利用者が使える手段。省略時は徒歩だけ（車を使えるとは限らないため）。
  travelModes?: readonly TravelModeSetting[]
}

export type VerifyTripResult =
  | { status: 'verified'; trip: Trip; calls: { places: number; routes: number } }
  // 全ての予定で、Mapsの呼び出し自体が失敗した（設定・認証・接続の失敗）。根拠は付けない。
  | { status: 'external_service_error'; message: string }
  // 予定の時刻が重なっている・時刻順でない旅程（入力の不備）。Mapsは呼ばない。
  | { status: 'invalid_trip'; message: string }

export type PlaceLookup =
  | { kind: 'selected'; selection: PlaceSelection }
  | { kind: 'failed'; reason: MapsCallError['reason'] }

const stopApplicability = (trip: Trip, stop: Stop) =>
  `${trip.date} ${stop.plannedStartTime}（${trip.timeZone}）`

export function evidence(
  stop: Stop,
  suffix: string,
  fields: Omit<Evidence, 'id' | 'checkedAt'>,
  checkedAt: string,
): Evidence {
  return { id: `evidence-${stop.id}-${suffix}`, checkedAt, ...fields }
}

export function identityEvidence(
  trip: Trip,
  stop: Stop,
  lookup: PlaceLookup,
  checkedAt: string,
): Evidence {
  const base = {
    subject: 'place_identity' as const,
    claim: `「${stop.name}」が、Google Maps上の施設として特定できる`,
    applicability: '施設の存在のみ（対象日の営業は、別の項目）',
    source: { kind: 'places' as const, label: SOURCE_LABEL_PLACES },
  }
  if (lookup.kind === 'failed') {
    return evidence(
      stop,
      'place',
      {
        ...base,
        status: 'unverifiable',
        explanation:
          '施設の検索に失敗したため、確認できません。時間をおいて、もう一度お試しください。',
      },
      checkedAt,
    )
  }
  const { selection } = lookup
  switch (selection.status) {
    case 'matched':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'consistent',
          explanation:
            '名称が一致する施設を、Google Mapsで見つけました。実在や、当日の営業を保証するものではありません。',
        },
        checkedAt,
      )
    case 'ambiguous':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'unverifiable',
          explanation: `名称が一致する候補が${selection.count}件あり、1つに絞れないため、確認できません。`,
        },
        checkedAt,
      )
    case 'region_mismatch':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'unverifiable',
          explanation:
            '名称は一致しましたが、所在地が旅程の地域と一致する施設を確認できないため、同じ施設と判断できず、確認できません。',
        },
        checkedAt,
      )
    case 'mismatch':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'unverifiable',
          explanation:
            '検索で見つかった施設の名称が、予定の名称と一致しないため、同じ施設と判断できず、確認できません。',
        },
        checkedAt,
      )
    case 'no_candidates':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'unverifiable',
          explanation: 'Google Mapsで、該当する施設を見つけられなかったため、確認できません。',
        },
        checkedAt,
      )
  }
}

// 日本標準時のタイムゾーンか。別名（'Japan'など）も、'Asia/Tokyo'として扱う。解釈できなければfalse。
export function isJapanTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone === 'Asia/Tokyo'
  } catch {
    return false
  }
}

// 旅程のタイムゾーンと、施設の現地時刻が同じと確かめられないときの理由（確かめられるときはnull）。
// MVPが対象とするのは、日本（Asia/Tokyo）の旅程だけ。採用する施設は、住所の行政区画（都道府県・市区町村）を
// 日本の住所として読み取れ、旅程の地域と一致したものだけ（施設の同定の条件。`name-match.ts`）なので、
// 施設の現地時刻は、日本標準時と同じ。住所に「Japan」の文字が含まれるかどうかでは、判定しない。
function timeZoneProblem(trip: Trip): string | null {
  return isJapanTimeZone(trip.timeZone)
    ? null
    : `旅程のタイムゾーン（${trip.timeZone}）では、施設の現地時刻との対応を確認できないため、営業時間を確認できません。`
}

// Placesの営業状態。取得できない・未指定・通常（OPERATIONAL）なら、通常営業時間で判定する（問題なし）。
// 閉業は、営業中と判定できないため矛盾あり。一時休業・開業前・未知の状態は、確認できない。
// 説明文には、Placesの値そのものを載せない。
function businessStatusProblem(
  status: string | undefined,
): { status: 'conflicting' | 'unverifiable'; explanation: string } | null {
  if (
    status === undefined ||
    status === 'OPERATIONAL' ||
    status === 'BUSINESS_STATUS_UNSPECIFIED'
  ) {
    return null
  }
  if (status === 'CLOSED_PERMANENTLY') {
    return {
      status: 'conflicting',
      explanation: '情報源では、この施設は閉業している可能性があります。営業中とは確認できません。',
    }
  }
  return {
    status: 'unverifiable',
    explanation:
      '情報源では、この施設は通常どおりの営業ではない可能性があり（休業中・開業前など）、予定の時間に営業しているかを確認できません。',
  }
}

export function hoursEvidence(
  trip: Trip,
  stop: Stop,
  place: PlaceCandidate | null,
  checkedAt: string,
): Evidence {
  const base = {
    subject: 'opening_hours' as const,
    claim: `${trip.date}の${stop.plannedStartTime}から${stop.durationMinutes}分、営業している`,
    applicability: `${stopApplicability(trip, stop)}の通常営業時間`,
    source: { kind: 'places' as const, label: SOURCE_LABEL_PLACES },
  }
  if (!place) {
    return evidence(
      stop,
      'hours',
      {
        ...base,
        status: 'unverifiable',
        explanation: '施設を特定できていないため、営業時間を確認できません。',
      },
      checkedAt,
    )
  }
  // 営業時間は、施設の現地時刻で表される。旅程のタイムゾーンと同じと確かめられるときだけ、照合する。
  // 日本でない旅程では営業時間を要求しないため、データの有無より先に判定する。
  const zoneProblem = timeZoneProblem(trip)
  if (zoneProblem) {
    return evidence(
      stop,
      'hours',
      { ...base, status: 'unverifiable', explanation: zoneProblem },
      checkedAt,
    )
  }
  // 営業状態が通常でない施設は、通常営業時間のデータが残っていても、営業中と判定しない。
  const statusProblem = businessStatusProblem(place.businessStatus)
  if (statusProblem) {
    return evidence(stop, 'hours', { ...base, ...statusProblem }, checkedAt)
  }
  if (place.openingHours.status !== 'available') {
    return evidence(
      stop,
      'hours',
      {
        ...base,
        status: 'unverifiable',
        explanation:
          place.openingHours.status === 'invalid'
            ? '営業時間のデータ形式を解釈できないため、確認できません。'
            : '営業時間のデータが取得できないため、確認できません。',
      },
      checkedAt,
    )
  }
  const result = checkOpeningHours(
    place.openingHours.periods,
    trip.date,
    stop.plannedStartTime,
    stop.durationMinutes,
  )
  return evidence(
    stop,
    'hours',
    { ...base, status: result.status, explanation: result.explanation },
    checkedAt,
  )
}

// 検索語に使う地域。括弧書きの補足（「（架空デモ）」など）は、検索の邪魔になるため除く。除いて空なら、そのまま使う。
const searchRegion = (region: string): string =>
  region
    .normalize('NFKC')
    .replace(/\([^)]*\)/g, '')
    .trim() || region

// 施設を検索し、名称が一致する施設だけを採用する。営業時間（Enterprise）は、必要なときだけ要求する
// （Place IDだけが必要な場合は、要求せず、費用を抑える）。
export async function lookupPlace(
  maps: Pick<MapsClient, 'searchPlaces'>,
  trip: Pick<Trip, 'region'>,
  stop: Pick<Stop, 'name'>,
  options: { includeOpeningHours?: boolean } = {},
): Promise<{ lookup: PlaceLookup; place: PlaceCandidate | null }> {
  try {
    const result = await maps.searchPlaces({
      query: `${stop.name} ${searchRegion(trip.region)}`,
      maxResultCount: 3,
      includeOpeningHours: options.includeOpeningHours ?? true,
    })
    const selection = selectPlace(
      stop.name,
      trip.region,
      result.status === 'found' ? result.candidates : [],
    )
    return {
      lookup: { kind: 'selected', selection },
      place: selection.status === 'matched' ? selection.place : null,
    }
  } catch (error) {
    return {
      lookup: { kind: 'failed', reason: error instanceof MapsCallError ? error.reason : 'network' },
      place: null,
    }
  }
}

// 前の予定から、この予定へ間に合うかの根拠。利用者が使える手段（既定は徒歩だけ）で確認する。
// 構造化された移動区間（SegmentMeasurement）から、根拠の説明を作る。
export function travelEvidenceFor(
  trip: Pick<Trip, 'date'>,
  previous: Stop,
  stop: Stop,
  measurement: SegmentMeasurement,
  checkedAt: string,
  suffix = 'travel',
): Evidence | null {
  const available = availableMinutes({ previous, next: stop })
  const prevEnd = formatMinutes(toMinutes(previous.plannedStartTime) + previous.durationMinutes)
  const fields = segmentEvidenceFields(measurement, {
    claim: '前の予定の終了後、この予定の開始時刻までに移動できる',
    applicability: `${trip.date} ${prevEnd}〜${stop.plannedStartTime}（使える時間${available}分）`,
  })
  // Routesを照会していない区間は、根拠を付けない（Routes由来の確認結果として扱わない）。
  return fields ? evidence(stop, suffix, fields, checkedAt) : null
}

export async function verifyTrip(input: Trip, deps: VerifyDeps): Promise<VerifyTripResult> {
  const { maps, now = () => new Date() } = deps
  const checkedAt = now().toISOString()
  const counter = { places: 0, routes: 0 }

  // 時刻の重なりは、移動を調べるまでもなく成立しない（ハンドラーの事前チェックとの二重化）。
  if (hasTimeConflict(input.stops)) {
    return {
      status: 'invalid_trip',
      message: '予定の時刻が重なっているか、時刻順に並んでいません。',
    }
  }

  // 営業時間（最上位の課金区分）は、照合できる日本の旅程のときだけ要求する。
  const includeOpeningHours = isJapanTimeZone(input.timeZone)

  // 予定ごとの施設検索（最大4件）。並行して呼ぶ。
  // 乗車・乗換は施設ではないため、Placesを呼ばない（nullは「照会していない」）。
  const lookups = await Promise.all(
    input.stops.map(async (stop) => {
      if (stop.kind === 'transport') return null
      counter.places += 1
      return lookupPlace(maps, input, stop, { includeOpeningHours })
    }),
  )

  // Placesを実際に呼んだ予定が、すべて失敗したときだけ、外部サービスの失敗とする。
  const queried = lookups.filter((item) => item !== null)
  if (queried.length > 0 && queried.every((item) => item.lookup.kind === 'failed')) {
    return {
      status: 'external_service_error',
      message:
        'Google Mapsとの通信に失敗したため、根拠を照合できませんでした。時間をおいて、もう一度お試しください。',
    }
  }

  const modes = normalizeModes(deps.travelModes)
  const travel = await Promise.all(
    input.stops.map(async (stop, index) => {
      if (index === 0) return null
      const previous = input.stops[index - 1]
      const measurement = await measureSegment(maps, {
        fromStopId: previous.id,
        toStopId: stop.id,
        fromPlaceId: lookups[index - 1]?.place?.placeId ?? null,
        toPlaceId: lookups[index]?.place?.placeId ?? null,
        availableMinutes: availableMinutes({ previous, next: stop }),
        modes,
        checkedAt,
        counter,
      })
      return travelEvidenceFor(input, previous, stop, measurement, checkedAt)
    }),
  )

  const stops = input.stops.map((stop, index): Stop => {
    const looked = lookups[index]
    // 乗車・乗換は、照合していない。Places由来の根拠を付けない。
    if (!looked) return { ...stop, placeId: null, evidence: [] }
    const { lookup, place } = looked
    const items = [
      identityEvidence(input, stop, lookup, checkedAt),
      hoursEvidence(input, stop, place, checkedAt),
      ...(travel[index] ? [travel[index]] : []),
    ]
    // 入力のPlace IDと根拠は、クライアントの自己申告として破棄し、今回の照合結果だけにする。
    // Place IDは、名称が一致した施設だけに付ける（保存してよい唯一のMaps由来の値）。
    return { ...stop, placeId: place?.placeId ?? null, evidence: items }
  })

  // 予定の内容（名称・時刻・滞在・固定）は変えず、根拠とPlace IDだけを付けた旅程を、契約で検証して返す。
  const verified = TripSchema.parse({ ...input, stops })
  return { status: 'verified', trip: verified, calls: counter }
}
