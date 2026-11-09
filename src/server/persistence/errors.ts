import { z } from 'zod'

const failures = {
  persistence_disabled: [503, '保存機能は現在利用できません。'],
  invalid_request: [400, '入力の形式または内容が正しくありません。'],
  payload_too_large: [413, '入力データが大きすぎます。'],
  unsupported_media_type: [415, 'Content-Typeにapplication/jsonを指定してください。'],
  version_conflict: [409, '保存内容の版が変わりました。最新の内容を確認してください。'],
  storage_limit_reached: [409, '保存できる件数の上限に達しました。'],
  learning_revoked: [409, '撤回済みの学びです。再保存する場合は新しいIDを使ってください。'],
  body_read_timeout: [408, '保存リクエストの受信に時間がかかりすぎました。'],
  learning_trip_save_disabled: [503, '学びの適用記録を含む旅程の保存は現在停止中です。'],
  learning_trip_upgrade_required: [
    409,
    'この旅程を開くにはページを再読み込みして更新してください。',
  ],
  learning_place_provenance_invalid: [
    422,
    '場所の識別子を照合結果と確認できません。根拠を確認し直してください。',
  ],
  learning_changed: [
    409,
    '学びが変更または撤回されました。学びを選び直して旅程を作り直してください。',
  ],
  learning_provenance_missing: [409, '生成時の学びを確認できません。旅程を作り直してください。'],
  learning_provenance_invalid: [422, '旅程または学びの適用記録が生成時の内容と一致しません。'],
  learning_provenance_expired: [
    409,
    '学びの適用記録を保存できる期限が切れました。旅程を作り直してください。',
  ],
  learning_provenance_unavailable: [503, '生成時の学びを確認するサービスを利用できません。'],
  already_exists: [409, '同じIDの保存データが存在します。'],
  revision_mismatch: [409, '現在の旅程と変更候補の対象が一致しません。'],
  revision_not_pending: [409, 'この変更候補はすでに決定されています。'],
  revision_travel_modes_missing: [
    409,
    '移動手段を確認できないため、変更候補を作り直してください。',
  ],
  revision_apply_disabled: [503, '変更の適用は現在利用できません。'],
  revision_simulated: [422, '模擬報告から作った変更候補は適用できません。'],
  revision_provenance_invalid: [422, '生成した変更候補と一致しません。'],
  revision_report_changed: [409, '本人報告の状態が変わりました。最新の状態を確認してください。'],
  revision_endpoints_changed: [
    409,
    '前後の予定の施設が変わりました。候補を比較し直して承認してください。',
  ],
  revision_provenance_missing: [409, '候補の来歴を確認できません。候補を作り直してください。'],
  revision_proposal_expired: [409, '変更候補の有効期限が切れました。候補を作り直してください。'],
  revision_provenance_unavailable: [503, '候補の来歴を確認するサービスを利用できません。'],
  revision_not_applicable: [422, '現在の旅程では、この変更候補を適用できません。'],
  revision_place_mismatch: [422, '変更候補や前後の予定の施設を確認し直してください。'],
  revision_unverified: [422, '必要な情報を確認できなかったため、変更を適用できません。'],
  external_service_error: [502, '外部サービスで変更候補を確認できませんでした。'],
  apply_result_unknown: [503, '適用結果を確認できません。最新の旅程と変更候補を取得してください。'],
  internal_error: [500, '保存処理中に予期しないエラーが発生しました。'],
  invalid_stored_data: [500, '保存データの形式を確認できませんでした。'],
  storage_unavailable: [503, '保存サービスを利用できません。時間をおいて再試行してください。'],
} as const

export class PersistenceError extends Error {
  constructor(readonly code: keyof typeof failures) {
    super(failures[code][1])
    this.name = 'PersistenceError'
  }

  get status() {
    return failures[this.code][0]
  }
}

// Zodで形が確定したデータを走査する。JSONのエスケープで入る孤立サロゲートも、
// Firestoreへ渡す前に拒否する。
function hasWellFormedStrings(value: unknown): boolean {
  if (typeof value === 'string') return value.isWellFormed()
  if (value === null || typeof value !== 'object') return true
  return Object.entries(value).every(
    ([key, field]) => key.isWellFormed() && hasWellFormedStrings(field),
  )
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success || !hasWellFormedStrings(result.data)) {
    throw new PersistenceError('invalid_request')
  }
  return result.data
}

export function parseStored<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success || !hasWellFormedStrings(result.data)) {
    throw new PersistenceError('invalid_stored_data')
  }
  return result.data
}
