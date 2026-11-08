import { describe, expect, it } from 'vitest'

import { createRequestGate } from './request-gate'

describe('createRequestGate', () => {
  it('最新の要求だけを採用する。後から始めた要求があれば、先の要求の結果は採用しない', () => {
    const gate = createRequestGate()
    const older = gate.begin()
    expect(older.isCurrent()).toBe(true)
    const newer = gate.begin()
    expect(older.isCurrent()).toBe(false)
    expect(newer.isCurrent()).toBe(true)
  })

  it('後から始めても、先の通信は中止しない（順序の保護と中止は別）', () => {
    const gate = createRequestGate()
    const older = gate.begin()
    gate.begin()
    expect(older.isCurrent()).toBe(false)
    expect(older.signal.aborted).toBe(false)
  })

  it('cancel() は、進行中の要求の通信を中止し、結果も採用しない', () => {
    const gate = createRequestGate()
    const ticket = gate.begin()
    gate.cancel()
    expect(ticket.signal.aborted).toBe(true)
    expect(ticket.isCurrent()).toBe(false)
  })

  it('cancel() の後に始めた要求は、新しい中止信号を使い、採用できる', () => {
    const gate = createRequestGate()
    const before = gate.begin()
    gate.cancel()
    const after = gate.begin()
    expect(after.signal.aborted).toBe(false)
    expect(after.isCurrent()).toBe(true)
    expect(before.isCurrent()).toBe(false)
    expect(after.signal).not.toBe(before.signal)
  })

  it('cancel() を2回続けても、後から始めた要求は採用できる', () => {
    const gate = createRequestGate()
    gate.cancel()
    gate.cancel()
    expect(gate.begin().isCurrent()).toBe(true)
  })
})
