import { GenerateTripRequestSchema, type GenerateTripRequest } from '@/domain'

// 旅程作成フォームの入力値と、生成リクエスト（共通契約）への変換・検証。
// 固定予定（時刻が決まっている予定）は、利用者の申告として`fixedStops`（`isFixed: true`）で送る。
// 固定は、予約・購入を意味しない。施設の照合は、生成後に別の機能（照合）で行う。
// 承認済みの学びは、このフォームでは扱わないため、空配列で契約に整合させる。

// 固定予定の入力1件分（入力途中の文字列のまま保持し、作成時に検証する）。
export interface FixedStopRow {
  // 画面上の識別子（入力欄の対応づけ用。リクエストのIDとは別）。
  key: string
  name: string
  // 開始時刻（HH:MM）
  startTime: string
  // 滞在時間（分）
  duration: string
}

export interface TripFormValues {
  region: string
  date: string
  // 1行に1つの希望条件（任意）。
  preferences: string
  fixedStops: FixedStopRow[]
}

export const initialFormValues: TripFormValues = {
  region: '',
  date: '',
  preferences: '',
  fixedStops: [],
}

// 契約（GenerateTripRequest.fixedStops）の上限。
export const MAX_FIXED_STOPS = 4

export type FixedStopField = 'name' | 'startTime' | 'duration'
export type FixedStopErrors = Partial<Record<FixedStopField, string>>
// 入力行の識別子（FixedStopRow.key）ごとの不備。
export type FixedStopErrorMap = Record<string, FixedStopErrors>

// MVPは国内の日帰り旅行が対象。タイムゾーンの入力欄は設けず、日本時間に固定する。
export const DEFAULT_TIME_ZONE = 'Asia/Tokyo'

export type TripFormField = 'region' | 'date' | 'preferences'
export type TripFormErrors = Partial<Record<TripFormField, string>>

// フォームの項目を画面上の並び順で並べる（最初の不備へフォーカスを移すのに使う）。
export const formFieldOrder: readonly TripFormField[] = ['region', 'date', 'preferences']

export type BuildRequestResult =
  | { ok: true; request: GenerateTripRequest }
  // fixedStopErrorsは、固定予定に不備があるときだけ持つ。
  | { ok: false; errors: TripFormErrors; fixedStopErrors?: FixedStopErrorMap }

export function parsePreferences(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY_MINUTES = 1440
const toMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))

const isFixedStopField = (value: unknown): value is FixedStopField =>
  value === 'name' || value === 'startTime' || value === 'duration'

// 固定予定の入力を検証する（行ごとの不備。時刻が重なる固定予定も検出する）。
export function validateFixedStops(rows: readonly FixedStopRow[]): FixedStopErrorMap {
  const errors: FixedStopErrorMap = {}
  const setError = (row: FixedStopRow, field: FixedStopField, message: string) => {
    errors[row.key] = { ...errors[row.key], [field]: errors[row.key]?.[field] ?? message }
  }
  const spans: { row: FixedStopRow; start: number; end: number }[] = []

  rows.forEach((row, index) => {
    if (index >= MAX_FIXED_STOPS) {
      setError(row, 'name', `固定予定は、最大${MAX_FIXED_STOPS}件までです`)
    }
    if (row.name.trim() === '') setError(row, 'name', '予定の名前を入力してください')

    const startOk = TIME_PATTERN.test(row.startTime)
    if (row.startTime === '') setError(row, 'startTime', '開始時刻を入力してください')
    else if (!startOk) setError(row, 'startTime', '正しい時刻を入力してください')

    const duration = row.duration.trim()
    let minutes: number | null = null
    if (duration === '') {
      setError(row, 'duration', '滞在時間（分）を入力してください')
    } else if (!/^\d+$/.test(duration)) {
      setError(row, 'duration', '滞在時間は、数字（分）で入力してください')
    } else if (Number(duration) < 1) {
      setError(row, 'duration', '滞在時間は、1分以上にしてください')
    } else if (Number(duration) > DAY_MINUTES) {
      setError(row, 'duration', `滞在時間は、${DAY_MINUTES}分以内にしてください`)
    } else {
      minutes = Number(duration)
    }

    if (startOk && minutes !== null) {
      const start = toMinutes(row.startTime)
      if (start + minutes > DAY_MINUTES) {
        setError(row, 'duration', '滞在が、その日の24:00までに収まるようにしてください')
      } else {
        spans.push({ row, start, end: start + minutes })
      }
    }
  })

  // 固定予定どうしの時刻の重なり（開始の早い順に、直前の終了と比べる）。
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  sorted.forEach((span, index) => {
    if (index > 0 && span.start < sorted[index - 1].end) {
      setError(span.row, 'startTime', '他の固定予定と、時間が重なっています')
    }
  })
  return errors
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
  const fixedStopErrors = validateFixedStops(values.fixedStops)

  const parsed = GenerateTripRequestSchema.safeParse({
    date: values.date.trim(),
    region: values.region,
    timeZone: DEFAULT_TIME_ZONE,
    preferences: parsePreferences(values.preferences),
    // IDは、並び順で付ける。入力は申告であり、施設は特定しない（placeIdなし・根拠なし）。
    fixedStops: values.fixedStops.map((row, index) => ({
      id: `fixed-${index + 1}`,
      name: row.name,
      placeId: null,
      plannedStartTime: row.startTime,
      durationMinutes: Number(row.duration.trim()),
      isFixed: true,
      evidence: [],
    })),
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
      // 固定予定：行の検証で拾えなかった契約違反も、その行の項目に結び付ける。
      if (field === 'fixedStops' && typeof issue.path[1] === 'number') {
        const row = values.fixedStops[issue.path[1]]
        const stopField = issue.path[2] === 'plannedStartTime' ? 'startTime' : issue.path[2]
        if (
          row &&
          isFixedStopField(stopField) &&
          fixedStopErrors[row.key]?.[stopField] === undefined
        ) {
          fixedStopErrors[row.key] = {
            ...fixedStopErrors[row.key],
            [stopField]: '入力内容を確認してください',
          }
        }
      }
    }
  }

  const hasFixedStopErrors = Object.keys(fixedStopErrors).length > 0
  if (Object.keys(errors).length > 0 || hasFixedStopErrors) {
    return { ok: false, errors, ...(hasFixedStopErrors ? { fixedStopErrors } : {}) }
  }
  if (!parsed.success) {
    // どの項目にも結び付かない契約違反。通常は起きないが、黙って送らない。
    return { ok: false, errors: { region: '入力内容を確認してください' } }
  }
  return { ok: true, request: parsed.data }
}

// 最初に不備がある固定予定の入力欄（行の並び順、行の中は名前・開始時刻・滞在時間の順）。なければundefined。
export function firstInvalidFixedStop(
  rows: readonly FixedStopRow[],
  errors: FixedStopErrorMap,
): { key: string; field: FixedStopField } | undefined {
  for (const row of rows) {
    const field = (['name', 'startTime', 'duration'] as const).find(
      (name) => errors[row.key]?.[name] !== undefined,
    )
    if (field) return { key: row.key, field }
  }
  return undefined
}

// 最初に不備がある項目（画面上の並び順）。なければundefined。
export function firstInvalidField(errors: TripFormErrors): TripFormField | undefined {
  return formFieldOrder.find((field) => errors[field] !== undefined)
}
