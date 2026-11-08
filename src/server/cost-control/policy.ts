import { z } from 'zod'

export const COST_KEYS = ['gemini', 'places', 'routes', 'reads', 'writes'] as const
type CostKey = (typeof COST_KEYS)[number]
export type OperationCost = Readonly<Partial<Record<CostKey, number>>>
export type Provider = 'gemini' | 'places' | 'routes'

const count = z.int().nonnegative()
const limits = z.strictObject({
  perMinute: z.int().min(1).max(1000),
  perPeriod: z.int().min(1).max(1_000_000),
  concurrent: z.int().min(1).max(100),
})

export const UsageSchema = z.strictObject({
  gemini: count,
  places: count,
  routes: count,
  reads: count,
  writes: count,
})
export const EMPTY_USAGE = { gemini: 0, places: 0, routes: 0, reads: 0, writes: 0 }

const scope = z.strictObject({ uid: limits, global: limits })
export const PolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    paid: scope,
    storage: scope,
    budget: UsageSchema,
  })
  .refine(({ startsAt, endsAt }) => Date.parse(startsAt) < Date.parse(endsAt))

export type Policy = z.infer<typeof PolicySchema>

export const DEFAULT_LIMITS = {
  paid: {
    uid: { perMinute: 4, perPeriod: 12, concurrent: 1 },
    global: { perMinute: 10, perPeriod: 80, concurrent: 2 },
  },
  storage: {
    uid: { perMinute: 12, perPeriod: 50, concurrent: 2 },
    global: { perMinute: 30, perPeriod: 500, concurrent: 4 },
  },
  budget: { gemini: 40, places: 100, routes: 160, reads: 10_000, writes: 1000 },
} satisfies Omit<Policy, 'enabled' | 'startsAt' | 'endsAt'>

export const LEASE_MS = 180_000
export const LEASE_MARGIN_MS = 30_000
export const PAID_WORK_MS = 150_000
export const STORAGE_WORK_MS = 15_000

export type Category = 'paid' | 'storage'

export function operationCategories(cost: OperationCost): Category[] {
  const categories: Category[] = []
  if (cost.gemini || cost.places || cost.routes) categories.push('paid')
  if (cost.reads || cost.writes) categories.push('storage')
  return categories
}
