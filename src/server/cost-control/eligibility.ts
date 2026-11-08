import 'server-only'

import { z } from 'zod'

import { getAdminAppCheck } from '@/lib/firebase/admin'

import { withinDeadline } from './store'

const inviteList = z.array(z.string().min(1).max(128)).max(100)
const jwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export type EligibilityFailure =
  'invite_required' | 'app_check_invalid' | 'app_check_unavailable' | 'protection_unavailable'

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

export async function checkEligibility(
  request: Request,
  uid: string,
): Promise<EligibilityFailure | null> {
  let invited: string[]
  try {
    invited = inviteList.parse(JSON.parse(process.env.COSTLY_API_INVITED_UIDS ?? '[]'))
  } catch {
    return 'protection_unavailable'
  }
  if (!invited.includes(uid)) return 'invite_required'

  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim()
  if (!appId) return 'protection_unavailable'
  const token = request.headers.get('X-Firebase-AppCheck')
  if (!token || token.length > 8192 || !jwt.test(token)) return 'app_check_invalid'

  try {
    const verified = await withinDeadline(3000, () => getAdminAppCheck().verifyToken(token))
    return verified.appId === appId ? null : 'app_check_invalid'
  } catch (error) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined
    if (errorCode(cause) === 'key-fetch-error') return 'app_check_unavailable'
    const code = errorCode(error)
    return code === 'app-check/invalid-argument' || code === 'app-check/app-check-token-expired'
      ? 'app_check_invalid'
      : 'app_check_unavailable'
  }
}
