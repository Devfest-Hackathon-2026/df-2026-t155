import 'server-only'

import { authErrorResponse, requireActor, type Actor } from '@/lib/auth/server'

import { reportCostControlFailure } from './cost-control/diagnostics'
import { checkEligibility } from './cost-control/eligibility'
import {
  PAID_WORK_MS,
  STORAGE_WORK_MS,
  operationCategories,
  type OperationCost,
  type Provider,
} from './cost-control/policy'
import { reserveCost, withinDeadline, type Admission } from './cost-control/store'
import { WriteFenceError, type WriteTransaction } from './cost-control/write-transaction'

export function isCostlyApiEnabled(flag: string | undefined): boolean {
  const local = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
  return flag?.trim() === 'true' && (local || process.env.COSTLY_API_DEMO_ENABLED === 'true')
}

const failures = {
  invite_required: [403, '実APIの利用には招待が必要です。'],
  app_check_invalid: [403, 'アプリの利用資格を確認できませんでした。'],
  app_check_unavailable: [503, 'アプリの検証サービスを利用できません。'],
  uid_limit: [429, '利用者ごとの利用枠に達しました。'],
  global_limit: [429, '全体の利用枠に達しました。'],
  protection_unavailable: [503, '利用枠を安全に確認できませんでした。'],
} as const

function failure(code: keyof typeof failures): Response {
  const [status, message] = failures[code]
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  )
}

export async function requireCostlyApiActor(request: Request): Promise<Actor | Response> {
  let actor: Actor
  try {
    actor = await requireActor(request)
  } catch (error) {
    return authErrorResponse(error)
  }

  const denied = await checkEligibility(request, actor.uid)
  return denied ? failure(denied) : actor
}

export interface CostlyOperation {
  readonly signal: AbortSignal
  assertActive(): void
  write: WriteTransaction
  call<T>(provider: Provider, dispatch: () => Promise<T>): Promise<T>
  keepLease(): void
}

// 認証済みActorの操作全体を予約する。プロバイダーごとの送信は予約内でのみ許可する。
export async function runCostlyOperation<T>(
  actor: Actor,
  cost: OperationCost,
  action: (operation: CostlyOperation) => Promise<T>,
): Promise<T | Response> {
  const started = performance.now()
  let admission: Admission
  try {
    admission = await reserveCost(actor.uid, cost)
  } catch {
    return failure('protection_unavailable')
  }

  if (admission.kind === 'unavailable') return failure('protection_unavailable')
  if (admission.kind === 'limited') {
    return failure(admission.scope === 'uid' ? 'uid_limit' : 'global_limit')
  }

  const workMs = operationCategories(cost).includes('paid') ? PAID_WORK_MS : STORAGE_WORK_MS
  const deadline = Math.min(started + admission.workAvailableMs, performance.now() + workMs)
  const expired = () => performance.now() >= deadline
  const controller = new AbortController()
  const remaining = { ...cost }
  let active = true
  let pending = 0
  let writeStarted = false
  let uncertain = false
  let blocked = false
  let finished = false
  const assertActive = () => {
    if (!active || blocked || expired()) {
      blocked = true
      throw new Error('operation is no longer active')
    }
  }
  const operation: CostlyOperation = {
    signal: controller.signal,
    assertActive,
    async call(provider, dispatch) {
      assertActive()
      const available = remaining[provider] ?? 0
      if (available < 1) {
        blocked = true
        throw new Error('outbound request blocked')
      }
      remaining[provider] = available - 1
      pending += 1
      try {
        return await dispatch()
      } catch (error) {
        uncertain = true
        throw error
      } finally {
        pending -= 1
      }
    },
    async write(action) {
      assertActive()
      if (!cost.writes || writeStarted) {
        blocked = true
        throw new WriteFenceError('lease_lost')
      }
      writeStarted = true
      pending += 1
      try {
        return await admission.write(assertActive, action)
      } catch (error) {
        if (error instanceof WriteFenceError && error.code === 'write_result_unknown')
          uncertain = true
        throw error
      } finally {
        pending -= 1
      }
    },
    keepLease() {
      uncertain = true
    },
  }

  try {
    if (expired()) return failure('protection_unavailable')
    const result = await withinDeadline(deadline - performance.now(), async () => {
      try {
        return await action(operation)
      } finally {
        finished = true
      }
    })
    return blocked || expired() ? failure('protection_unavailable') : result
  } catch (error) {
    if (!finished || blocked || expired()) return failure('protection_unavailable')
    throw error
  } finally {
    active = false
    controller.abort()
    if (writeStarted && (!finished || expired())) {
      // 先に永続化できれば、回収前でも送信待ちの旧コミットを版条件で止める。同時枠は保持する。
      await admission
        .revokeWrite()
        .catch(() => reportCostControlFailure('write_revocation_unavailable'))
    } else if (finished && !uncertain && pending === 0 && !expired()) {
      // 解放失敗時も消費済み枠は返却しない。リースは読み取り時刻に基づいて失効する。
      await admission.release().catch(() => console.warn('costly_api_release_unavailable'))
    }
  }
}
