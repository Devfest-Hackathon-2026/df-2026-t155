import { describe, expect, it } from 'vitest'

import { sampleTrip } from '@/domain/samples'
import type { Evidence, Stop } from '@/domain'

import {
  clampIndex,
  evidenceLines,
  gapMinutes,
  progressOf,
  stepBack,
  stepForward,
  stopEndTime,
  stopProgressLabels,
  simulatedNote,
  travelBasesOf,
} from './progress-model'

const evidence = (
  id: string,
  subject: Evidence['subject'],
  status: Evidence['status'],
  sourceKind: Evidence['source']['kind'] = 'routes',
): Evidence => ({
  id,
  subject,
  claim: '確認した内容',
  applicability: '対象日時',
  source: { kind: sourceKind, label: '出典' },
  checkedAt: '2026-11-08T09:00:00+09:00',
  status,
  explanation: '説明',
})

const stopWith = (items: Evidence[]): Pick<Stop, 'evidence'> => ({ evidence: items })

describe('進行位置の計算', () => {
  it('範囲外・小数・NaNを、安全な範囲に収める', () => {
    expect(clampIndex(-3, 4)).toBe(0)
    expect(clampIndex(99, 4)).toBe(3)
    expect(clampIndex(1.9, 4)).toBe(1)
    expect(clampIndex(Number.NaN, 4)).toBe(0)
    expect(clampIndex(2, 0)).toBe(0)
  })

  it('進めると1つ先へ。最後の予定では進めず、位置も変えない', () => {
    expect(stepForward(0, 4)).toEqual({ moved: true, index: 1 })
    expect(stepForward(2, 4)).toEqual({ moved: true, index: 3 })
    expect(stepForward(3, 4)).toEqual({ moved: false, index: 3 })
  })

  it('戻すと1つ前へ。最初の予定では戻せず、位置も変えない', () => {
    expect(stepBack(3, 4)).toEqual({ moved: true, index: 2 })
    expect(stepBack(1, 4)).toEqual({ moved: true, index: 0 })
    expect(stepBack(0, 4)).toEqual({ moved: false, index: 0 })
  })

  it('範囲外の位置から始まっても、範囲を越えない', () => {
    expect(stepForward(10, 4)).toEqual({ moved: false, index: 3 })
    expect(stepBack(-2, 4)).toEqual({ moved: false, index: 0 })
  })

  it('進行状態は、訪問済み・いま・これからの3つで、文字がそれぞれ違う', () => {
    expect([0, 1, 2, 3].map((index) => progressOf(index, 2))).toEqual([
      'visited',
      'visited',
      'current',
      'upcoming',
    ])
    expect(new Set(Object.values(stopProgressLabels)).size).toBe(3)
  })
})

describe('予定上の時刻', () => {
  it('終了時刻と、前の予定の終了から次の開始までの間隔（分）を出す', () => {
    expect(stopEndTime({ plannedStartTime: '10:00', durationMinutes: 60 })).toBe('11:00')
    expect(stopEndTime({ plannedStartTime: '12:00', durationMinutes: 75 })).toBe('13:15')
    const [morning, lunch, exhibition] = sampleTrip.stops
    expect(gapMinutes(morning, lunch)).toBe(60)
    expect(gapMinutes(lunch, exhibition)).toBe(45)
    // 重なる場合は負になる（前の予定が終わる前に、次が始まる）。
    expect(gapMinutes({ plannedStartTime: '10:00', durationMinutes: 90 }, lunch)).toBe(30)
    expect(gapMinutes({ plannedStartTime: '11:30', durationMinutes: 60 }, lunch)).toBe(-30)
  })
})

// 実測・照合を思わせる文言。模擬データの表示には、決して使わない。
const realLookingWords =
  /情報源と整合|間に合う見込み|確認できた|営業時間内|矛盾あり|確認できない（|整合/

describe('移動の根拠の文言', () => {
  it('根拠が無ければ「移動時間は未確認」。間に合うと断定しない', () => {
    expect(travelBasesOf(stopWith([]))).toEqual([
      { kind: 'unchecked', text: '移動時間は未確認', simulated: false },
    ])
  })

  it('移動時間以外の根拠だけでは、移動の根拠にしない', () => {
    expect(travelBasesOf(stopWith([evidence('e1', 'opening_hours', 'consistent')]))).toEqual([
      { kind: 'unchecked', text: '移動時間は未確認', simulated: false },
    ])
  })

  it.each([
    ['consistent', '移動の根拠：情報源と整合'],
    ['conflicting', '移動の根拠：矛盾あり'],
    ['unverifiable', '移動時間を確認できない'],
  ] as const)('実際の根拠 %s は「%s」', (status, text) => {
    expect(travelBasesOf(stopWith([evidence('e1', 'travel_time', status)]))).toEqual([
      { kind: status, text, simulated: false },
    ])
  })

  it('複数の実際の根拠があれば、最も重い状態を示す（矛盾を整合の陰に隠さない）', () => {
    const bases = travelBasesOf(
      stopWith([
        evidence('e1', 'travel_time', 'consistent'),
        evidence('e2', 'travel_time', 'conflicting'),
        evidence('e3', 'travel_time', 'unverifiable'),
      ]),
    )
    expect(bases.map((basis) => basis.kind)).toEqual(['conflicting'])
  })

  it.each([
    ['consistent', 'デモ用の想定'],
    ['conflicting', 'デモ用の想定（食い違いあり）'],
    ['unverifiable', 'デモ用の想定（確認できない）'],
  ] as const)(
    '模擬データだけなら、実測の根拠は無いので「移動時間は未確認」と、デモ用の「%s」を示す',
    (status, demoText) => {
      const bases = travelBasesOf(stopWith([evidence('e1', 'travel_time', status, 'simulation')]))
      expect(bases).toEqual([
        { kind: 'unchecked', text: '移動時間は未確認', simulated: false },
        { kind: status, text: demoText, simulated: true },
      ])
      // 模擬の見出しには、実測・照合を思わせる文言を使わない。
      expect(demoText).not.toMatch(realLookingWords)
    },
  )

  it('実際の根拠と模擬が混在するとき、実際の分は従来どおり。模擬は数えず、別にデモ用で示す', () => {
    const bases = travelBasesOf(
      stopWith([
        evidence('e1', 'travel_time', 'consistent', 'routes'),
        evidence('e2', 'travel_time', 'conflicting', 'simulation'),
      ]),
    )
    expect(bases).toEqual([
      { kind: 'consistent', text: '移動の根拠：情報源と整合', simulated: false },
      { kind: 'conflicting', text: 'デモ用の想定（食い違いあり）', simulated: true },
    ])
  })

  it('模擬の「整合」は、実際の矛盾を打ち消さず、実際の整合にも数えない', () => {
    const bases = travelBasesOf(
      stopWith([
        evidence('e1', 'travel_time', 'conflicting', 'routes'),
        evidence('e2', 'travel_time', 'consistent', 'simulation'),
      ]),
    )
    expect(bases[0]).toEqual({
      kind: 'conflicting',
      text: '移動の根拠：矛盾あり',
      simulated: false,
    })
    expect(bases.filter((basis) => !basis.simulated)).toHaveLength(1)
  })
})

describe('予定の根拠の状態', () => {
  it('根拠が無ければ空（未照合として扱う）', () => {
    expect(evidenceLines(stopWith([]))).toEqual([])
  })

  it('確認項目ごとに、最も重い状態を1行にまとめ、項目の順に並べる', () => {
    const lines = evidenceLines(
      stopWith([
        evidence('e1', 'travel_time', 'consistent', 'routes'),
        evidence('e2', 'place_identity', 'consistent', 'places'),
        evidence('e3', 'place_identity', 'unverifiable', 'places'),
        evidence('e4', 'opening_hours', 'conflicting', 'places'),
      ]),
    )
    expect(lines.map((line) => `${line.subjectLabel}：${line.statusLabel}`)).toEqual([
      '施設の存在：確認できない',
      '営業時間：矛盾あり',
      '移動時間：情報源と整合',
    ])
    expect(lines.every((line) => !line.simulated)).toBe(true)
  })

  it.each([
    ['consistent', 'デモ用の想定'],
    ['conflicting', 'デモ用の想定（食い違いあり）'],
    ['unverifiable', 'デモ用の想定（確認できない）'],
  ] as const)('模擬の %s は「%s」。実測・照合を思わせる文言を使わない', (status, label) => {
    const lines = evidenceLines(stopWith([evidence('e1', 'place_identity', status, 'simulation')]))
    expect(lines).toEqual([
      {
        subject: 'place_identity',
        subjectLabel: '施設の存在',
        status,
        statusLabel: label,
        simulated: true,
      },
    ])
    expect(lines[0].statusLabel).not.toMatch(realLookingWords)
  })

  it('同じ項目に実際の根拠と模擬が混在するとき、模擬の分だけがデモ用の行になる', () => {
    const lines = evidenceLines(
      stopWith([
        evidence('e1', 'opening_hours', 'consistent', 'places'),
        evidence('e2', 'opening_hours', 'consistent', 'simulation'),
        evidence('e3', 'place_identity', 'consistent', 'simulation'),
      ]),
    )
    expect(lines.map((line) => [line.subjectLabel, line.statusLabel, line.simulated])).toEqual([
      ['施設の存在', 'デモ用の想定', true],
      ['営業時間', '情報源と整合', false],
      ['営業時間', 'デモ用の想定', true],
    ])
  })

  it('模擬の「整合」は、実際の矛盾を隠さず、模擬の矛盾は実際の整合を打ち消さない', () => {
    const lines = evidenceLines(
      stopWith([
        evidence('e1', 'opening_hours', 'conflicting', 'places'),
        evidence('e2', 'opening_hours', 'consistent', 'simulation'),
        evidence('e3', 'place_identity', 'consistent', 'places'),
        evidence('e4', 'place_identity', 'conflicting', 'simulation'),
      ]),
    )
    expect(lines.map((line) => line.statusLabel)).toEqual([
      '情報源と整合',
      'デモ用の想定（食い違いあり）',
      '矛盾あり',
      'デモ用の想定',
    ])
  })

  it('模擬の補足は、実際の施設・営業時間・移動を確認した結果ではないと伝える', () => {
    expect(simulatedNote).toBe('実際の施設・営業時間・移動を確認した結果ではありません')
  })
})
