import { GenerateTripRequestSchema, type GenerateTripRequest } from '@/domain'

// 旅程作成フォームの入力値と、生成リクエスト（共通契約）への変換・検証。
// 初期フォームでは固定予定と承認済みの学びを扱わないため、空配列で契約に整合させる。

export interface TripFormValues {
  region: string
  date: string
  // 1行に1つの希望条件（任意）。
  preferences: string
}

export const initialFormValues: TripFormValues = { region: '', date: '', preferences: '' }

// MVPは国内の日帰り旅行が対象。タイムゾーンの入力欄は設けず、日本時間に固定する。
export const DEFAULT_TIME_ZONE = 'Asia/Tokyo'

export type TripFormField = 'region' | 'date' | 'preferences'
export type TripFormErrors = Partial<Record<TripFormField, string>>

// フォームの項目を画面上の並び順で並べる（最初の不備へフォーカスを移すのに使う）。
export const formFieldOrder: readonly TripFormField[] = ['region', 'date', 'preferences']

export type BuildRequestResult =
  { ok: true; request: GenerateTripRequest } | { ok: false; errors: TripFormErrors }

export function parsePreferences(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const isFormField = (value: unknown): value is TripFormField =>
  formFieldOrder.some((field) => field === value)

export function buildGenerateTripRequest(values: TripFormValues): BuildRequestResult {
  const errors: TripFormErrors = {}
  if (values.region.trim() === '') {
    errors.region = '旅行先を入力してください'
  }
  if (values.date.trim() === '') {
    errors.date = '日付を選んでください'
  }

  const parsed = GenerateTripRequestSchema.safeParse({
    date: values.date.trim(),
    region: values.region,
    timeZone: DEFAULT_TIME_ZONE,
    preferences: parsePreferences(values.preferences),
    fixedStops: [],
    learnings: [],
  })
  if (!parsed.success) {
    // 未入力は上で案内済み。ここでは契約に反する入力（存在しない日付など）を項目に結び付ける。
    for (const issue of parsed.error.issues) {
      const field = issue.path[0]
      if (isFormField(field) && errors[field] === undefined) {
        errors[field] =
          field === 'date' ? '正しい日付を選んでください' : '入力内容を確認してください'
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }
  if (!parsed.success) {
    // どの項目にも結び付かない契約違反。通常は起きないが、黙って送らない。
    return { ok: false, errors: { region: '入力内容を確認してください' } }
  }
  return { ok: true, request: parsed.data }
}

// 最初に不備がある項目（画面上の並び順）。なければundefined。
export function firstInvalidField(errors: TripFormErrors): TripFormField | undefined {
  return formFieldOrder.find((field) => errors[field] !== undefined)
}
