import type { Firestore } from 'firebase-admin/firestore'
import { afterEach, expect, it, vi } from 'vitest'

import { DEFAULT_LIMITS } from './policy'
import { createControlDocument, FirestoreCostStore } from './store'

afterEach(() => vi.restoreAllMocks())

function fakeStore(
  options: { uidLimited?: boolean; globalLimited?: boolean; endsIn?: number } = {},
) {
  const now = Date.now()
  const policy = {
    ...structuredClone(DEFAULT_LIMITS),
    enabled: true,
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + (options.endsIn ?? 60_000)).toISOString(),
  }
  if (options.globalLimited) policy.budget.gemini = 0
  const state = createControlDocument(policy)
  const person = {
    get: vi.fn().mockResolvedValue({
      exists: Boolean(options.uidLimited),
      data: () =>
        options.uidLimited
          ? {
              startsAt: policy.startsAt,
              counts: {
                paid: { minute: [], total: policy.paid.uid.perPeriod },
                storage: { minute: [], total: 0 },
              },
            }
          : undefined,
    }),
  }
  const gate = {
    get: vi.fn().mockResolvedValue({
      exists: true,
      data: () => state,
      readTime: { toMillis: () => now },
      updateTime: {},
    }),
    collection: () => ({ doc: () => person }),
  }
  const db = {
    doc: () => gate,
    runTransaction: vi.fn(async (callback) => callback({ update: vi.fn(), create: vi.fn() })),
  } as unknown as Firestore
  return { db, gate, person, state, now }
}

it('reuses a known global denial without another Firestore read', async () => {
  const now = Date.now()
  const policy = {
    ...structuredClone(DEFAULT_LIMITS),
    enabled: true,
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 60_000).toISOString(),
  }
  policy.budget.gemini = 0
  const gate = {
    get: vi.fn().mockResolvedValue({
      exists: true,
      data: () => createControlDocument(policy),
      readTime: { toMillis: () => now },
    }),
    collection: () => ({ doc: () => ({}) }),
  }
  const db = { doc: () => gate } as unknown as Firestore

  expect(await new FirestoreCostStore(db).reserve('a', { gemini: 1 })).toEqual({
    kind: 'limited',
    scope: 'global',
  })
  expect(await new FirestoreCostStore(db).reserve('b', { gemini: 1 })).toEqual({
    kind: 'limited',
    scope: 'global',
  })
  expect(gate.get).toHaveBeenCalledTimes(1)
})

it('separates UID denials and cost vectors, and expires them after one second', async () => {
  let clock = 100
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const { db, gate, person } = fakeStore({ uidLimited: true })
  const store = new FirestoreCostStore(db)
  expect(await store.reserve('a', { gemini: 1 })).toEqual({ kind: 'limited', scope: 'uid' })
  expect(await store.reserve('a', { gemini: 1 })).toEqual({ kind: 'limited', scope: 'uid' })
  expect(gate.get).toHaveBeenCalledTimes(1)
  person.get.mockResolvedValueOnce({ exists: false, data: () => undefined })
  expect((await store.reserve('b', { gemini: 1 })).kind).toBe('allowed')
  expect(await store.reserve('a', { gemini: 2 })).toEqual({ kind: 'limited', scope: 'uid' })
  expect(gate.get).toHaveBeenCalledTimes(3)
  expect(person.get).toHaveBeenCalledTimes(3)
  clock += 1000
  expect(await store.reserve('a', { gemini: 1 })).toEqual({ kind: 'limited', scope: 'uid' })
  expect(gate.get).toHaveBeenCalledTimes(4)
})

it('does not share global denials across database clients or different costs', async () => {
  const first = fakeStore({ globalLimited: true })
  const second = fakeStore({ globalLimited: true })
  expect((await new FirestoreCostStore(first.db).reserve('a', { gemini: 1 })).kind).toBe('limited')
  expect((await new FirestoreCostStore(first.db).reserve('a', { gemini: 2 })).kind).toBe('limited')
  expect((await new FirestoreCostStore(second.db).reserve('a', { gemini: 1 })).kind).toBe('limited')
  expect(first.gate.get).toHaveBeenCalledTimes(2)
  expect(second.gate.get).toHaveBeenCalledTimes(1)
})

it('does not cache store errors or allowed reservations', async () => {
  const { db, gate } = fakeStore()
  gate.get.mockRejectedValueOnce(new Error('offline'))
  const store = new FirestoreCostStore(db)
  expect((await store.reserve('a', { gemini: 1 })).kind).toBe('unavailable')
  expect((await store.reserve('a', { gemini: 1 })).kind).toBe('allowed')
  expect((await store.reserve('a', { gemini: 1 })).kind).toBe('allowed')
  expect(gate.get).toHaveBeenCalledTimes(3)
})

it('evicts old denials when the bounded cache is full', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(100)
  const { db, gate } = fakeStore({ uidLimited: true })
  const store = new FirestoreCostStore(db)
  for (let i = 0; i < 513; i += 1) await store.reserve(`user-${i}`, { gemini: 1 })
  expect(gate.get).toHaveBeenCalledTimes(513)
  await store.reserve('user-0', { gemini: 1 })
  expect(gate.get).toHaveBeenCalledTimes(514)
})

it('observes shutdown after a cached denial expires', async () => {
  let clock = 100
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const { db, gate, state } = fakeStore({ globalLimited: true })
  expect((await new FirestoreCostStore(db).reserve('a', { gemini: 1 })).kind).toBe('limited')
  state.policy.enabled = false
  expect((await new FirestoreCostStore(db).reserve('a', { gemini: 1 })).kind).toBe('limited')
  clock += 1000
  expect((await new FirestoreCostStore(db).reserve('a', { gemini: 1 })).kind).toBe('unavailable')
  expect(gate.get).toHaveBeenCalledTimes(2)
})
