import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { afterAll, describe, expect, it } from 'vitest'

import { GET } from '../../src/app/api/auth/session/route'
import { requireActor, requireOwner } from '../../src/lib/auth/server'
import { getAdminAuth } from '../../src/lib/firebase/admin'

const apps: FirebaseApp[] = []

async function createSession(name: string) {
  const app = initializeApp({ projectId: 'demo-groundtrip', apiKey: 'demo-api-key' }, name)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const { user } = await signInAnonymously(auth)
  const token = await user.getIdToken()
  const request = new Request('http://localhost/api/auth/session?uid=untrusted-user', {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { user, request }
}

// Auth Emulator限定。署名なしトークンのクレーム検査・失効検査を確認し、
// 本番の暗号学的な署名検証を検証したとは扱わない。
function withEmulatorClaims(request: Request, changes: Record<string, string | number>) {
  const token = request.headers.get('authorization')?.slice('Bearer '.length)
  if (!token) throw new Error('Emulatorテストの認証がありません')
  const [header, payload] = token.split('.')
  const claims: Record<string, unknown> = JSON.parse(Buffer.from(payload, 'base64url').toString())
  const changed = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url')
  return new Request(request.url, {
    headers: { Authorization: `Bearer ${header}.${changed}.` },
  })
}

afterAll(async () => {
  await Promise.all(apps.map((app) => deleteApp(app)))
})

describe('Firebase Auth Emulator＋実Admin SDK＋Route Handler', () => {
  it('匿名認証したA/Bを区別し、検証された本人のUIDのみを返す', async () => {
    const a = await createSession('integration-a')
    const b = await createSession('integration-b')
    expect(a.user.uid === b.user.uid).toBe(false)
    expect(a.user.isAnonymous).toBe(true)
    const response = await GET(a.request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ uid: a.user.uid })
    const actor = await requireActor(a.request)
    expect(() => requireOwner(actor, a.user.uid)).not.toThrow()
    expect(() => requireOwner(actor, b.user.uid)).toThrow()
  })

  it('未認証・不正トークンを拒否する', async () => {
    const noAuth = await GET(new Request('http://localhost/api/auth/session'))
    expect(noAuth.status).toBe(401)
    const invalid = await GET(
      new Request('http://localhost/api/auth/session', {
        headers: { Authorization: 'Bearer invalid.invalid.invalid' },
      }),
    )
    expect(invalid.status).toBe(401)
  })

  it('無効化されたユーザーの既存トークンを拒否する', async () => {
    const session = await createSession('integration-disabled')
    await getAdminAuth().updateUser(session.user.uid, { disabled: true })
    const response = await GET(session.request)
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('session_revoked')
  })

  it('削除されたユーザーの既存トークンを拒否する', async () => {
    const session = await createSession('integration-deleted')
    await getAdminAuth().deleteUser(session.user.uid)
    const response = await GET(session.request)
    expect(response.status).toBe(401)
  })

  it('期限切れのEmulatorトークンを拒否する', async () => {
    const session = await createSession('integration-expired')
    const response = await GET(withEmulatorClaims(session.request, { exp: 1 }))
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('token_expired')
  })

  it.each(['aud', 'iss'])('異なるプロジェクトの%sを拒否する', async (claim) => {
    const session = await createSession(`integration-project-${apps.length}`)
    const value = claim === 'aud' ? 'other-project' : 'https://securetoken.google.com/other-project'
    const response = await GET(withEmulatorClaims(session.request, { [claim]: value }))
    expect(response.status).toBe(401)
  })

  it('失効前に認証されたセッションを拒否する', async () => {
    const session = await createSession('integration-revoked')
    await getAdminAuth().revokeRefreshTokens(session.user.uid)
    const response = await GET(withEmulatorClaims(session.request, { auth_time: 1 }))
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('session_revoked')
  })
})
