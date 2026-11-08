import { vi } from 'vitest'

import type { Learning, Revision, Trip } from '../../src/domain'
import {
  ApproveLearningBodySchema,
  type VersionedLearning,
} from '../../src/server/persistence/contracts'
import { uidOfToken } from './fake-auth-client'

// 保存API（旅程・変更履歴・学び）の疑似バックエンド。fetchの差し替えに使う。
// - アカウント（UID）ごとに別のデータを持つ。リクエストのIDトークン（`token-of-<uid>`）で相手を決める。
//   同じTrip ID・Learning IDが別のUIDにあっても、混ざらない。
// - 承認APIは、サーバーの契約どおり（期待版の一致・新しい版は期待版+1・撤回済みIDは拒否）に動く。
// - interceptで、特定のリクエストの前後に割り込める。
//   proceed() は、サーバー側の処理を（1回だけ）実行して応答を返す。
//   例：応答を失う＝ `proceed(); throw new TypeError('offline')`（処理は確定済み）。
//   例：古い応答を遅らせる＝ `const r = proceed(); await gate; return r`（処理は先に確定済み）。

export interface AccountData {
  trips: Trip[]
  revisions: Revision[]
  learnings: Map<string, VersionedLearning>
}

export interface BackendCall {
  method: string
  path: string
  uid: string | undefined
  body: unknown
}

type InterceptResult = Response | void | Promise<Response | void>
export type Interceptor = (context: {
  call: BackendCall
  proceed: () => Response
}) => InterceptResult

export interface BackendOptions {
  candidates?: Learning[]
  // 承認時に付ける決定時刻。
  decidedAt?: string
}

const emptyInfo = { skippedInvalid: 0, truncated: false }

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status)
}

export function createFakeBackend(
  initial: Record<
    string,
    Partial<{ trips: Trip[]; revisions: Revision[]; learnings: VersionedLearning[] }>
  > = {},
  options: BackendOptions = {},
) {
  const accounts = new Map<string, AccountData>()
  const account = (uid: string): AccountData => {
    let data = accounts.get(uid)
    if (!data) {
      data = { trips: [], revisions: [], learnings: new Map() }
      accounts.set(uid, data)
    }
    return data
  }
  for (const [uid, seed] of Object.entries(initial)) {
    const data = account(uid)
    data.trips = seed.trips ?? []
    data.revisions = seed.revisions ?? []
    data.learnings = new Map((seed.learnings ?? []).map((entry) => [entry.learning.id, entry]))
  }

  const calls: BackendCall[] = []
  const interceptors: Array<{
    match: (call: BackendCall) => boolean
    fn: Interceptor
    once: boolean
  }> = []

  function handle(call: BackendCall): { status: number; body: unknown } {
    // 学びの候補の作成は、認証を使わない（本人のデータに触れない）。
    if (call.method === 'POST' && call.path === '/api/learnings/candidates') {
      return { status: 200, body: { status: 'proposed', learnings: options.candidates ?? [] } }
    }
    if (!call.uid) {
      return {
        status: 401,
        body: { error: { code: 'unauthenticated', message: '認証が必要です' } },
      }
    }
    const data = account(call.uid)
    const ok = (body: unknown) => ({ status: 200, body })
    if (call.method === 'GET' && call.path === '/api/trips') {
      return ok({ trips: data.trips, listInfo: { returned: data.trips.length, ...emptyInfo } })
    }
    const tripMatch = /^\/api\/trips\/([^/]+)(\/revisions)?$/.exec(call.path)
    if (call.method === 'GET' && tripMatch) {
      const tripId = decodeURIComponent(tripMatch[1])
      if (tripMatch[2]) {
        const list = data.revisions.filter((revision) => revision.tripId === tripId)
        return ok({ revisions: list, listInfo: { returned: list.length, ...emptyInfo } })
      }
      const trip = data.trips.find((candidate) => candidate.id === tripId)
      return trip
        ? ok({ trip })
        : { status: 404, body: { error: { code: 'not_found', message: '対象が見つかりません' } } }
    }
    if (call.method === 'GET' && call.path === '/api/learnings') {
      const entries = [...data.learnings.values()]
      return ok({ learnings: entries, listInfo: { returned: entries.length, ...emptyInfo } })
    }
    const approveMatch = /^\/api\/learnings\/([^/]+)\/approve$/.exec(call.path)
    if (call.method === 'POST' && approveMatch) {
      const id = decodeURIComponent(approveMatch[1])
      const body = ApproveLearningBodySchema.parse(call.body)
      const current = data.learnings.get(id)
      if ((current?.version ?? 0) !== body.expectedVersion) {
        return {
          status: 409,
          body: { error: { code: 'version_conflict', message: '保存内容の版が変わりました。' } },
        }
      }
      const entry: VersionedLearning = {
        version: body.expectedVersion + 1,
        learning: {
          id,
          sourceTripId: body.sourceTripId,
          category: body.category,
          content: body.content,
          scope: body.scope,
          approval: {
            status: 'approved',
            decidedAt: options.decidedAt ?? '2026-11-08T10:00:00+09:00',
          },
        },
      }
      data.learnings.set(id, entry)
      return ok(entry)
    }
    return { status: 404, body: { error: { code: 'not_found', message: '見つかりません' } } }
  }

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: BackendCall = {
      method: init?.method ?? 'GET',
      path: String(input),
      uid: uidOfToken(new Headers(init?.headers).get('Authorization')),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    let result: { status: number; body: unknown } | undefined
    const proceed = () => {
      result ??= handle(call)
      return jsonResponse(result.body, result.status)
    }
    const index = interceptors.findIndex((entry) => entry.match(call))
    if (index >= 0) {
      const entry = interceptors[index]
      if (entry.once) interceptors.splice(index, 1)
      const replaced = await entry.fn({ call, proceed })
      if (replaced) return replaced
    }
    return proceed()
  })

  return {
    fetchFn,
    calls,
    account,
    /** 条件に合う次のリクエストに割り込む（既定は1回だけ）。 */
    intercept(
      match: (call: BackendCall) => boolean,
      fn: Interceptor,
      { always = false }: { always?: boolean } = {},
    ) {
      interceptors.push({ match, fn, once: !always })
    },
    /** 承認APIへの呼び出し（学びIDの一覧つき）。 */
    approveCalls: () =>
      calls.filter((call) => call.method === 'POST' && call.path.endsWith('/approve')),
  }
}

export const isListLearnings = (call: BackendCall) =>
  call.method === 'GET' && call.path === '/api/learnings'
export const isApprove = (id?: string) => (call: BackendCall) =>
  call.method === 'POST' &&
  (id === undefined
    ? call.path.endsWith('/approve')
    : call.path === `/api/learnings/${encodeURIComponent(id)}/approve`)
