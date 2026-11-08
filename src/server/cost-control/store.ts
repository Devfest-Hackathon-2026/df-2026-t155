import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import type { Firestore, Transaction } from 'firebase-admin/firestore'
import { z } from 'zod'

import { getAdminFirestore } from '@/lib/firebase/admin'

import {
  COST_KEYS,
  EMPTY_USAGE,
  LEASE_MARGIN_MS,
  LEASE_MS,
  PolicySchema,
  UsageSchema,
  operationCategories,
  type Category,
  type OperationCost,
  type Policy,
} from './policy'
import { reportCostControlFailure } from './diagnostics'
import { WriteFenceError } from './write-transaction'

export const CONTROL_DOCUMENT = 'apiAbuseControl/gate'
const TRANSACTION_ATTEMPTS = 2
const STORE_TIMEOUT_MS = 2000
const MINUTE_MS = 60_000
const DENIAL_TTL_MS = 1000
const DENIAL_CACHE_SIZE = 512
// Firestore client ごとに独立させ、許可やストア障害は保存しない。
const denialCaches = new WeakMap<Firestore, Map<string, number>>()

function denialCache(db: Firestore): Map<string, number> {
  let cache = denialCaches.get(db)
  if (!cache) {
    cache = new Map()
    denialCaches.set(db, cache)
  }
  return cache
}

function cachedDenial(cache: Map<string, number>, key: string, now: number): boolean {
  const until = cache.get(key)
  if (until === undefined) return false
  if (until <= now) {
    cache.delete(key)
    return false
  }
  return true
}

function rememberDenial(cache: Map<string, number>, key: string, until: number): void {
  cache.delete(key)
  if (cache.size >= DENIAL_CACHE_SIZE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, until)
}
// ALREADY_EXISTS / FAILED_PRECONDITION / ABORTED
const CONFLICT_CODES = new Set([6, 9, 10])

const category = z.enum(['paid', 'storage'])
const counter = z.strictObject({
  minute: z.array(z.int().nonnegative()).max(1000),
  total: z.int().nonnegative(),
})
const counters = z.strictObject({ paid: counter, storage: counter })
const uidState = z.strictObject({ startsAt: z.iso.datetime(), counts: counters })
const lease = z.strictObject({
  id: z.uuid(),
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  until: z.int().nonnegative(),
  writeRevoked: z.literal(true).optional(),
  categories: z.array(category).min(1).max(2),
})
const control = z.strictObject({
  policy: PolicySchema,
  counts: counters,
  reserved: UsageSchema,
  leases: z.array(lease).max(200),
})

type Counters = z.infer<typeof counters>
type Lease = z.infer<typeof lease>

export function createControlDocument(policy: Policy) {
  return control.parse({
    policy,
    counts: emptyCounters(),
    reserved: EMPTY_USAGE,
    leases: [],
  })
}

function emptyCounters(): Counters {
  return { paid: { minute: [], total: 0 }, storage: { minute: [], total: 0 } }
}

export type Admission =
  | {
      kind: 'allowed'
      workAvailableMs: number
      release: () => Promise<void>
      revokeWrite: () => Promise<void>
      write<T>(assertActive: () => void, action: (tx: Transaction) => Promise<T>): Promise<T>
    }
  | { kind: 'limited'; scope: 'uid' | 'global' }
  | { kind: 'unavailable' }

function advance(
  previous: Counters,
  limits: Policy,
  scope: 'uid' | 'global',
  categories: Category[],
  active: Lease[],
  now: number,
): Counters | null {
  const counts = { ...previous }
  for (const key of categories) {
    const current = previous[key]
    const cap = limits[key][scope]
    const minute = current.minute.filter((at) => at > now - MINUTE_MS)
    if (
      current.total >= cap.perPeriod ||
      minute.length >= cap.perMinute ||
      active.filter((entry) => entry.categories.includes(key)).length >= cap.concurrent
    )
      return null

    counts[key] = { minute: [...minute, now], total: current.total + 1 }
  }
  return counts
}

// 締切後の応答で処理を再開しない。ストア側で確定していた場合は消費とリースが残る。
export async function withinDeadline<T>(durationMs: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline exceeded')), durationMs)
      }),
      Promise.resolve().then(run),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class FirestoreCostStore {
  constructor(
    private readonly db: Firestore,
    private readonly timeoutMs = STORE_TIMEOUT_MS,
  ) {}

  async reserve(uid: string, cost: OperationCost): Promise<Admission> {
    const started = performance.now()
    const id = randomUUID()
    const owner = createHash('sha256').update(uid).digest('hex')
    const gate = this.db.doc(CONTROL_DOCUMENT)
    const person = gate.collection('uids').doc(owner)
    let commitStarted = false
    const limited = (scope: 'global' | 'uid'): Admission => ({ kind: 'limited', scope })
    try {
      const requested = UsageSchema.parse({ ...EMPTY_USAGE, ...cost })
      const categories = operationCategories(requested)
      if (!categories.length) return { kind: 'unavailable' }
      const cache = denialCache(this.db)
      const costKey = JSON.stringify(COST_KEYS.map((key) => requested[key]))
      const globalKey = `global:${costKey}`
      const uidKey = `uid:${owner}:${costKey}`
      if (cachedDenial(cache, globalKey, performance.now())) return limited('global')
      if (cachedDenial(cache, uidKey, performance.now())) return limited('uid')
      let denialUntil = 0

      const result = await withinDeadline(this.timeoutMs, () =>
        this.retryConflict<Admission>(started, async () => {
          commitStarted = false
          const snapshot = await gate.get()
          if (!snapshot.exists) {
            reportCostControlFailure('control_missing')
            return { kind: 'unavailable' }
          }
          const parsed = control.safeParse(snapshot.data())
          if (!parsed.success) {
            reportCostControlFailure('control_invalid')
            return { kind: 'unavailable' }
          }
          const state = parsed.data
          // 全インスタンスでFirestoreの読み取り時刻を基準に窓とリースを判定する。
          const now = Math.floor(snapshot.readTime.toMillis())
          const start = Date.parse(state.policy.startsAt)
          const end = Date.parse(state.policy.endsAt)
          denialUntil = started + Math.min(DENIAL_TTL_MS, end - now)
          const until = Math.min(end, now + LEASE_MS)
          if (!state.policy.enabled || now < start || until - now <= LEASE_MARGIN_MS) {
            return { kind: 'unavailable' }
          }

          const active = state.leases.filter((entry) => entry.until > now)
          if (active.some((entry) => entry.id === id)) {
            reportCostControlFailure('reservation_unknown')
            return { kind: 'unavailable' }
          }
          const globalCounts = advance(
            state.counts,
            state.policy,
            'global',
            categories,
            active,
            now,
          )
          const reserved = { ...state.reserved }
          for (const key of COST_KEYS) {
            if (requested[key] === 0) continue
            reserved[key] += requested[key]
            if (reserved[key] > state.policy.budget[key]) return limited('global')
          }
          if (!globalCounts) return limited('global')

          const saved = await person.get()
          const user = uidState.safeParse(saved.data())
          if (saved.exists && !user.success) {
            reportCostControlFailure('control_invalid')
            return { kind: 'unavailable' }
          }
          // 期間を変更しただけでUID別の使用済み枠を初期化できないようにする。
          if (user.success && user.data.startsAt !== state.policy.startsAt) {
            reportCostControlFailure('period_mismatch')
            return { kind: 'unavailable' }
          }
          const uidCounts = advance(
            user.data?.counts ?? emptyCounters(),
            state.policy,
            'uid',
            categories,
            active.filter((entry) => entry.owner === owner),
            now,
          )
          if (!uidCounts) return limited('uid')

          if (performance.now() - started >= this.timeoutMs) return { kind: 'unavailable' }
          if (!snapshot.updateTime) return { kind: 'unavailable' }
          const entry = { id, owner, until, categories }
          commitStarted = true
          await this.db.runTransaction(
            async (tx) => {
              // 読んだ両文書の版を同じ原子的なコミットで照合する。途中で変われば両方とも更新されない。
              tx.update(
                gate,
                {
                  counts: globalCounts,
                  reserved,
                  leases: [...active, entry],
                },
                { lastUpdateTime: snapshot.updateTime },
              )
              const userState = { startsAt: state.policy.startsAt, counts: uidCounts }
              if (saved.updateTime) {
                tx.update(person, userState, { lastUpdateTime: saved.updateTime })
              } else {
                tx.create(person, userState)
              }
            },
            { maxAttempts: 1 },
          )
          return {
            kind: 'allowed',
            workAvailableMs: until - now - LEASE_MARGIN_MS,
            release: () => this.endLease(id, 'release'),
            revokeWrite: () => this.endLease(id, 'revoke_write'),
            write: (assertActive, action) =>
              this.write(entry, state.policy.startsAt, assertActive, action),
          }
        }),
      )
      if (performance.now() - started >= this.timeoutMs) {
        reportCostControlFailure('reservation_deadline')
        return { kind: 'unavailable' }
      }
      if (result.kind === 'limited' && denialUntil > performance.now()) {
        rememberDenial(cache, result.scope === 'global' ? globalKey : uidKey, denialUntil)
      }
      return result
    } catch (error) {
      if (performance.now() - started >= this.timeoutMs) {
        reportCostControlFailure('reservation_deadline')
      } else {
        reportCostControlFailure(
          isConflict(error)
            ? 'reservation_contention'
            : commitStarted
              ? 'reservation_unknown'
              : 'store_unavailable',
        )
      }
      return { kind: 'unavailable' }
    }
  }

  private async write<T>(
    admitted: Lease,
    period: string,
    assertActive: () => void,
    action: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    let commitMayHaveStarted = false
    try {
      return await this.db.runTransaction(
        async (tx) => {
          assertActive()
          const result = await action(tx)
          assertActive()

          // 業務書き込みはSDK内にステージ済み。この読取は取引外なので共有文書をロックしない。
          const gate = this.db.doc(CONTROL_DOCUMENT)
          const snapshot = await gate.get()
          const checked = control.safeParse(snapshot.data())
          if (!checked.success) throw new WriteFenceError('lease_lost')
          const state = checked.data
          const current = state.leases.find(({ id }) => id === admitted.id)
          const now = snapshot.readTime.toMillis()
          if (
            !snapshot.updateTime ||
            !state.policy.enabled ||
            state.policy.startsAt !== period ||
            !current?.categories.includes('storage') ||
            current.writeRevoked ||
            current.owner !== admitted.owner ||
            Math.min(current.until, Date.parse(state.policy.endsAt)) - now <= LEASE_MARGIN_MS
          ) {
            throw new WriteFenceError('lease_lost')
          }

          // 同じ原子的なコミットに版条件を載せる。回収・停止・期間切替が先に確定すれば業務書き込みも失敗する。
          tx.update(gate, { leases: state.leases }, { lastUpdateTime: snapshot.updateTime })
          assertActive()
          commitMayHaveStarted = true
          return result
        },
        { maxAttempts: 1 },
      )
    } catch (error) {
      // Commit RPCの再送後のエラーも、既に確定している可能性がある。業務コールバックを再実行しない。
      if (commitMayHaveStarted) throw new WriteFenceError('write_result_unknown')
      throw error
    }
  }

  private async endLease(id: string, mode: 'release' | 'revoke_write'): Promise<void> {
    const gate = this.db.doc(CONTROL_DOCUMENT)
    const started = performance.now()
    await withinDeadline(this.timeoutMs, () =>
      this.retryConflict(started, async () => {
        const snapshot = await gate.get()
        const state = control.parse(snapshot.data())
        const current = state.leases.find((entry) => entry.id === id)
        if (!current || (mode === 'revoke_write' && current.writeRevoked)) return
        const leases =
          mode === 'release'
            ? state.leases.filter((entry) => entry.id !== id)
            : state.leases.map((entry) =>
                entry === current ? { ...entry, writeRevoked: true } : entry,
              )
        if (!snapshot.updateTime || performance.now() - started >= this.timeoutMs) {
          throw new Error('store deadline exceeded')
        }
        await this.db.runTransaction(
          async (tx) => {
            tx.update(gate, { leases }, { lastUpdateTime: snapshot.updateTime })
          },
          { maxAttempts: 1 },
        )
      }),
    )
  }

  private async retryConflict<T>(started: number, action: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      if (performance.now() - started >= this.timeoutMs) throw new Error('store deadline exceeded')
      try {
        // SDKの自動再試行はコミット結果が不明なエラーも含む。競合で中止された場合だけ再試行する。
        return await action()
      } catch (error) {
        if (!isConflict(error) || attempt >= TRANSACTION_ATTEMPTS) throw error
      }
    }
  }
}

function isConflict(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'number' && CONFLICT_CODES.has(code)
}

export async function reserveCost(uid: string, cost: OperationCost): Promise<Admission> {
  try {
    return await new FirestoreCostStore(getAdminFirestore()).reserve(uid, cost)
  } catch {
    reportCostControlFailure('store_unavailable')
    return { kind: 'unavailable' }
  }
}
