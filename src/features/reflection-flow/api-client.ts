import { z } from 'zod'

import {
  ApprovedLearningSchema,
  TripSchema,
  type ApprovedLearning,
  type Revision,
  type Trip,
} from '@/domain'
import { ClientAuthError } from '@/lib/auth/client'
import { getProtectedApiHeadersForScope } from '@/lib/auth/protected-api'
import {
  classifyProtectedHeaderError,
  classifyProtectedStatus,
  PROTECTED_FAILURE_MESSAGES,
} from '@/lib/auth/protected-api-errors'
import {
  assertCurrentSessionScope,
  assertCurrentSessionScopeSync,
  beginSessionScopeOperation,
  SessionChangedError,
  type SessionScope,
} from '@/lib/auth/session-scope'
import {
  ApproveLearningBodySchema,
  CreateTripBodySchema,
  LearningListResponseSchema,
  ReflectionRevisionSchema,
  VersionedLearningSchema,
  type VersionedLearning,
} from '@/server/persistence/contracts'

import type { LearningStore, SaveResult } from '@/features/learning-review/store'

const ListInfoSchema = z.strictObject({
  returned: z.int().nonnegative(),
  skippedInvalid: z.int().nonnegative(),
  truncated: z.boolean(),
})
const TripListSchema = z.strictObject({
  trips: z.array(TripSchema),
  listInfo: ListInfoSchema,
})
const TripResponseSchema = z.strictObject({ trip: TripSchema })
const RevisionListSchema = z.strictObject({
  revisions: z.array(ReflectionRevisionSchema),
  listInfo: ListInfoSchema,
})
const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

export type TripList = z.infer<typeof TripListSchema>
export type LearningList = z.infer<typeof LearningListResponseSchema>
export type ReflectionHistory = { trip: Trip; revisions: Revision[] }
type ListInfo = z.infer<typeof ListInfoSchema>

// サーバーが返す固定コードに加え、この画面の検査で止めた理由（別の旅程の学びIDとの重複）も同じ形で表す。
export const ID_COLLISION_CODE = 'id_collision'

// 送信した要求の結果が、確定しているか。
// - not_sent: サーバーへ届く前に止まった（認証・セッションの確認、中止）。何も変更されていない。
// - rejected: サーバーが、何も変更せずに拒否した（入力不正・版の食い違いなど、固定コードの応答）。
// - unknown: 送信した後に応答だけを失った、または応答を信頼できない（通信断・タイムアウト・読めない応答・5xx）。
//   サーバーが処理を終えている可能性が残るので、「未保存」と決めつけない。
export type DeliveryOutcome = 'not_sent' | 'rejected' | 'unknown'

export class ReflectionApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly outcome: DeliveryOutcome = 'unknown',
  ) {
    super(message)
    this.name = 'ReflectionApiError'
  }
}

const INTERRUPTED_MESSAGE = '通信に失敗しました。接続を確認して、もう一度お試しください。'
const INVALID_RESPONSE_MESSAGE = '保存サービスから想定外の応答が返されました。'
const PARTIAL_LIST_MESSAGE =
  '保存データの一覧をすべて確認できませんでした。誤った記録を使わないため、操作を中止しました。'
const AUTH_MESSAGE = '認証を確認できません。以前の匿名データを復元できるか確認してください。'
export const SESSION_CHANGED_MESSAGE =
  'セッションが変わったため保存を中止しました。保存済み／未保存／結果不明を再確認してください。'
const GENERIC_MESSAGE = '保存データを取得・更新できませんでした。'

// 利用者に見せてよい、既知のエラーコードの定型文言。
// サーバーのエラー本文はそのまま見せない（未知の本文に、内部の情報が含まれうるため）。
// outcome は、そのコードの応答が「何も変更せずに拒否した」ものか、「処理後の失敗かもしれない」ものか。
const KNOWN_FAILURES: Readonly<
  Record<string, { status: number; message: string; outcome: DeliveryOutcome }>
> = {
  // 認証。サーバーは、保存先に触れる前に拒否する。
  unauthenticated: { status: 401, message: AUTH_MESSAGE, outcome: 'rejected' },
  invalid_token: { status: 401, message: AUTH_MESSAGE, outcome: 'rejected' },
  token_expired: { status: 401, message: AUTH_MESSAGE, outcome: 'rejected' },
  session_revoked: {
    status: 401,
    message: '認証を継続できません。再認証が必要です',
    outcome: 'rejected',
  },
  // 認証基盤（サーバー側）の障害。端末側の認証復元の失敗とは別。
  auth_unavailable: {
    status: 503,
    message: '認証サービスを利用できません。時間をおいて、もう一度お試しください。',
    outcome: 'rejected',
  },
  persistence_disabled: {
    status: 503,
    message: '保存機能は現在利用できません。時間をおいて、もう一度お試しください。',
    outcome: 'rejected',
  },
  not_found: { status: 404, message: '対象が見つかりません。', outcome: 'rejected' },
  invalid_request: {
    status: 400,
    message: '入力の形式または内容が正しくありません。',
    outcome: 'rejected',
  },
  payload_too_large: { status: 413, message: '入力データが大きすぎます。', outcome: 'rejected' },
  unsupported_media_type: {
    status: 415,
    message: '送信の形式が正しくありません。',
    outcome: 'rejected',
  },
  version_conflict: {
    status: 409,
    message: '保存した内容がほかの操作で更新されました。最新の内容を確認してください。',
    outcome: 'rejected',
  },
  already_exists: { status: 409, message: '同じIDの保存データが存在します。', outcome: 'rejected' },
  revision_mismatch: {
    status: 409,
    message: '現在の旅程と変更候補の対象が一致しません。',
    outcome: 'rejected',
  },
  revision_not_pending: {
    status: 409,
    message: '候補は既に決定されています。',
    outcome: 'rejected',
  },
  revision_travel_modes_missing: {
    status: 409,
    message: '移動手段を確認できません。候補を作り直してください。',
    outcome: 'rejected',
  },
  revision_report_changed: {
    status: 409,
    message: '本人報告の状態が変わりました。確認してください。',
    outcome: 'rejected',
  },
  revision_endpoints_changed: {
    status: 409,
    message: '前後の予定が変わりました。候補を作り直してください。',
    outcome: 'rejected',
  },
  revision_provenance_missing: {
    status: 409,
    message: '候補の来歴を確認できません。',
    outcome: 'rejected',
  },
  revision_proposal_expired: {
    status: 409,
    message: '候補の期限が切れました。作り直してください。',
    outcome: 'rejected',
  },
  revision_simulated: { status: 422, message: '模擬報告は適用できません。', outcome: 'rejected' },
  revision_provenance_invalid: {
    status: 422,
    message: '候補の来歴が一致しません。',
    outcome: 'rejected',
  },
  revision_not_applicable: {
    status: 422,
    message: 'この候補を適用できません。',
    outcome: 'rejected',
  },
  revision_place_mismatch: {
    status: 422,
    message: '施設を確認し直してください。',
    outcome: 'rejected',
  },
  revision_unverified: {
    status: 422,
    message: '必要な情報を確認できませんでした。',
    outcome: 'rejected',
  },
  revision_apply_disabled: {
    status: 503,
    message: '変更の適用は現在利用できません。',
    outcome: 'rejected',
  },
  storage_limit_reached: {
    status: 409,
    message: '保存できる件数の上限に達しました。',
    outcome: 'rejected',
  },
  learning_revoked: { status: 409, message: '撤回済みの学びです。', outcome: 'rejected' },
  // 保存先の障害や内部エラーは、書き込みの後に起きた可能性がある。結果は確定しない。
  storage_unavailable: {
    status: 503,
    message: '保存サービスを利用できません。時間をおいて、もう一度お試しください。',
    outcome: 'unknown',
  },
  internal_error: {
    status: 500,
    message: '保存処理中に予期しないエラーが発生しました。',
    outcome: 'unknown',
  },
  invalid_stored_data: {
    status: 500,
    message: '保存データの形式を確認できませんでした。',
    outcome: 'unknown',
  },
}

// サーバーが返したコードは任意の文字列。`constructor` のような継承されたプロパティを拾わないよう、自前のキーだけを引く。
function own<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined
}

// サーバーのエラー本文が未知・読めないときに、ステータスだけで選ぶ案内。
function fallbackMessage(status: number): string {
  if (status === 401) return AUTH_MESSAGE
  if (status === 409)
    return '保存した内容がほかの操作で更新されました。最新の内容を確認してください。'
  if (status === 503) return '保存機能は現在利用できません。時間をおいて、もう一度お試しください。'
  if (status === 502 || status === 504) {
    return '保存サービスに接続できませんでした。時間をおいて、もう一度お試しください。'
  }
  return GENERIC_MESSAGE
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// 利用者向けの画面に出してよい文言か。想定外の例外の本文は、そのまま見せない。
export function userMessageOf(error: unknown): string {
  if (
    error instanceof ReflectionApiError ||
    error instanceof ClientAuthError ||
    error instanceof SessionChangedError
  ) {
    return error.message
  }
  return '情報を取得できませんでした。もう一度お試しください。'
}

// 一覧が完全か。読み取れない項目・打ち切りが無く、返した件数と実際の件数が一致する。
export function isCompleteList(listInfo: ListInfo, count: number): boolean {
  return !listInfo.skippedInvalid && !listInfo.truncated && listInfo.returned === count
}

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  fetchFn?: typeof fetch
  getHeaders?: (scope: SessionScope) => Promise<Headers>
}

// 取得した時点のセッション（scope）のBearer＋App Checkだけで送る。
// 送信の直前にUIDを確かめ、違えば送らずに失敗する（古い画面のデータを別のUIDのトークンで送らない）。
export async function authorizedJson<T>(
  scope: SessionScope,
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    body,
    signal,
    fetchFn = fetch,
    getHeaders = getProtectedApiHeadersForScope,
  } = options
  // 認証が失敗しても新しい匿名ユーザーを勝手に作らない。
  let headers: Headers
  try {
    headers = await getHeaders(scope)
  } catch (error) {
    // App Checkを用意できなかったときは送信しない。認証・セッションの失敗は従来どおり呼び出し側で扱う。
    if (classifyProtectedHeaderError(error) === 'app_check_unavailable') {
      throw new ReflectionApiError(
        PROTECTED_FAILURE_MESSAGES.app_check_unavailable,
        undefined,
        'app_check_unavailable',
        'not_sent',
      )
    }
    throw error
  }
  if (body !== undefined) headers.set('Content-Type', 'application/json')

  // ヘッダー取得後からfetchまでの境界も同期確認し、通信をセッション世代に登録する。
  const operation = beginSessionScopeOperation(scope, signal)
  try {
    if (signal?.aborted)
      throw new ReflectionApiError(INTERRUPTED_MESSAGE, undefined, undefined, 'not_sent')
    operation.assertCurrent('not_sent')

    let response: Response
    let text: string
    try {
      // operation.assertCurrentとfetchは同じ同期区間。境界通知時はsignalも同期的に中断される。
      response = await fetchFn(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: operation.signal,
      })
      text = await response.text()
    } catch {
      // fetchを開始した後の通信断は、サーバーが処理を終えた可能性がある。
      operation.assertCurrent(method === 'POST' ? 'unknown' : 'not_sent')
      throw new ReflectionApiError(INTERRUPTED_MESSAGE, undefined, undefined, 'unknown')
    }
    // 応答を採用する直前にも、要求を開始したUser世代が続いているか確認する。
    // POST後に世代が変わっていた場合、サーバー側で保存済みの可能性があるため結果不明。
    const outcome = method === 'POST' ? 'unknown' : 'not_sent'
    await assertCurrentSessionScope(scope, outcome)
    operation.assertCurrent(outcome)
    if (signal?.aborted)
      throw new ReflectionApiError(INTERRUPTED_MESSAGE, undefined, undefined, 'unknown')

    const json = parseJson(text)
    // 本文がJSONかどうかより先にステータスを見る。プロキシが返すHTMLの502/503でも、状況に合う案内を使う。
    if (!response.ok) {
      const error = ErrorSchema.safeParse(json)
      const responseCode = error.success ? error.data.error.code : undefined
      const knownFailure = own(KNOWN_FAILURES, responseCode)
      const known = knownFailure?.status === response.status ? knownFailure : undefined
      // 既知のコードだけ、定型文言と確定の有無を使う。未知の本文は、利用者に見せない。
      if (!knownFailure) {
        // 保護APIの共通ステータス（401/403/429）は、未知の本文でもステータスで判定する。
        // サーバーは保存先に触れる前に拒否するので、何も変更されていない。
        // 既知コードとステータスが食い違う矛盾した応答は信頼せず、従来どおり結果不明とする。
        const protectedFailure = classifyProtectedStatus(response.status)
        if (protectedFailure) {
          throw new ReflectionApiError(
            PROTECTED_FAILURE_MESSAGES[protectedFailure],
            response.status,
            undefined,
            'rejected',
          )
        }
      }
      throw new ReflectionApiError(
        known?.message ?? fallbackMessage(response.status),
        response.status,
        known ? responseCode : undefined,
        known?.outcome ?? 'unknown',
      )
    }
    if (json === undefined) {
      throw new ReflectionApiError(INVALID_RESPONSE_MESSAGE, response.status, undefined, 'unknown')
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new ReflectionApiError(INVALID_RESPONSE_MESSAGE, response.status, undefined, 'unknown')
    }
    // parse後・返却直前にも同期確認する。呼び出し側は状態更新時にも取得時scopeを確認する。
    operation.assertCurrent(outcome)
    return parsed.data
  } finally {
    operation.dispose()
  }
}

type LoadOptions = {
  signal?: AbortSignal
  fetchFn?: typeof fetch
  getHeaders?: (scope: SessionScope) => Promise<Headers>
}

export async function loadSavedTrips(
  scope: SessionScope,
  options: LoadOptions = {},
): Promise<TripList> {
  return authorizedJson(scope, '/api/trips', TripListSchema, options)
}

// 旅程を本人の保存先へ新規保存する（POST /api/trips）。本人が保存を選んだときだけ呼ぶ。
// 保存先が受け付ける形（版0・3〜4地点・適用記録なし）に合わない旅程は、送らずに理由を返す。
// 送信後に応答を失った場合は outcome: 'unknown' の例外になる（保存済みかもしれないので、自動では再送しない）。
export const TRIP_NOT_SAVABLE_CODE = 'trip_not_savable'
export async function saveTrip(
  scope: SessionScope,
  trip: Trip,
  options: LoadOptions = {},
): Promise<Trip> {
  if (trip.learningApplications.length > 0) {
    throw new ReflectionApiError(
      '学びを使って作った旅程は、まだ保存できません。学びの適用記録を保存先で再確認する仕組みが未接続のためです。',
      undefined,
      TRIP_NOT_SAVABLE_CODE,
      'not_sent',
    )
  }
  const body = CreateTripBodySchema.safeParse(trip)
  if (!body.success) {
    throw new ReflectionApiError(
      trip.version !== 0
        ? '現地での変更を反映した旅程は、まだ保存できません。保存できるのは、作成した時点の旅程です。'
        : 'この旅程は保存の条件（3〜4地点など）を満たしていません。',
      undefined,
      TRIP_NOT_SAVABLE_CODE,
      'not_sent',
    )
  }
  const saved = await authorizedJson(scope, '/api/trips', TripResponseSchema, {
    ...options,
    method: 'POST',
    body: body.data,
  })
  if (saved.trip.id !== body.data.id) {
    throw new ReflectionApiError(INVALID_RESPONSE_MESSAGE, undefined, undefined, 'unknown')
  }
  return saved.trip
}

export async function loadReflectionHistory(
  scope: SessionScope,
  tripId: string,
  options: LoadOptions = {},
): Promise<ReflectionHistory> {
  const id = encodeURIComponent(tripId)
  const [trip, revisions] = await Promise.all([
    authorizedJson(scope, '/api/trips/' + id, TripResponseSchema, options),
    authorizedJson(scope, '/api/trips/' + id + '/revisions', RevisionListSchema, options),
  ])
  if (
    trip.trip.id !== tripId ||
    !isCompleteList(revisions.listInfo, revisions.revisions.length) ||
    revisions.revisions.some(
      (revision) =>
        revision.tripId !== tripId ||
        (revision.approval.status === 'approved' &&
          revision.constraintCheck.status === 'not_checked' &&
          revision.baseTripVersion >= trip.trip.version),
    )
  ) {
    throw new ReflectionApiError(PARTIAL_LIST_MESSAGE, undefined, undefined, 'not_sent')
  }
  return { trip: trip.trip, revisions: revisions.revisions }
}

export async function loadSavedLearnings(
  scope: SessionScope,
  options: LoadOptions = {},
): Promise<LearningList> {
  return authorizedJson(scope, '/api/learnings', LearningListResponseSchema, options)
}

// 内容が同じ学びか。IDと適用範囲を含め、キーの並び順に依存しないよう、項目ごとに比べる。
export function sameLearning(a: ApprovedLearning, b: ApprovedLearning): boolean {
  const sameScope =
    a.scope.kind === 'all_trips'
      ? b.scope.kind === 'all_trips'
      : b.scope.kind === 'region' && a.scope.region === b.scope.region
  return (
    a.id === b.id &&
    a.sourceTripId === b.sourceTripId &&
    a.category === b.category &&
    a.content === b.content &&
    sameScope
  )
}

type SaveFailure = Extract<SaveResult, { ok: false }>

// 保存の後の確認で、保存した内容が別の操作で変わっていたとき。
export const CHANGED_AFTER_SAVE_CODE = 'changed_after_save'
const CHANGED_AFTER_SAVE_MESSAGE =
  '保存した後に、保存済みの学びがほかの操作で変更または撤回されていました。' +
  '最新の内容を確認してから、保存し直してください。'
// 再試行しても直らない失敗。保存できない理由を言い切り、「再読み込み」は版の食い違いのときだけ案内する
// （再読み込みは、画面の承認と入力を消すため）。
const NON_RETRYABLE_REASONS: Readonly<Record<string, string>> = {
  version_conflict:
    '保存済みの学びが、ほかの操作で更新されていました。上書きを防ぐため、保存を止めました。' +
    'ページを再読み込みすると最新の内容を確認できますが、いまの承認と入力した内容は消えます。',
  already_exists:
    '同じIDの学びが、ほかの操作で先に保存されていました。上書きを防ぐため、保存を止めました。' +
    'ページを再読み込みすると最新の内容を確認できますが、いまの承認と入力した内容は消えます。',
  storage_limit_reached:
    '保存できる学びの数が上限に達しているため、新しい学びは保存できません。' +
    'もう一度保存しても、結果は変わりません。',
  learning_revoked:
    '撤回済みの学びと同じIDのため、保存できません。もう一度保存しても保存されません。' +
    '学びの候補を作り直して、新しい学びとして承認してください。',
  [ID_COLLISION_CODE]:
    '別の旅行で使われている学びIDと重複しているため、保存できません。' +
    'もう一度保存しても保存されません。学びの候補を作り直してください。',
  [CHANGED_AFTER_SAVE_CODE]: CHANGED_AFTER_SAVE_MESSAGE,
}
const UNVERIFIED_MESSAGE = '保存後の確認ができませんでした。'
// 同じ内容でもう一度送っても、結果が変わらない拒否（入力そのものが受け付けられない）。
const PERMANENT_REJECTIONS: ReadonlySet<string> = new Set([
  'invalid_request',
  'payload_too_large',
  'unsupported_media_type',
  'not_found',
  'revision_mismatch',
])

type SaveState = {
  savedIds: readonly string[]
  unknownIds: readonly string[]
}

function describeSaveFailure(error: unknown, state: SaveState): SaveFailure {
  const code = error instanceof ReflectionApiError ? error.code : undefined
  const fixed = own(NON_RETRYABLE_REASONS, code)
  let reason: string
  let retryable = fixed === undefined
  if (fixed !== undefined) {
    reason = fixed
  } else if (error instanceof SessionChangedError) {
    reason = SESSION_CHANGED_MESSAGE
    retryable = false
  } else if (error instanceof ClientAuthError) {
    // 端末側の認証の復元・取得の失敗。保存サービスの停止（503）とは別の理由として示す。
    reason = error.message
    retryable = error.code === 'unavailable' || error.code === 'sign_in_failed'
  } else if (error instanceof ReflectionApiError) {
    reason = error.message
    retryable = !(code !== undefined && PERMANENT_REJECTIONS.has(code))
  } else if (error instanceof z.ZodError) {
    reason = '入力した学びの内容が保存条件を満たしていません。'
    retryable = false
  } else {
    // 想定外の例外の本文は、利用者に見せない。
    reason = '保存に失敗しました。'
  }
  const lead =
    (state.savedIds.length > 0 ? String(state.savedIds.length) + '件は保存済みです。' : '') +
    (state.unknownIds.length > 0
      ? String(state.unknownIds.length) + '件は保存できたかどうか確認できません（結果不明）。'
      : '')
  return {
    ok: false,
    message: lead + reason,
    savedIds: state.savedIds,
    unknownIds: state.unknownIds,
    retryable,
  }
}

// 送信の結果が確定しているか。想定外の例外は、送信の有無を言い切れないので結果不明とする。
function deliveryOf(error: unknown): DeliveryOutcome {
  if (error instanceof ReflectionApiError) return error.outcome
  if (error instanceof SessionChangedError) return error.outcome
  if (error instanceof ClientAuthError) return 'not_sent'
  return 'unknown'
}

// 完全な一覧だけを返す。読み取れない項目・打ち切り・件数の不一致があれば、書き込みの根拠にしない。
async function loadCompleteLearnings(
  scope: SessionScope,
  options: LoadOptions,
): Promise<VersionedLearning[]> {
  const list = await loadSavedLearnings(scope, options)
  if (!isCompleteList(list.listInfo, list.learnings.length)) {
    throw new ReflectionApiError(PARTIAL_LIST_MESSAGE, undefined, undefined, 'not_sent')
  }
  return list.learnings
}

// 1回の保存で分かったことの記録。
type Ledger = {
  // 保存できた（またはすでに同じ内容で保存されていた）学びのID。
  savedIds: string[]
  // 送信したが、保存できたかどうか分からない学びのID。
  unknownIds: string[]
  // 事前の一覧だけで保存済みと確認した学び（書き込みの後の一覧で確認し直すまで、断定しない）。
  fromList: Set<string>
  // 書き込みが保存先を変えた可能性（成功した、または結果不明）。
  mayHaveWritten: boolean
  // 内容が分かっている学び（IDで引く）。
  wanted: ReadonlyMap<string, ApprovedLearning>
}

// 書き込みの後に取り直した一覧（取り直せなかったときはundefined）で、記録を照合する。
// - 結果不明の学びが同じ内容で見つかれば、保存済みに直す（応答だけを失ったケースを確認できる）。
// - 保存を確認したはずの学びが変わっていたら、保存済みから外す（別の操作による変更・撤回）。
// - 取り直せないときは、事前の一覧だけで保存済みと確認した学びを、結果不明に戻す。
// 見つからないだけでは、結果不明を未保存と決めない（処理が遅れて反映される可能性が残る）。
// 新しく分かった問題があれば、そのエラーを返す。
function reconcile(
  ledger: Ledger,
  observed: Map<string, VersionedLearning>,
  latest: ReadonlyMap<string, VersionedLearning> | undefined,
): ReflectionApiError | undefined {
  let problem: ReflectionApiError | undefined
  for (const id of [...ledger.savedIds, ...ledger.unknownIds]) {
    const learning = ledger.wanted.get(id)
    if (!learning) continue
    const entry = latest?.get(id)
    const wasSaved = ledger.savedIds.includes(id)
    if (entry && sameLearning(entry.learning, learning)) {
      observed.set(id, entry)
      if (!wasSaved) {
        ledger.unknownIds.splice(ledger.unknownIds.indexOf(id), 1)
        ledger.savedIds.push(id)
      }
    } else if (latest && wasSaved) {
      ledger.savedIds.splice(ledger.savedIds.indexOf(id), 1)
      problem ??= new ReflectionApiError(
        CHANGED_AFTER_SAVE_MESSAGE,
        409,
        CHANGED_AFTER_SAVE_CODE,
        'rejected',
      )
    } else if (!latest && wasSaved && ledger.fromList.has(id)) {
      ledger.savedIds.splice(ledger.savedIds.indexOf(id), 1)
      ledger.unknownIds.push(id)
      problem ??= new ReflectionApiError(UNVERIFIED_MESSAGE, undefined, undefined, 'unknown')
    }
  }
  return problem
}

// 保存後の取り直しに失敗したときの理由。認証セッションの問題は、そのまま伝える。
function unverified(error: unknown): unknown {
  if (error instanceof SessionChangedError || error instanceof ClientAuthError) return error
  return new ReflectionApiError(
    UNVERIFIED_MESSAGE + userMessageOf(error),
    undefined,
    undefined,
    'unknown',
  )
}

function indexById(entries: readonly VersionedLearning[]): Map<string, VersionedLearning> {
  const indexed = new Map<string, VersionedLearning>()
  for (const entry of entries) {
    if (indexed.has(entry.learning.id)) {
      throw new ReflectionApiError(PARTIAL_LIST_MESSAGE, undefined, undefined, 'not_sent')
    }
    indexed.set(entry.learning.id, entry)
  }
  return indexed
}

// LearningReviewが要求する全件保存ポート。各候補の成功を確認するまで保存完了としない。
// APIは1件ずつなので、一部成功したときは再取得して成功分のversionを引き継いで再試行する。
//
// 結果の分類（保存済み／結果不明／未保存）：
// - 保存済み：POSTの応答を検証できた、または保存後に取り直した一覧で同じ内容を確認できた。
// - 結果不明：送信した後に応答だけを失った（通信断・タイムアウト・読めない応答・5xx）、または応答の内容が
//   送った内容と一致しない。サーバーは処理を終えている可能性があるので、未保存と決めつけず、自動では再送しない。
// - 未保存：送信前に止まった、またはサーバーが何も変更せずに拒否した。
// 保存を送った後は、最後に一覧を取り直して確認する（最後の取得は、最後の書き込みより後にする）。
// 事前の一覧で同じ内容だった項目も、書き込みの後は取り直した一覧で確認できるまで、保存済みと断定しない。
// 保存対象が事前一覧で見つかった、または書き込みを試みたときは、成功・失敗にかかわらずonSavedを呼ぶ
// （ほかの端末の更新・撤回を画面上の保存済み一覧にも反映する）。
export function createFirestoreLearningStore(
  scope: SessionScope,
  onSaved?: () => void,
  fetchFn: typeof fetch = fetch,
): LearningStore {
  // この画面で確認した版だけを更新する。別端末が更新した版へ勝手に追随しない。
  // 画面のセッションごとにこのストアを作るので、別のUIDのIDや版とは混ざらない。
  const observed = new Map<string, VersionedLearning>()
  // 同時に2回の保存を走らせない（二重送信の防止）。
  let running = false
  return {
    async save(approved, options): Promise<SaveResult> {
      if (approved.length === 0) {
        return { ok: false, message: '承認された学びがありません。' }
      }
      const ids = new Set(approved.map((learning) => learning.id))
      if (
        ids.size !== approved.length ||
        approved.some((item) => !ApprovedLearningSchema.safeParse(item).success)
      ) {
        return { ok: false, message: '学びの形式またはIDを確認できませんでした。' }
      }
      if (running) {
        return {
          ok: false,
          message: '前の保存がまだ終わっていません。終わってから、もう一度保存してください。',
          savedIds: [],
          unknownIds: [],
          retryable: true,
        }
      }
      running = true
      const requestOptions: LoadOptions = { signal: options?.signal, fetchFn }
      const ledger: Ledger = {
        savedIds: [],
        unknownIds: [],
        fromList: new Set(),
        mayHaveWritten: false,
        wanted: new Map(approved.map((learning) => [learning.id, learning])),
      }
      let failure: unknown
      try {
        try {
          const current = indexById(await loadCompleteLearnings(scope, requestOptions))
          for (const learning of approved) {
            if (options?.signal?.aborted) {
              throw new ReflectionApiError(INTERRUPTED_MESSAGE, undefined, undefined, 'not_sent')
            }
            const existing = current.get(learning.id)
            if (
              existing &&
              (existing.learning.sourceTripId !== learning.sourceTripId ||
                existing.learning.category !== learning.category)
            ) {
              throw new ReflectionApiError(
                '別の旅程で使われている学びIDと重複しています。',
                undefined,
                ID_COLLISION_CODE,
                'not_sent',
              )
            }
            if (existing && sameLearning(existing.learning, learning)) {
              observed.set(learning.id, existing)
              ledger.savedIds.push(learning.id)
              ledger.fromList.add(learning.id)
              continue
            }
            if (existing) {
              const previous = observed.get(learning.id)
              if (
                !previous ||
                previous.version !== existing.version ||
                !sameLearning(previous.learning, existing.learning)
              ) {
                throw new ReflectionApiError(
                  '保存済みの学びが別の操作で変更されています。確認してから再度編集してください。',
                  409,
                  'version_conflict',
                  'not_sent',
                )
              }
            }
            const expectedVersion = existing?.version ?? 0
            const body = ApproveLearningBodySchema.parse({
              expectedVersion,
              sourceTripId: learning.sourceTripId,
              category: learning.category,
              content: learning.content,
              scope: learning.scope,
            })
            let result: VersionedLearning
            try {
              // 各POSTの直前に、セッションが同じことを確かめる（途中で変わっていたら、残りは送らない）。
              result = await authorizedJson(
                scope,
                '/api/learnings/' + encodeURIComponent(learning.id) + '/approve',
                VersionedLearningSchema,
                { method: 'POST', body, ...requestOptions },
              )
            } catch (error) {
              if (deliveryOf(error) === 'unknown') {
                ledger.unknownIds.push(learning.id)
                ledger.mayHaveWritten = true
              }
              throw error
            }
            ledger.mayHaveWritten = true
            // 応答のID・内容（IDを含む）・版を、送った内容と契約（新しい版＝期待した版＋1）に照らして確かめる。
            if (
              !sameLearning(result.learning, learning) ||
              result.version !== expectedVersion + 1
            ) {
              ledger.unknownIds.push(learning.id)
              throw new ReflectionApiError(INVALID_RESPONSE_MESSAGE, 200, undefined, 'unknown')
            }
            current.set(learning.id, result)
            observed.set(learning.id, result)
            ledger.savedIds.push(learning.id)
          }
        } catch (error) {
          failure = error
        }

        // 書き込みの後、または事前一覧で保存済みと判断した項目がある場合は、一覧を取り直して確認する。
        // 事前一覧で同じ内容でも、取り直しの前に別端末で撤回・更新される可能性がある。
        // 結果不明の項目も、ここで保存済みと照合できる。
        // 取り直せなかったとき（認証セッションが変わった・通信できない）は、事前の一覧だけの学びを断定しない。
        if (ledger.mayHaveWritten || ledger.savedIds.length > 0) {
          let latest: Map<string, VersionedLearning> | undefined
          try {
            latest = indexById(await loadCompleteLearnings(scope, requestOptions))
          } catch (error) {
            failure ??= unverified(error)
          }
          // reconcile は記録を書き換えるので、先のエラーがあっても必ず実行する。
          const problem = reconcile(ledger, observed, latest)
          failure ??= problem
        }

        // 成功は、すべての学びを保存済みと確認できたときだけ。途中で応答を失っても、
        // 取り直した一覧で保存済みと確認できたなら、失敗とは扱わない。
        const allSaved =
          ledger.unknownIds.length === 0 &&
          approved.every((learning) => ledger.savedIds.includes(learning.id))
        if (allSaved) {
          try {
            // 最後のGETが返った後にもセッション世代を確認する。A→B→Aは同じUIDでも別セッション。
            assertCurrentSessionScopeSync(scope, 'unknown')
            return { ok: true }
          } catch (error) {
            failure ??= error
            for (const id of ledger.savedIds) {
              if (!ledger.unknownIds.includes(id)) ledger.unknownIds.push(id)
            }
            ledger.savedIds.length = 0
          }
        }
        return describeSaveFailure(failure ?? new ReflectionApiError(UNVERIFIED_MESSAGE), ledger)
      } finally {
        running = false
        if (ledger.fromList.size > 0 || ledger.mayHaveWritten) {
          let sessionIsCurrent = true
          try {
            assertCurrentSessionScopeSync(scope)
          } catch {
            sessionIsCurrent = false
            // 古いセッションの保存結果で、現在の画面の一覧更新を始めない。
          }
          if (sessionIsCurrent) onSaved?.()
        }
      }
    },
  }
}
