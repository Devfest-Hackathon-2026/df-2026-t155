import 'server-only'

import { getAdminAuth } from '../firebase/admin'
import { classifyAuthFailure, reportAuthUnavailable, type AuthDiagnostic } from './diagnostics'

export type Actor = Readonly<{ uid: string }>

type AuthErrorCode =
  | 'unauthenticated'
  | 'invalid_token'
  | 'token_expired'
  | 'session_revoked'
  | 'auth_unavailable'
  | 'not_found'

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly diagnostic: AuthDiagnostic = classifyAuthFailure(undefined),
  ) {
    const messages: Record<AuthErrorCode, string> = {
      unauthenticated: '認証が必要です',
      invalid_token: '認証情報を確認できません',
      token_expired: '認証情報の有効期限が切れています',
      session_revoked: '認証を継続できません。再認証が必要です',
      auth_unavailable: '認証サービスを利用できません。時間をおいて再試行してください',
      not_found: '対象が見つかりません',
    }
    super(messages[code])
    this.name = 'AuthError'
  }
}

export async function requireActor(request: Pick<Request, 'headers'>): Promise<Actor> {
  const authorization = request.headers.get('authorization')
  if (!authorization) throw new AuthError('unauthenticated')
  if (authorization.length > 8192) throw new AuthError('invalid_token')
  // 重複ヘッダーの結合、余分な空白、巨大なトークンを受け付けない。
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/i.exec(authorization)
  if (!match) throw new AuthError('invalid_token')
  try {
    const decoded = await getAdminAuth().verifyIdToken(match[1], true)
    return Object.freeze({ uid: decoded.uid })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'auth/id-token-expired') throw new AuthError('token_expired')
    if (
      code === 'auth/id-token-revoked' ||
      code === 'auth/user-disabled' ||
      code === 'auth/user-not-found'
    ) {
      throw new AuthError('session_revoked')
    }
    if (
      code === 'auth/argument-error' ||
      code === 'auth/invalid-id-token' ||
      code === 'auth/tenant-id-mismatch'
    ) {
      throw new AuthError('invalid_token')
    }
    // 設定・IAM・ネットワークの失敗を、認証成功やUIDフォールバックに変換しない。
    throw new AuthError('auth_unavailable', classifyAuthFailure(error))
  }
}

// ownerUidは保存済みレコード等、サーバーが取得した値だけを渡す。
// 本文から受け取ったownerUidとの比較は認可にならない。
export function requireOwner(actor: Actor, ownerUid: string): void {
  if (actor.uid !== ownerUid) throw new AuthError('not_found')
}

export function authErrorResponse(error: unknown): Response {
  const authError =
    error instanceof AuthError
      ? error
      : new AuthError('auth_unavailable', classifyAuthFailure(error))
  if (authError.code === 'auth_unavailable') reportAuthUnavailable(authError.diagnostic)
  const status =
    authError.code === 'auth_unavailable' ? 503 : authError.code === 'not_found' ? 404 : 401
  const headers = new Headers({ 'Cache-Control': 'private, no-store' })
  if (status === 401) headers.set('WWW-Authenticate', 'Bearer')
  return Response.json(
    { error: { code: authError.code, message: authError.message } },
    { status, headers },
  )
}
