import { TripSchema, type Evidence, type Stop, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'

// 照合まわりのテストで共有する、サーバーの実際の出力に合わせた模擬データ。
// 根拠のid・主張の形は、verify-trip.ts / revise-trip.ts が実際に作るものと同じにする
// （移動の根拠の方向は、idの命名規約で決まるため。契約のテストで実物と突き合わせている）。

export const PLACES_LABEL = 'Google Maps Platform（Places API）'
export const ROUTES_LABEL = 'Google Maps Platform（Routes API）'

export const CHECKED_AT = '2026-11-08T10:00:00+09:00'

// 照合前の旅程（AIの提案）：根拠もPlace IDもない。朝と14時の予定は固定、昼食は固定でない。
export const generated: Trip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
})

const pad = (value: number) => String(value).padStart(2, '0')
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

export function identityEvidence(
  stop: Stop,
  status: Evidence['status'] = 'consistent',
  checkedAt = CHECKED_AT,
): Evidence {
  return {
    id: `evidence-${stop.id}-place`,
    subject: 'place_identity',
    claim: `「${stop.name}」が、Google Maps上の施設として特定できる`,
    applicability: '施設の存在のみ（対象日の営業は、別の項目）',
    source: { kind: 'places', label: PLACES_LABEL },
    checkedAt,
    status,
    explanation:
      status === 'consistent'
        ? '名称が一致する施設を、Google Mapsで見つけました。'
        : 'Google Mapsで、該当する施設を見つけられなかったため、確認できません。',
  }
}

export function hoursEvidence(
  stop: Stop,
  status: Evidence['status'] = 'consistent',
  checkedAt = CHECKED_AT,
): Evidence {
  return {
    id: `evidence-${stop.id}-hours`,
    subject: 'opening_hours',
    claim: `2026-11-08の${stop.plannedStartTime}から${stop.durationMinutes}分、営業している`,
    applicability: `2026-11-08 ${stop.plannedStartTime}（Asia/Tokyo）の通常営業時間`,
    source: { kind: 'places', label: PLACES_LABEL },
    checkedAt,
    status,
    explanation:
      status === 'consistent'
        ? '通常営業時間の範囲内です。'
        : '施設を特定できていないため、営業時間を確認できません。',
  }
}

// 前の予定から、この予定への移動（この予定に付く）。
export function travelEvidence(
  stop: Stop,
  previous: Stop,
  status: Evidence['status'] = 'consistent',
  checkedAt = CHECKED_AT,
): Evidence {
  const end = clock(toMinutes(previous.plannedStartTime) + previous.durationMinutes)
  return {
    id: `evidence-${stop.id}-travel`,
    subject: 'travel_time',
    claim: '前の予定の終了後、この予定の開始時刻までに移動できる',
    applicability: `2026-11-08 ${end}〜${stop.plannedStartTime}（使える時間${toMinutes(stop.plannedStartTime) - toMinutes(end)}分）`,
    source: { kind: 'routes', label: ROUTES_LABEL },
    checkedAt,
    status,
    explanation:
      status === 'consistent' ? '徒歩で間に合う見込みです（余裕10分）。' : '確認できません。',
  }
}

// この予定から、次の予定への移動（この予定に付く。部分修正の候補だけが作る）。
export function travelNextEvidence(
  stop: Stop,
  next: Stop,
  status: Evidence['status'] = 'consistent',
  checkedAt = CHECKED_AT,
): Evidence {
  const end = clock(toMinutes(stop.plannedStartTime) + stop.durationMinutes)
  return {
    id: `evidence-${stop.id}-travel-next`,
    subject: 'travel_time',
    claim: 'この予定の終了後、次の予定の開始時刻までに移動できる',
    applicability: `2026-11-08 ${end}〜${next.plannedStartTime}（使える時間${toMinutes(next.plannedStartTime) - toMinutes(end)}分）`,
    source: { kind: 'routes', label: ROUTES_LABEL },
    checkedAt,
    status,
    explanation:
      status === 'consistent' ? '徒歩で間に合う見込みです（余裕10分）。' : '確認できません。',
  }
}

export const userReport = (id = 'evidence-user-report'): Evidence => ({
  id,
  subject: 'opening_hours',
  claim: '現地で営業を確認した',
  applicability: '2026-11-08 12:00（Asia/Tokyo）に本人が現地で見た内容',
  source: { kind: 'user_report', label: '本人の現地報告' },
  checkedAt: '2026-11-08T11:50:00+09:00',
  status: 'consistent',
  explanation: '本人が現地で確認した内容です。',
})

export interface ServerOptions {
  // 施設を特定できない予定のid（Place IDなし、根拠は「確認できない」）。
  unidentified?: readonly string[]
  checkedAt?: string
  // 乗車・乗換など、照会しない予定のid（Place IDも根拠もなし）。
  skipped?: readonly string[]
}

// 照合APIの模擬：送られた旅程の根拠とPlace IDを捨てて、今回の照合結果だけを付けて返す（サーバーの実際の挙動）。
export function serverVerified(trip: Trip, options: ServerOptions = {}): Trip {
  const { unidentified = [], skipped = [], checkedAt = CHECKED_AT } = options
  return TripSchema.parse({
    ...trip,
    stops: trip.stops.map((stop, index) => {
      if (skipped.includes(stop.id)) return { ...stop, placeId: null, evidence: [] }
      const identified = !unidentified.includes(stop.id)
      const status = identified ? 'consistent' : 'unverifiable'
      const previous = trip.stops[index - 1]
      // 前後どちらかの施設を特定できない区間は、Routesを呼ばず、移動の根拠を付けない（実際のサーバーと同じ）。
      const routable =
        previous &&
        identified &&
        !unidentified.includes(previous.id) &&
        !skipped.includes(previous.id)
      return {
        ...stop,
        placeId: identified ? `place-${stop.id}` : null,
        evidence: [
          identityEvidence(stop, status, checkedAt),
          hoursEvidence(stop, status, checkedAt),
          ...(routable ? [travelEvidence(stop, previous, 'consistent', checkedAt)] : []),
        ],
      }
    }),
  })
}

// 4件の予定の旅程（隣接する2件の連続差し替えを試すため）。朝だけが固定。
export const generated4: Trip = TripSchema.parse({
  ...generated,
  stops: [
    generated.stops[0],
    { ...generated.stops[1], isFixed: false },
    {
      id: 'stop-walk',
      name: '散策（架空）',
      placeId: null,
      plannedStartTime: '13:45',
      durationMinutes: 60,
      isFixed: false,
      evidence: [],
    },
    {
      id: 'stop-cafe',
      name: '喫茶店（架空）',
      placeId: null,
      plannedStartTime: '15:30',
      durationMinutes: 60,
      isFixed: false,
      evidence: [],
    },
  ],
})

// 部分修正の適用の模擬：1件の予定を差し替え、その予定にだけ、候補の根拠（施設・営業時間・前後の移動）を付ける。
// 他の予定は、そのまま（版だけ進む）。実際の適用と同じ形。
export function revisedStop(trip: Trip, id: string, name: string, checkedAt: string): Trip {
  const index = trip.stops.findIndex((stop) => stop.id === id)
  const base: Stop = { ...trip.stops[index], name }
  const previous = trip.stops[index - 1]
  const next = trip.stops[index + 1]
  const replaced: Stop = {
    ...base,
    placeId: `place-${id}-${name}`,
    evidence: [
      identityEvidence(base, 'consistent', checkedAt),
      hoursEvidence(base, 'consistent', checkedAt),
      ...(previous ? [travelEvidence(base, previous, 'consistent', checkedAt)] : []),
      ...(next ? [travelNextEvidence(base, next, 'consistent', checkedAt)] : []),
    ],
  }
  return {
    ...trip,
    version: trip.version + 1,
    stops: trip.stops.map((stop, position) => (position === index ? replaced : stop)),
  }
}
