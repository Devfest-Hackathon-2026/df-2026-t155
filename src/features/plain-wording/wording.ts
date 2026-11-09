// 平易な言葉への変換で使う文言の定数。画面とテストで再利用する唯一の元データ。
// 内部の状態（根拠・制約・承認・移動区間）は変えず、表示用の言葉にだけ対応づける。
import type { Approval, Evidence, EvidenceStatus, TravelMode } from '@/domain'

export const TRANSPORT_REVISION_UNAVAILABLE = '乗車・乗換は部分修正の対象外です。'

// 状態の「意味」。色の決定は画面側で行う（色だけで区別しないこと）。
// - ok: 確認できた／条件を満たす
// - conflict: 食い違い／条件に合わない
// - unknown: 確認したが、確認できなかった・判断できない
// - none: まだ確認していない（未照合・未検証・未照会）
// - demo: デモ用の想定（実測や照合の結果ではない）
export type Tone = 'ok' | 'conflict' | 'unknown' | 'none' | 'demo'

// 本人の判断は、根拠・制約とは別の軸。語彙も混ぜない。
export type ApprovalTone = 'pending' | 'approved' | 'rejected'

export type EvidenceSubject = Evidence['subject']
export type EvidenceSourceKind = Evidence['source']['kind']
export type ApprovalStatus = Approval['status']

// 根拠の対象（見出しの頭に付ける）。
export const SUBJECT_LABELS: Record<EvidenceSubject, string> = {
  place_identity: '施設',
  opening_hours: '営業時間',
  travel_time: '移動',
  other: 'その他',
}

// 文中で使う出典の呼び方（「◯◯で確認しました」の形で使う）。
export const SOURCE_PHRASES: Record<EvidenceSourceKind, string> = {
  places: 'Google Maps',
  routes: 'Google Maps',
  official: '公式情報',
  user_report: '本人の現地報告',
  simulation: 'デモ用の模擬データ',
}

// 出典の種別名（出典・照合日時の行で使う）。
export const SOURCE_KIND_LABELS: Record<EvidenceSourceKind, string> = {
  places: 'Google Places',
  routes: 'Google Routes',
  official: '公式情報',
  user_report: '本人の現地報告',
  simulation: '模擬データ（デモ用）',
}

export const SOURCE_PLACEHOLDER = '{source}'

// 実測の出典（simulation以外）の文言。見出しは「対象：」の後ろに続く部分。
export const EVIDENCE_WORDING: Record<
  EvidenceSubject,
  Record<EvidenceStatus, { headline: string; detail: string; tone: Tone }>
> = {
  place_identity: {
    consistent: {
      headline: '確認できた',
      detail: `${SOURCE_PLACEHOLDER}で、名称が一致する施設を見つけました。実在や当日の営業を保証するものではありません。`,
      tone: 'ok',
    },
    conflicting: {
      headline: '情報が食い違っています',
      detail: `${SOURCE_PLACEHOLDER}の情報と、施設の名称や場所が一致しません。内容を確認してから判断してください。`,
      tone: 'conflict',
    },
    unverifiable: {
      headline: '確認できない',
      detail: `${SOURCE_PLACEHOLDER}では、一致する施設を確認できませんでした。実在しないという意味ではありません。`,
      tone: 'unknown',
    },
  },
  // 営業時間・移動は、共有の照合ロジックが実際に見ている範囲だけを書く。
  // - 営業時間：予定の滞在時間帯が、通常営業時間に収まるか（臨時休業・祝日の変更は見ていない）。
  // - 移動：Routesで見積もった所要時間が、予定間の使える時間に収まるか（渋滞・遅延は見ていない）。
  // 制約全体の成立（営業時間内・間に合う見込み）は、制約判定の役割で、ここでは結論にしない。
  opening_hours: {
    consistent: {
      headline: '情報源と整合',
      detail:
        '予定の時間帯が、通常営業時間の情報源と整合しています。臨時休業・祝日の変更などは考慮していません。',
      tone: 'ok',
    },
    conflicting: {
      headline: '矛盾あり',
      detail:
        '情報源では、予定の時間帯に営業していない可能性があります（通常営業時間に合わない、閉業の記載があるなど）。',
      tone: 'conflict',
    },
    unverifiable: {
      headline: '確認できない',
      detail: '対象日の営業時間を確認できませんでした。営業しているとは判断していません。',
      tone: 'unknown',
    },
  },
  travel_time: {
    consistent: {
      headline: '情報源と整合',
      detail:
        '情報源で見積もった所要時間が、予定の間隔に収まっています。渋滞・遅延は考慮していません。',
      tone: 'ok',
    },
    conflicting: {
      headline: '矛盾あり',
      detail: '情報源で見積もった所要時間が、予定の間隔に収まりません。',
      tone: 'conflict',
    },
    unverifiable: {
      headline: '確認できない',
      detail: '移動にかかる時間を確認できませんでした。仮の値や推定値で補っていません。',
      tone: 'unknown',
    },
  },
  other: {
    consistent: {
      headline: '情報源と一致',
      detail: `${SOURCE_PLACEHOLDER}の情報と一致しました。現実の正しさを保証するものではありません。`,
      tone: 'ok',
    },
    conflicting: {
      headline: '情報が食い違っています',
      detail: `${SOURCE_PLACEHOLDER}の情報と食い違っています。内容を確認してから判断してください。`,
      tone: 'conflict',
    },
    unverifiable: {
      headline: '確認できない',
      detail: '情報源で確認できませんでした。',
      tone: 'unknown',
    },
  },
}

// 出典がsimulation（模擬）のとき。実測・照合を思わせる文言（確認できた・間に合う見込み等）は使わない。
export const SIMULATION_NOTE =
  'デモ用の模擬データです。実際の施設・営業時間・移動を確認した結果ではありません。'

export const SIMULATION_WORDING: Record<
  EvidenceStatus,
  { headline: string; detail: string; tone: Tone }
> = {
  consistent: { headline: 'デモ用の想定', detail: SIMULATION_NOTE, tone: 'demo' },
  conflicting: {
    headline: 'デモ用の想定（食い違いあり）',
    detail: SIMULATION_NOTE,
    tone: 'conflict',
  },
  unverifiable: {
    headline: 'デモ用の想定（確認できない）',
    detail: SIMULATION_NOTE,
    tone: 'unknown',
  },
}

// 根拠が空（evidence: []）。「確認したが確認できなかった」とは別の状態。
export const UNCHECKED_WORDING = {
  label: '未照合（まだ確認していません）',
  detail: 'まだ照合していません。確認できなかったという意味ではありません。',
  tone: 'none',
} as const satisfies { label: string; detail: string; tone: Tone }

export const REASON_PREFIX = '理由：'

// 制約判定（決定論的に検証した結果）。何を検証したかは契約に含まれないため、
// 文脈（ConstraintContext）で渡された範囲だけを書き、分からない項目は断定しない。
export const CONSTRAINT_WORDING = {
  satisfied: {
    tone: 'ok',
    canApprove: true,
  },
  violated: {
    label: '条件に合いません',
    detail: '別の案を選ぶか、条件を見直してください。',
    tone: 'conflict',
    canApprove: false,
  },
  unknown: {
    detail:
      '確認が必要な条件を確認できなかったため、判断できません。承認できる案としては扱いません。',
    tone: 'unknown',
    canApprove: false,
  },
  not_checked: {
    label: 'まだ検証していません',
    detail: '条件に合うか、まだ確かめていません。承認できる案としては扱いません。',
    tone: 'none',
    canApprove: false,
  },
} as const

// satisfiedの見出し。次の予定が固定で、次の移動区間も検証したときだけ「固定予定」と言う。
export const CONSTRAINT_SATISFIED_LABELS = {
  nextFixed: '次の固定予定に間に合う見込み',
  nextStop: '次の予定に間に合う見込み',
  withOpeningHours: '営業時間などの確認した条件を満たす見込み',
  generic: '確認した条件を満たす見込み',
} as const

// unknownの見出し。次の移動区間があるときだけ「間に合うか」と言う。
export const CONSTRAINT_UNKNOWN_LABELS = {
  withNextSegment: '間に合うか確認できません',
  withMovement: '移動の条件を確認できません',
  generic: '条件を確認できません',
} as const

// satisfiedの補足は、文脈で渡された「実際に検証した項目」だけを書く。
export const CONSTRAINT_CHECKED_ITEMS = {
  openingHours: '営業時間',
  previousSegment: '前の予定からの移動',
  nextSegment: '次の予定への移動',
} as const
export const CONSTRAINT_CHECKED_SUFFIX = 'を検証した結果です。'
export const CONSTRAINT_CHECKED_UNKNOWN_SCOPE = '確認した範囲での結果です。'
export const CONSTRAINT_MODES_PREFIX = '移動の手段：'
export const CONSTRAINT_NOT_CONSIDERED = '臨時休業・渋滞・遅延は考慮していません。'
export const MODES_UNSPECIFIED = '手段は未指定'

export const MODE_LABELS: Record<TravelMode, string> = {
  walk: '徒歩',
  drive: '車',
  transit: '公共交通',
}

// 本人の承認（根拠・制約とは別の軸）。
export const APPROVAL_WORDING: Record<
  ApprovalStatus,
  { label: string; detail?: string; tone: ApprovalTone }
> = {
  pending: {
    label: 'まだ旅程には反映されていません',
    detail: 'あなたが承認するまで、元の旅程は変わりません。',
    tone: 'pending',
  },
  approved: { label: '承認済み', tone: 'approved' },
  rejected: {
    label: '見送りました',
    detail: 'この案は旅程には反映されていません。',
    tone: 'rejected',
  },
}

// 移動区間。
export const TRAVEL_ROUTES_NOTE = '渋滞・遅延は考慮していません。'
export const TRAVEL_ROUTES_CONFIRMED = 'Google Mapsで確認'
export const TRAVEL_SIMULATION_NOTE =
  'デモ用の模擬データです。実際の経路を確認した結果ではありません。'
export const TRAVEL_DEMO_SUFFIX = 'デモ用の想定'
export const TRAVEL_UNKNOWN_NOTE = '所要時間は、仮の値や推定値で補っていません。'

export const TRAVEL_UNKNOWN_WORDING = {
  not_queried: { label: '移動時間は、まだ確認していません', tone: 'none' },
  transit_unsupported: { label: '公共交通は、確認の対象外です', tone: 'unknown' },
  no_route: { label: '移動時間を確認できません（経路が見つかりませんでした）', tone: 'unknown' },
  api_error: { label: '移動時間を確認できません（取得に失敗しました）', tone: 'unknown' },
} as const satisfies Record<string, { label: string; tone: Tone }>

// 移動時間の比較。
export const CHANGE_WORDING = {
  unconfirmed: '未確認（比べられません）',
  same: '変わらない',
  unknownSegment: 'どちらかの移動時間を確認できていないため、差は出していません。',
  differentSection: '別の区間の値のため、差は出していません。',
  differentMode: '移動手段が違うため、時間の差は出していません。',
  differentSource: '確認方法（実際の確認とデモ用の想定）が違うため、差は出していません。',
} as const
