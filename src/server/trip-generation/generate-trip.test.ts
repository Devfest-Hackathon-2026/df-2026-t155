import { describe, expect, it, vi } from 'vitest'

import { GenerateTripResponseSchema } from '../../domain'
import { sampleGenerateTripRequest } from '../../domain/samples'
import { GeminiCallError, type GeminiJsonClient } from '../gemini/client'
import { buildDraftResponseJsonSchema, GeneratedTripDraftSchema } from './draft'
import { generateTrip, type GenerationFailureEvent } from './generate-trip'

const validDraft = {
  failure: null,
  stops: [
    { fixedStopId: 'stop-morning', name: '朝', plannedStartTime: '10:00', durationMinutes: 60 },
    { fixedStopId: null, name: '昼食店（テスト）', plannedStartTime: '12:00', durationMinutes: 75 },
    {
      fixedStopId: 'stop-exhibition',
      name: '展示',
      plannedStartTime: '14:00',
      durationMinutes: 60,
    },
  ],
  learningApplications: [
    { learningId: 'learning-rest', stopIndexes: [1], explanation: '昼食後の休憩を確保した' },
  ],
}

const clientReturning = (
  text: string,
): GeminiJsonClient & { generateJson: ReturnType<typeof vi.fn> } => ({
  generateJson: vi.fn().mockResolvedValue(text),
})

const clientRejecting = (error: unknown) => ({
  generateJson: vi.fn().mockRejectedValue(error),
})

const run = async (client: GeminiJsonClient) => {
  const events: GenerationFailureEvent[] = []
  const response = await generateTrip(sampleGenerateTripRequest, {
    client,
    report: (event) => events.push(event),
  })
  return { response, events }
}

describe('generateTrip: 正常系', () => {
  it('Geminiの下書きを検証・変換して、提案（proposed）のTripとして返す', async () => {
    const client = clientReturning(JSON.stringify(validDraft))
    const { response, events } = await run(client)

    expect(GenerateTripResponseSchema.safeParse(response).success).toBe(true)
    expect(response.status).toBe('proposed')
    if (response.status !== 'proposed') return
    expect(response.trip.stops).toHaveLength(3)
    expect(response.trip.stops[1]).toMatchObject({
      name: '昼食店（テスト）',
      placeId: null,
      isFixed: false,
      evidence: [],
    })
    expect(events).toEqual([])
  })

  it('課金対象のGemini呼び出しは1回だけで、スキーマとプロンプトを渡す', async () => {
    const client = clientReturning(JSON.stringify(validDraft))
    await run(client)

    expect(client.generateJson).toHaveBeenCalledTimes(1)
    const call = client.generateJson.mock.calls[0][0]
    expect(call.prompt).toContain('2026-11-08')
    expect(call.systemInstruction).toContain('旅程')
    expect(call.responseJsonSchema).toEqual(buildDraftResponseJsonSchema())
  })

  it('モデルが旅程を作れないと申告した場合は、その区分で失敗として返す（AIの回答と分かる）', async () => {
    const insufficient = {
      failure: { status: 'insufficient_information', reason: '地域を特定できません' },
      stops: [],
      learningApplications: [],
    }
    const { response } = await run(clientReturning(JSON.stringify(insufficient)))
    expect(response).toEqual({
      status: 'insufficient_information',
      message: 'AIの回答: 地域を特定できません',
    })

    const noCandidates = { ...insufficient, failure: { status: 'no_candidates', reason: '無理' } }
    const second = await run(clientReturning(JSON.stringify(noCandidates)))
    expect(second.response.status).toBe('no_candidates')
  })
})

describe('generateTrip: Gemini呼び出しの失敗（external_service_error）', () => {
  it.each(['not_configured', 'api_error', 'blocked', 'incomplete', 'empty_response'] as const)(
    '%s は外部サービス失敗として返し、再試行しない',
    async (reason) => {
      const client = clientRejecting(new GeminiCallError(reason, '内部メッセージ', { status: 503 }))
      const { response, events } = await run(client)

      expect(response.status).toBe('external_service_error')
      expect(client.generateJson).toHaveBeenCalledTimes(1)
      expect(events).toEqual([{ kind: 'gemini_call', reason, status: 503 }])
      // 内部メッセージ（原因の詳細）は利用者向けの応答へ出さない。
      expect(JSON.stringify(response)).not.toContain('内部メッセージ')
    },
  )

  it('想定外の例外も外部サービス失敗として返し、例外の中身を応答に含めない', async () => {
    const secret = 'Bearer dummy-secret-value'
    const { response, events } = await run(clientRejecting(new TypeError(secret)))

    expect(response.status).toBe('external_service_error')
    expect(JSON.stringify(response)).not.toContain('dummy-secret-value')
    expect(JSON.stringify(events)).not.toContain('dummy-secret-value')
    expect(events).toEqual([{ kind: 'unexpected_client_error', errorName: 'TypeError' }])
  })
})

describe('generateTrip: 不正な生成結果（no_candidates）', () => {
  const expectNoCandidates = async (text: string) => {
    const client = clientReturning(text)
    const { response, events } = await run(client)
    expect(response.status).toBe('no_candidates')
    expect(client.generateJson).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('invalid_output')
    if (response.status === 'proposed') throw new Error('失敗として返されることを期待しました')
    return response
  }

  it('JSONとして解釈できない出力', async () => {
    await expectNoCandidates('これはJSONではありません')
    await expectNoCandidates('{"failure": null, "stops": [')
  })

  it('下書きの形式に合わない出力（キー不足・余分なキー・型違い）', async () => {
    await expectNoCandidates('{}')
    await expectNoCandidates(JSON.stringify({ ...validDraft, extra: 1 }))
    await expectNoCandidates(
      JSON.stringify({
        ...validDraft,
        stops: [{ ...validDraft.stops[0], durationMinutes: '60' }, ...validDraft.stops.slice(1)],
      }),
    )
  })

  it('時刻の形式が不正な出力', async () => {
    const stops = validDraft.stops.map((stop, index) =>
      index === 1 ? { ...stop, plannedStartTime: '正午' } : stop,
    )
    await expectNoCandidates(JSON.stringify({ ...validDraft, stops }))
  })

  it('failureがnullなのに地点が少ない出力', async () => {
    await expectNoCandidates(JSON.stringify({ ...validDraft, stops: [] }))
  })

  it('固定予定を欠いた出力は、利用者に理由が分かる形で失敗として返す', async () => {
    const stops = validDraft.stops.slice(0, 2).concat({
      fixedStopId: null,
      name: '展示のつもり',
      plannedStartTime: '14:00',
      durationMinutes: 60,
    })
    const response = await expectNoCandidates(JSON.stringify({ ...validDraft, stops }))
    expect(response.message).toContain('固定予定が旅程に含まれていません')
  })

  it('入力にない学びを反映したと主張する出力', async () => {
    const learningApplications = [
      { learningId: 'learning-invented', stopIndexes: [1], explanation: '反映した' },
    ]
    await expectNoCandidates(JSON.stringify({ ...validDraft, learningApplications }))
  })

  it('失敗の応答は共通契約に適合し、更新後のTripを含まない', async () => {
    const response = await expectNoCandidates('壊れた出力')
    expect(GenerateTripResponseSchema.safeParse(response).success).toBe(true)
    expect(response).not.toHaveProperty('trip')
  })
})

// JSON Schemaの全ノードを再帰的にたどり、出現するキーを集める（properties内のプロパティ名は除く）。
const collectSchemaKeys = (node: unknown, keys = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) {
    node.forEach((child) => collectSchemaKeys(child, keys))
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      keys.add(key)
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        Object.values(value).forEach((child) => collectSchemaKeys(child, keys))
      } else {
        collectSchemaKeys(value, keys)
      }
    }
  }
  return keys
}

describe('Geminiへ渡すJSON Schema', () => {
  const schema = buildDraftResponseJsonSchema()

  it('Geminiが対象としないキー（pattern・minLength・exclusive系・安全整数の上限）を含まない', () => {
    const keys = collectSchemaKeys(schema)
    for (const unsupported of ['$schema', 'pattern', 'minLength', 'format', 'exclusiveMinimum']) {
      expect(keys).not.toContain(unsupported)
    }
    expect(JSON.stringify(schema)).not.toContain(String(Number.MAX_SAFE_INTEGER))
  })

  it('必須項目・地点数の上限・滞在分の範囲・null許容は引き続き表現する', () => {
    expect(schema).toMatchObject({
      required: ['failure', 'stops', 'learningApplications'],
      properties: {
        stops: {
          maxItems: 4,
          items: {
            additionalProperties: false,
            required: ['fixedStopId', 'name', 'plannedStartTime', 'durationMinutes'],
            properties: {
              fixedStopId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              durationMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
            },
          },
        },
      },
    })
  })

  it('時刻の形式は、パターンではなく説明文でAIに伝える', () => {
    expect(JSON.stringify(schema)).toContain('HH:mm')
  })
})

describe('draftスキーマ', () => {
  it('正常な下書きを受け入れ、JSON Schemaは$schemaを含まず厳密なオブジェクトとして出力する', () => {
    expect(GeneratedTripDraftSchema.safeParse(validDraft).success).toBe(true)

    const schema = buildDraftResponseJsonSchema()
    expect(schema).not.toHaveProperty('$schema')
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['failure', 'stops', 'learningApplications']),
    })
  })
})
