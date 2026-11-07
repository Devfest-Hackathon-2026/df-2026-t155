import { describe, expect, it } from 'vitest'

import { sampleLearning, sampleTrip } from '@/domain/samples'

import { validateIncomingCandidates } from './intake'

const context = {
  tripId: sampleTrip.id,
  region: sampleTrip.region,
  existingIds: new Set<string>(),
}
const make = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ...sampleLearning, id: `learning-${i}` }))

describe('validateIncomingCandidates', () => {
  it('1〜3件の、未承認で、同じ旅程・地域の候補を受け入れる', () => {
    for (const n of [1, 2, 3]) {
      expect(validateIncomingCandidates(make(n), context)).toMatchObject({ ok: true })
    }
  })

  it('0件・4件以上は拒否する', () => {
    expect(validateIncomingCandidates([], context).ok).toBe(false)
    expect(validateIncomingCandidates(make(4), context).ok).toBe(false)
  })

  it('承認済み・却下済みの候補が1件でもあれば、全体を拒否する', () => {
    for (const approval of [
      { status: 'approved', decidedAt: '2026-11-08T10:00:00+09:00' },
      { status: 'rejected', decidedAt: '2026-11-08T10:00:00+09:00' },
    ]) {
      const result = validateIncomingCandidates(
        [...make(2), { ...make(1)[0], id: 'x', approval }],
        context,
      )
      expect(result.ok).toBe(false)
    }
  })

  it('候補どうしで、同じIDがあれば拒否する（承認の操作が、意図しない候補に作用するため）', () => {
    const result = validateIncomingCandidates([make(1)[0], make(1)[0]], context)

    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.reason).toContain('同じID')
  })

  it('既存の候補と同じIDがあれば拒否する', () => {
    const result = validateIncomingCandidates(make(1), {
      ...context,
      existingIds: new Set(['learning-0']),
    })

    expect(result.ok).toBe(false)
  })

  it('別の旅程から作られた候補は拒否する', () => {
    expect(
      validateIncomingCandidates([{ ...make(1)[0], sourceTripId: 'trip-other' }], context).ok,
    ).toBe(false)
  })

  it('適用する地域が、旅程の地域と一致しない候補は拒否する。全地域の候補は受け入れる', () => {
    expect(
      validateIncomingCandidates(
        [{ ...make(1)[0], scope: { kind: 'region', region: '別の地域' } }],
        context,
      ).ok,
    ).toBe(false)
    expect(
      validateIncomingCandidates([{ ...make(1)[0], scope: { kind: 'all_trips' } }], context).ok,
    ).toBe(true)
  })

  it('契約に合わない候補（内容が空など）は拒否する', () => {
    expect(validateIncomingCandidates([{ ...make(1)[0], content: ' ' }], context).ok).toBe(false)
    expect(validateIncomingCandidates([{ nope: true }], context).ok).toBe(false)
  })
})
