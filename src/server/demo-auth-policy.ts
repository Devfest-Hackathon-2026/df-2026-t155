import 'server-only'

import { GoogleAuth } from 'google-auth-library'
import { z } from 'zod'

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/identitytoolkit'] })

const policySchema = z.object({
  subtype: z.literal('IDENTITY_PLATFORM'),
  client: z.object({
    permissions: z.object({
      disabledUserDeletion: z.literal(true),
      disabledUserSignup: z.literal(false).optional(),
    }),
  }),
  signIn: z
    .object({
      email: z.object({ enabled: z.literal(false).optional() }).optional(),
      phoneNumber: z.object({ enabled: z.literal(false).optional() }).optional(),
    })
    .optional(),
})

// 実環境では書き込み権限を持たず、交換のたびにIdentity Platformの現行設定を確認する。
export async function isDemoAuthPolicyConfigured(signal: AbortSignal): Promise<boolean> {
  const local = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
  // 呼び出し元は先にgetAdminAuthでプロジェクトとEmulator接続先を検証する。
  if (local && process.env.FIREBASE_USE_EMULATORS === 'true') return true
  const project = process.env.FIREBASE_PROJECT_ID
  if (!project) return false
  const { data } = await auth.request<unknown>({
    url: `https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(project)}/config`,
    params: { fields: 'subtype,client(permissions),signIn(email(enabled),phoneNumber(enabled))' },
    signal,
    retry: false,
  })
  return policySchema.safeParse(data).success
}
