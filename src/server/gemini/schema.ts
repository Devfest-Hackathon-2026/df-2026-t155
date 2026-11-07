import { z } from 'zod'

// Geminiが対象とするJSON Schemaの一部に含まれないキー。拒否や無視を避けるため渡さない。
// 厳密な制約（時刻形式・最小長・範囲）は、受け取った出力をZodで検証して保証する。
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'pattern',
  'minLength',
  'maxLength',
  'format',
  'exclusiveMinimum',
  'exclusiveMaximum',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function toGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiSchema)
  if (!isRecord(node)) return node

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
    // Zodが整数に付ける安全な整数の上限は意味を持たないため省く。
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue
    if (key === 'properties' && isRecord(value)) {
      // propertiesのキーはプロパティ名なので、名前は残して値だけ変換する。
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, toGeminiSchema(schema)]),
      )
      continue
    }
    result[key] = toGeminiSchema(value)
  }
  // 「0より大きい整数」は、サポートされるminimumで表す。
  if (node.type === 'integer' && node.exclusiveMinimum === 0) result.minimum = 1
  return result
}

// ZodスキーマからGeminiのresponseJsonSchemaを作る。型と制約の二重管理を避ける。
export function buildGeminiResponseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = toGeminiSchema(z.toJSONSchema(schema, { io: 'input' }))
  if (!isRecord(converted)) throw new Error('JSON Schemaの生成に失敗しました')
  return converted
}
