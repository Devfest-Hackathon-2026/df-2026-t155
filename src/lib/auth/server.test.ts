import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '../../app/api/auth/session/route'
import { getAdminAuth } from '../firebase/admin'
import { FirebaseConfigurationError } from '../firebase/config'
import { reportAuthUnavailable } from './diagnostics'
import { AuthError, authErrorResponse, requireActor, requireOwner } from './server'

vi.mock('../firebase/admin', () => ({ getAdminAuth: vi.fn() }))
vi.mock('./diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./diagnostics')>()),
  reportAuthUnavailable: vi.fn(),
}))
const verifyIdToken = vi.fn()

function request(authorization?: string) {
  return new Request('http://localhost/api/auth/session', {
    headers: authorization ? { Authorization: authorization } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAdminAuth, { partial: true }).mockReturnValue({ verifyIdToken })
  verifyIdToken.mockResolvedValue({ uid: 'verified-user' })
})

describe('サーバー認証・認可境界（SDKモック）', () => {
  it('失効検証を必須にし、検証されたUIDのみを返す', async () => {
    const actor = await requireActor(request('Bearer header.payload.signature'))
    expect(verifyIdToken).toHaveBeenCalledWith('header.payload.signature', true)
    expect(actor).toEqual({ uid: 'verified-user' })
  })

  it.each([
    undefined,
    'Basic abc',
    'Bearer missing-segments',
    'Bearer a.b.c, Bearer d.e.f',
    `Bearer ${'a'.repeat(8200)}.b.c`,
  ])('未認証・不正ヘッダーをSDK呼び出し前に拒否する', async (authorization) => {
    const response = await GET(request(authorization))
    expect(response.status).toBe(401)
    expect(verifyIdToken).not.toHaveBeenCalled()
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(reportAuthUnavailable).not.toHaveBeenCalled()
  })

  it.each([
    ['auth/id-token-expired', 'token_expired', 401],
    ['auth/id-token-revoked', 'session_revoked', 401],
    ['auth/user-disabled', 'session_revoked', 401],
    ['auth/user-not-found', 'session_revoked', 401],
    ['auth/invalid-id-token', 'invalid_token', 401],
    ['auth/argument-error', 'invalid_token', 401],
    ['auth/tenant-id-mismatch', 'invalid_token', 401],
    ['auth/insufficient-permission', 'auth_unavailable', 503],
    ['auth/network-request-failed', 'auth_unavailable', 503],
    ['auth/internal-error', 'auth_unavailable', 503],
  ])('%sを安全な応答へ変換する', async (sdkCode, expectedCode, status) => {
    verifyIdToken.mockRejectedValue({ code: sdkCode, message: 'private-sdk-detail' })
    const response = await GET(request('Bearer header.payload.signature'))
    const body = await response.json()
    expect(response.status).toBe(status)
    expect(body.error.code).toBe(expectedCode)
    expect(JSON.stringify(body)).not.toContain('private-sdk-detail')
    if (status === 503) {
      expect(reportAuthUnavailable).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: sdkCode }),
      )
    } else {
      expect(reportAuthUnavailable).not.toHaveBeenCalled()
    }
  })

  it('UIDをクエリや本文から取得せず、共有キャッシュを禁止する', async () => {
    const response = await GET(
      new Request('http://localhost/api/auth/session?uid=other-user', {
        headers: { Authorization: 'Bearer header.payload.signature' },
      }),
    )
    expect(await response.json()).toEqual({ uid: 'verified-user' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('保存済み所有者との不一致を存在情報なしで拒否する', async () => {
    const actor = await requireActor(request('Bearer header.payload.signature'))
    expect(() => requireOwner(actor, 'verified-user')).not.toThrow()
    expect(() => requireOwner(actor, 'other-user')).toThrow(AuthError)
    expect(authErrorResponse(new AuthError('not_found')).status).toBe(404)
  })

  it('初期化失敗・未知の失敗でも認証を通さず詳細を返さない', async () => {
    vi.mocked(getAdminAuth).mockImplementation(() => {
      throw new Error('private-configuration')
    })
    const response = await GET(request('Bearer header.payload.signature'))
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-configuration')
    expect(authErrorResponse(new Error('secret')).status).toBe(503)
    expect(reportAuthUnavailable).toHaveBeenCalledTimes(2)
    expect(reportAuthUnavailable).toHaveBeenLastCalledWith({ category: 'unknown', code: 'unknown' })
  })

  it('設定失敗を分類し、ログ用情報をHTTPレスポンスには追加しない', async () => {
    vi.mocked(getAdminAuth).mockImplementation(() => {
      throw new FirebaseConfigurationError()
    })
    const response = await GET(request('Bearer header.payload.signature'))
    expect(reportAuthUnavailable).toHaveBeenCalledExactlyOnceWith({
      category: 'configuration',
      code: 'firebase_configuration',
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: {
        code: 'auth_unavailable',
        message: '認証サービスを利用できません。時間をおいて再試行してください',
      },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('未知のSDKコードは原文を診断ログへ渡さない', async () => {
    verifyIdToken.mockRejectedValue({ code: 'private-user-or-token', stack: 'private-stack' })
    const response = await GET(request('Bearer header.payload.signature'))
    expect(response.status).toBe(503)
    expect(reportAuthUnavailable).toHaveBeenCalledExactlyOnceWith({
      category: 'unknown',
      code: 'unknown',
    })
  })
})
