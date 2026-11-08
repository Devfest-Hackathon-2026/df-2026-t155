import {
  RevisionContextSchema,
  type OnSiteReportCategory,
  type RevisionContext,
  type Stop,
  type Trip,
} from '@/domain'

// 現地の状況の報告フォームの、純粋なロジック（表示を持たない）。
// 保存・API呼び出し・再計画の処理は持たない。出力は OnSiteReportSubmission として親へ渡す。

export const MAX_NOTE_LENGTH = 500

// 何が起きたか（プリセット）。選ぶだけで送れる。「その他」だけは、補足が必須。
export const REPORT_PRESETS = [
  { id: 'closed', label: '閉店・臨時休業だった' },
  { id: 'crowded', label: '混んでいて入れない・待ち時間が長い' },
  { id: 'delayed', label: '遅れていて、次の予定に間に合わない' },
  { id: 'other', label: 'その他' },
] as const

export type PresetId = OnSiteReportCategory

// 報告の説明文は「プリセットの文言」か「プリセットの文言＋この区切り＋補足」。
// 構造化された報告の種類と併せて従来の説明文表現を維持するため、形をここで固定する。
export const NOTE_SEPARATOR = '。補足：'

// 実際の現地報告と、デモ用の模擬報告。共通契約（RevisionContext）の kind とそのまま対応する。
export type ReportKind = 'actual' | 'simulated'

export type OnSiteContext = Extract<RevisionContext, { phase: 'on_site' }>

// 親へ渡す送信データ。再計画の入力（ReviseTripRequest の targetStopId・reason・context）に対応する。
export interface OnSiteReportSubmission {
  targetStopId: string
  reason: string
  context: OnSiteContext
}

// 未選択は空文字で持つ（既定の報告の種類・対象を、利用者の代わりに決めない）。
export interface ReportFormValues {
  targetStopId: string
  preset: PresetId | ''
  note: string
  kind: ReportKind | ''
}

export type ReportField = 'target' | 'preset' | 'note' | 'kind'
export type ReportFormErrors = Partial<Record<ReportField, string>>

// 画面の上から下への順。最初の不備へフォーカスを移すときの順序でもある。
export const REPORT_FIELD_ORDER: readonly ReportField[] = ['target', 'preset', 'note', 'kind']

// 固定予定は、修正の対象にできない。選べる予定（固定されていない予定）だけを返す。
export function selectableStops(trip: Trip): Stop[] {
  return trip.stops.filter((stop) => !stop.isFixed)
}

export function fixedStops(trip: Trip): Stop[] {
  return trip.stops.filter((stop) => stop.isFixed)
}

// 選択中の対象。選べる予定が1件だけなら最初から選択する。
// 旅程が更新されて、選択中の予定が選べなくなった（固定された・無くなった）場合は、未選択に戻す。
// autoSelectSingle が false のときは、選べる予定が1件だけでも選ばない（対象の選び直しを求める場合）。
export function resolveTargetId(trip: Trip, selectedId: string, autoSelectSingle = true): string {
  const selectable = selectableStops(trip)
  if (selectable.some((stop) => stop.id === selectedId)) return selectedId
  return autoSelectSingle && selectable.length === 1 ? selectable[0].id : ''
}

export function initialValues(
  trip: Trip,
  initialTargetStopId?: string,
  autoSelectSingle = true,
): ReportFormValues {
  const requested =
    initialTargetStopId !== undefined &&
    selectableStops(trip).some((stop) => stop.id === initialTargetStopId)
      ? initialTargetStopId
      : ''
  return {
    targetStopId: resolveTargetId(trip, requested, autoSelectSingle),
    preset: '',
    note: '',
    kind: '',
  }
}

export function presetLabel(id: PresetId): string {
  return REPORT_PRESETS.find((preset) => preset.id === id)?.label ?? ''
}

export function firstInvalidField(errors: ReportFormErrors): ReportField | undefined {
  return REPORT_FIELD_ORDER.find((field) => errors[field] !== undefined)
}

export function errorCount(errors: ReportFormErrors): number {
  return REPORT_FIELD_ORDER.filter((field) => errors[field] !== undefined).length
}

export type BuildResult =
  { ok: true; submission: OnSiteReportSubmission } | { ok: false; errors: ReportFormErrors }

// 入力を検証して、送信データを作る。context は共通契約（RevisionContextSchema）で検証して作り、
// 契約に反するものは送らない。空白だけの補足は無視する。
export function buildSubmission(trip: Trip, values: ReportFormValues): BuildResult {
  const errors: ReportFormErrors = {}
  const selectable = selectableStops(trip)

  if (values.targetStopId === '') {
    errors.target =
      selectable.length === 0
        ? '修正できる予定がありません。すべて固定予定のため、ここからは報告できません。'
        : 'どの予定の状況かを選んでください。'
  } else if (!selectable.some((stop) => stop.id === values.targetStopId)) {
    errors.target = trip.stops.some((stop) => stop.id === values.targetStopId)
      ? '固定予定は修正の対象にできません。固定されていない予定を選んでください。'
      : '選んだ予定が見つかりません。もう一度、予定を選んでください。'
  }

  const note = values.note.trim()
  if (values.preset === '') {
    errors.preset = '何が起きたかを選んでください。'
  } else if (values.preset === 'other' && note === '') {
    errors.note = '「その他」を選んだときは、状況を書いてください。'
  }
  if (note.length > MAX_NOTE_LENGTH) {
    errors.note = `補足は${MAX_NOTE_LENGTH}文字以内にしてください。`
  }

  if (values.kind === '') {
    errors.kind = '報告の種類（実際の報告か、デモ用の模擬報告か）を選んでください。'
  }

  if (values.preset === '' || values.kind === '' || Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }

  const label = presetLabel(values.preset)
  const description = note === '' ? label : `${label}${NOTE_SEPARATOR}${note}`
  const reason = `現地の状況：${description}`

  // 送信するデータは、共通契約を通ったものだけにする（通らない場合は送らない）。
  const parsed = RevisionContextSchema.safeParse({
    phase: 'on_site',
    report: {
      kind: values.kind,
      description,
      category: values.preset,
      targetStopId: values.targetStopId,
    },
  })
  if (!parsed.success || parsed.data.phase !== 'on_site') {
    return { ok: false, errors: { preset: '報告の内容を作れませんでした。選び直してください。' } }
  }

  return {
    ok: true,
    submission: { targetStopId: values.targetStopId, reason, context: parsed.data },
  }
}
