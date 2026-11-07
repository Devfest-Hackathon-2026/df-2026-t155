import { authErrorResponse, requireActor } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 認証疎通用。認証情報の発行・保存・有料API呼び出しは行わない。
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireActor(request)
    return Response.json(actor, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return authErrorResponse(error)
  }
}
