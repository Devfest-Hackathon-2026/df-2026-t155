// APIのRoute Handlerが共通で使うHTTP処理。外部サービスの生データや内部情報は、応答に含めない。

// 共通契約の応答（提案・失敗）に含まれない、API層だけのエラー。
export type ApiErrorStatus =
  | 'service_unavailable'
  | 'invalid_request'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'internal_error'

export interface ApiErrorBody {
  status: ApiErrorStatus
  message: string
  issues?: { path: string; message: string }[]
}

export const noStoreHeaders = { 'Cache-Control': 'no-store' }

export const errorResponse = (httpStatus: number, body: ApiErrorBody): Response =>
  Response.json(body, { status: httpStatus, headers: noStoreHeaders })

export type BodyReadResult =
  { ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' }

// 本文をストリームで読み、上限を超えた時点で読み取りを中止する。
// 全量を読み込んでから大きさを判定すると、巨大な本文でメモリを消費してしまう。
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<BodyReadResult> {
  if (!request.body) return { ok: true, text: '' }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    // 接続の切断など、ストリームの読み取り失敗。
    return { ok: false, reason: 'unreadable' }
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(merged) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}
