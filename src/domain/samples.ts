import { GenerateTripRequestSchema, ReviseTripRequestSchema } from './contracts'
import { ApprovedLearningSchema, LearningSchema, TripSchema } from './models'
import { RevisionSchema } from './revision'

// 全施設・Place ID・時刻・照合結果は架空。実APIの応答や営業情報ではない。
export const sampleApprovedLearning = ApprovedLearningSchema.parse({
  id: 'learning-rest',
  sourceTripId: 'trip-previous',
  category: 'preference',
  content: '昼食後に休憩時間を確保したい',
  scope: { kind: 'all_trips' },
  approval: { status: 'approved', decidedAt: '2026-11-01T18:00:00+09:00' },
})

export const sampleTrip = TripSchema.parse({
  id: 'trip-demo',
  version: 0,
  date: '2026-11-08',
  region: '京都市・東山（架空デモ）',
  timeZone: 'Asia/Tokyo',
  preferences: ['ゆっくり街歩きしたい'],
  stops: [
    {
      id: 'stop-morning',
      name: '朝の庭園（架空）',
      placeId: null,
      plannedStartTime: '10:00',
      durationMinutes: 60,
      isFixed: true,
      evidence: [
        {
          id: 'evidence-garden',
          subject: 'place_identity',
          claim: '庭園の施設同定',
          applicability: '模擬施設データのみ。実在・営業は照合していない',
          source: { kind: 'simulation', label: '架空デモの施設照合データ' },
          checkedAt: '2026-11-05T12:00:00+09:00',
          status: 'consistent',
          explanation: '模擬情報源と整合。実在や当日の営業を保証しない',
        },
      ],
    },
    {
      id: 'stop-lunch',
      name: '昼食店A（架空）',
      placeId: null,
      plannedStartTime: '12:00',
      durationMinutes: 75,
      isFixed: false,
      evidence: [
        {
          id: 'evidence-lunch',
          subject: 'opening_hours',
          claim: '12時に昼食店Aを利用できる',
          applicability: '2026-11-08 12:00 Asia/Tokyoの模擬報告',
          source: { kind: 'simulation', label: '臨時休業の模擬報告' },
          checkedAt: '2026-11-08T11:45:00+09:00',
          status: 'conflicting',
          explanation: '模擬シナリオでは閉店しており、予定と矛盾する',
        },
      ],
    },
    {
      id: 'stop-exhibition',
      name: '14時の予約展示（架空）',
      placeId: null,
      plannedStartTime: '14:00',
      durationMinutes: 60,
      isFixed: true,
      evidence: [
        {
          id: 'evidence-exhibition',
          subject: 'opening_hours',
          claim: '予約展示が当日開催される',
          applicability: '2026-11-08 14:00 Asia/Tokyo',
          source: { kind: 'simulation', label: '架空デモ・開催情報なし' },
          checkedAt: '2026-11-05T12:00:00+09:00',
          status: 'unverifiable',
          explanation: '当日の開催情報を取得していない',
        },
      ],
    },
  ],
  learningApplications: [
    {
      learningId: sampleApprovedLearning.id,
      targetStopIds: ['stop-lunch'],
      explanation: '昼食と休憩のため滞在時間を60分から75分にした（架空の適用例）',
    },
  ],
})

export const sampleGenerateTripRequest = GenerateTripRequestSchema.parse({
  date: sampleTrip.date,
  region: sampleTrip.region,
  timeZone: sampleTrip.timeZone,
  preferences: sampleTrip.preferences,
  fixedStops: sampleTrip.stops.filter((stop) => stop.isFixed),
  learnings: [sampleApprovedLearning],
})

export const sampleReviseTripRequest = ReviseTripRequestSchema.parse({
  trip: sampleTrip,
  targetStopId: 'stop-lunch',
  reason: '昼食店が閉まっているため、昼食だけを変更したい',
  context: {
    phase: 'on_site',
    report: { kind: 'simulated', description: '昼食店Aの臨時休業（模擬報告）' },
  },
})

const lunch = sampleTrip.stops[1]

export const sampleRevision = RevisionSchema.parse({
  id: 'revision-lunch-b',
  tripId: sampleTrip.id,
  baseTripVersion: sampleTrip.version,
  targetStopId: lunch.id,
  reason: sampleReviseTripRequest.reason,
  context: sampleReviseTripRequest.context,
  diff: {
    before: lunch,
    after: {
      ...lunch,
      name: '昼食店B（架空候補）',
      evidence: [
        {
          id: 'evidence-lunch-b',
          subject: 'opening_hours',
          claim: '昼食店Bが当日営業している',
          applicability: '2026-11-08 12:00 Asia/Tokyo',
          source: { kind: 'simulation', label: '架空デモ・代替候補' },
          checkedAt: '2026-11-08T11:46:00+09:00',
          status: 'unverifiable',
          explanation: '候補を置いた段階であり、営業情報は照合していない',
        },
      ],
    },
  },
  impactSummary: '昼食のみ差し替える候補。14時の固定予約への移動の影響は未検証',
  constraintCheck: { status: 'not_checked', explanation: 'Routes接続・制約検証は未実装' },
  approval: { status: 'pending' },
})

export const sampleLearning = LearningSchema.parse({
  id: 'learning-backup-lunch',
  sourceTripId: sampleTrip.id,
  category: 'verification',
  content: '昼食の営業情報を当日確認し、代替候補を用意したい',
  scope: { kind: 'region', region: sampleTrip.region },
  approval: { status: 'pending' },
})
