import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { reserveCost } from './cost-control/store'
import { runCostlyOperation } from './costly-api'

vi.mock('./cost-control/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cost-control/store')>()),
  reserveCost: vi.fn(),
}))

const actor = { uid: 'test-user' }
const release = vi.fn(async () => undefined)
const write = vi.fn()
const revokeWrite = vi.fn(async () => undefined)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(reserveCost).mockResolvedValue({
    kind: 'allowed',
    workAvailableMs: 150_000,
    release,
    write,
    revokeWrite,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('共有枠取得後の操作', () => {
  it('例外で終了しても送信済み処理がなければ同時実行枠を解放する', async () => {
    const error = new Error('local failure')
    await expect(
      runCostlyOperation(actor, { gemini: 1 }, async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('未予約のプロバイダー呼び出しを実行せず、予約済みの回数を超えない', async () => {
    const gemini = vi.fn(async () => 'done')
    const maps = vi.fn(async () => 'done')
    const outcome = await runCostlyOperation(actor, { gemini: 1 }, async (operation) => {
      await operation.call('gemini', gemini)
      await expect(operation.call('gemini', gemini)).rejects.toThrow()
      await expect(operation.call('places', maps)).rejects.toThrow()
      return 'done'
    })
    expect(outcome).toBeInstanceOf(Response)
    expect((outcome as Response).status).toBe(503)
    expect(gemini).toHaveBeenCalledTimes(1)
    expect(maps).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('下流の例外で結果が不明ならリースを残す', async () => {
    const error = new Error('lost response')
    const outcome = await runCostlyOperation(actor, { gemini: 1 }, async (operation) => {
      await expect(
        operation.call('gemini', async () => {
          throw error
        }),
      ).rejects.toBe(error)
      return 'done'
    })
    expect(outcome).toBe('done')
    expect(release).not.toHaveBeenCalled()
  })

  it('操作がタイムアウトした後、遅れて再開した処理が外部送信できない', async () => {
    vi.useFakeTimers()
    const resume = Promise.withResolvers<void>()
    const attempt = Promise.withResolvers<void>()
    const dispatch = vi.fn(async () => 'done')
    vi.mocked(reserveCost).mockResolvedValue({
      kind: 'allowed',
      workAvailableMs: 20,
      release,
      write,
      revokeWrite,
    })

    const outcome = runCostlyOperation(actor, { routes: 1 }, async (operation) => {
      await resume.promise
      try {
        return await operation.call('routes', dispatch)
      } finally {
        attempt.resolve()
      }
    })
    await vi.advanceTimersByTimeAsync(25)
    const response = await outcome
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(503)
    resume.resolve()
    await attempt.promise
    expect(dispatch).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })
})
