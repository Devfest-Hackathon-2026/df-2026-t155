import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import { ClientAuthError } from '@/lib/auth/client'

import { AuthRequiredError } from './api-client'
import { createBrowserVerifier, verifyTripFromBrowser, withAuthHeaders } from './browser-verify'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('withAuthHeaders（認証ヘッダーを付ける唯一の場所）', () => {
  it('提供元がなければ、fetchをそのまま使う（挙動を変えない）', () => {
    const base = vi.fn() as unknown as typeof fetch
    expect(withAuthHeaders(base)).toBe(base)
  })

  it('取得できたヘッダーを、元のヘッダーに足して送る', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'))
    const wrapped = withAuthHeaders(base as unknown as typeof fetch, async () => {
      return new Headers({ Authorization: 'Bearer token-1' })
    })

    await wrapped('/api/trips/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
    })

    const init = base.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer token-1')
    expect(headers.get('Content-Type')).toBe('text/plain')
    expect(init.method).toBe('POST')
  })

  it('トークンを取得できなくても、ヘッダーなしでそのまま送る', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'))
    const wrapped = withAuthHeaders(base as unknown as typeof fetch, async () => {
      throw new Error('session_ended')
    })

    await wrapped('/api/trips/verify', { method: 'POST' })

    expect(base).toHaveBeenCalledWith('/api/trips/verify', { method: 'POST' })
  })
})

describe('verifyTripFromBrowser', () => {
  it('今は認証ヘッダーを付けず、/api/trips/verify に旅程を送る', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'service_unavailable', message: '停止中' }), {
        status: 503,
      }),
    )
    vi.stubGlobal('fetch', fetchFn)

    const result = await verifyTripFromBrowser(sampleTrip)

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'service_unavailable', message: '停止中' },
    })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/trips/verify')
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
  })
})

describe('withAuthHeaders: requireAuth（認証が必須のとき、未認証では送信しない）', () => {
  const token = async () => new Headers({ Authorization: 'Bearer token-1' })

  it('既定（requireAuth=false）は現状維持：トークンを取得できなくても、ヘッダーなしで送る', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'))
    for (const provider of [
      async () => {
        throw new ClientAuthError('session_ended')
      },
      async () => undefined,
    ]) {
      await withAuthHeaders(base as unknown as typeof fetch, provider)('/api/trips/verify', {})
    }
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('requireAuth=true でトークンを取得できたら、ヘッダーを付けて送る', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'))
    await withAuthHeaders(base as unknown as typeof fetch, token, { requireAuth: true })(
      '/api/trips/verify',
      { method: 'POST' },
    )
    expect(new Headers(base.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer token-1')
  })

  it('requireAuth=true で取得に失敗したら、送信せず、認証基盤のエラーをそのまま投げる', async () => {
    const base = vi.fn()
    const error = new ClientAuthError('unavailable')
    const wrapped = withAuthHeaders(
      base as unknown as typeof fetch,
      async () => {
        throw error
      },
      { requireAuth: true },
    )

    await expect(wrapped('/api/trips/verify', {})).rejects.toBe(error)
    expect(base).not.toHaveBeenCalled()
  })

  it('requireAuth=true で、認証基盤以外のエラー・ヘッダーなし・Authorizationなしでも、送信しない', async () => {
    const base = vi.fn()
    for (const provider of [
      async () => {
        throw new Error('boom')
      },
      async () => undefined,
      async () => new Headers({ 'X-Other': '1' }),
    ]) {
      const wrapped = withAuthHeaders(base as unknown as typeof fetch, provider, {
        requireAuth: true,
      })
      await expect(wrapped('/api/trips/verify', {})).rejects.toBeInstanceOf(AuthRequiredError)
    }
    expect(base).not.toHaveBeenCalled()
  })

  it('requireAuth=true で認証情報の提供元が無いときも、送信しない（fail-closed）', async () => {
    const base = vi.fn()
    const wrapped = withAuthHeaders(base as unknown as typeof fetch, undefined, {
      requireAuth: true,
    })
    await expect(wrapped('/api/trips/verify', {})).rejects.toBeInstanceOf(AuthRequiredError)
    expect(base).not.toHaveBeenCalled()
  })
})

describe('createBrowserVerifier', () => {
  const stubFetch = () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'service_unavailable', message: '停止中' }), {
        status: 503,
      }),
    )
    vi.stubGlobal('fetch', fetchFn)
    return fetchFn
  }

  it('認証が必須で、トークンを取得できないとき：通信せず、認証基盤のエラーを区別した文言で失敗する', async () => {
    const fetchFn = stubFetch()
    const verify = createBrowserVerifier({
      requireAuth: true,
      getHeaders: async () => {
        throw new ClientAuthError('session_ended')
      },
    })

    const result = await verify(sampleTrip)

    expect(fetchFn).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'auth_required', message: new ClientAuthError('session_ended').message },
    })
  })

  it('認証基盤のエラーの種類ごとに、文言が違う（再試行で直るか、再開が必要かを区別できる）', async () => {
    stubFetch()
    const messages = new Set<string>()
    for (const code of ['session_ended', 'unavailable', 'configuration_error'] as const) {
      const verify = createBrowserVerifier({
        requireAuth: true,
        getHeaders: async () => {
          throw new ClientAuthError(code)
        },
      })
      const result = await verify(sampleTrip)
      if (result.ok) throw new Error('成功してはならない')
      messages.add(result.failure.message)
    }
    expect(messages.size).toBe(3)
  })

  it('認証が必須で、トークンを取得できたら、Authorizationを付けて送る', async () => {
    const fetchFn = stubFetch()
    const verify = createBrowserVerifier({
      requireAuth: true,
      getHeaders: async () => new Headers({ Authorization: 'Bearer token-1' }),
    })

    await verify(sampleTrip)

    expect(new Headers(fetchFn.mock.calls[0][1].headers).get('Authorization')).toBe(
      'Bearer token-1',
    )
  })

  it('既定の入口（verifyTripFromBrowser）は、認証を要求しない（現状維持）', async () => {
    const fetchFn = stubFetch()
    await verifyTripFromBrowser(sampleTrip)
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})

describe('照合の入口: App Checkを用意できないとき', () => {
  it('requireAuth: true では送信せず、app_check_unavailable で返す（SDKの原文は出さない）', async () => {
    const fetchFn = vi.fn()
    vi.stubGlobal('fetch', fetchFn)
    const getHeaders = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('recaptcha secret-detail'), { name: 'AppCheckUnavailableError' }),
      )
    const result = await createBrowserVerifier({ getHeaders, requireAuth: true })(sampleTrip)

    expect(result).toMatchObject({ ok: false, failure: { kind: 'app_check_unavailable' } })
    expect(JSON.stringify(result)).not.toContain('secret-detail')
    expect(fetchFn).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
