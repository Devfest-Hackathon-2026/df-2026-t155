import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('認証障害の診断ログ（時計・consoleモック）', () => {
  it.each([
    ['auth/insufficient-permission', 'permission'],
    ['auth/invalid-credential', 'credential'],
    ['app/invalid-credential', 'credential'],
    ['auth/network-request-failed', 'network'],
    ['app/network-error', 'network'],
    ['auth/internal-error', 'internal'],
  ])('許可した%sの分類・コードだけを記録する', async (code, category) => {
    const { classifyAuthFailure, reportAuthUnavailable } = await import('./diagnostics')
    reportAuthUnavailable(
      classifyAuthFailure({
        code,
        message: 'private-sdk-message',
        uid: 'private-uid',
        token: 'private-token',
        environment: 'private-environment',
        stack: 'private-stack',
      }),
    )
    expect(console.error).toHaveBeenCalledExactlyOnceWith('auth_unavailable', { category, code })
  })

  it.each([
    undefined,
    null,
    'private-error',
    new Error('private-error'),
    { code: 'private-code\nforged-log-entry' },
    { code: '__proto__' },
    { code: 'constructor' },
    { code: 401 },
    { code: { secret: 'private-value' } },
  ])('未知の値を有限のunknownコードへ正規化する', async (error) => {
    const { classifyAuthFailure, reportAuthUnavailable } = await import('./diagnostics')
    reportAuthUnavailable(classifyAuthFailure(error))
    expect(console.error).toHaveBeenCalledExactlyOnceWith('auth_unavailable', {
      category: 'unknown',
      code: 'unknown',
    })
  })

  it('同じコードの大量発生を抑制し、別の分類と次の時間枠は記録する', async () => {
    const { classifyAuthFailure, reportAuthUnavailable } = await import('./diagnostics')
    const network = classifyAuthFailure({ code: 'app/network-error' })
    for (let count = 0; count < 100; count++) reportAuthUnavailable(network)
    expect(console.error).toHaveBeenCalledTimes(1)
    reportAuthUnavailable(classifyAuthFailure({ code: 'auth/insufficient-permission' }))
    expect(console.error).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(59_999)
    reportAuthUnavailable(network)
    expect(console.error).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    reportAuthUnavailable(network)
    expect(console.error).toHaveBeenCalledTimes(3)
  })

  it('攻撃者が未知のコードを変えてもログ枠が増えない', async () => {
    const { classifyAuthFailure, reportAuthUnavailable } = await import('./diagnostics')
    for (let count = 0; count < 100; count++) {
      reportAuthUnavailable(classifyAuthFailure({ code: `private-${count}` }))
    }
    expect(console.error).toHaveBeenCalledTimes(1)
  })
})
