import { describe, expect, it } from 'vitest'

import { palette, paletteStyle } from './palette'

// 進行状況の表示の色の組み合わせが、文字（4.5:1）・境界（3:1）のコントラストを満たすことを固定する。
const channel = (value: number) => {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const WHITE = '#ffffff'

describe('進行状況の色のコントラスト', () => {
  const surfaces = [palette.page, palette.card, palette.visited, palette.accentTint]

  it.each(surfaces)('文字（濃い色・補助の色）は、背景 %s の上で4.5:1以上', (surface) => {
    expect(ratio(palette.ink, surface)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette.muted, surface)).toBeGreaterThanOrEqual(4.5)
  })

  it('白い文字は、オレンジの塗りの上で4.5:1以上（進める・いまここ）', () => {
    expect(ratio(WHITE, palette.accent)).toBeGreaterThanOrEqual(4.5)
  })

  it('根拠の状態の文字は、白い面とオレンジの薄い面の上で4.5:1以上', () => {
    for (const color of [palette.ok, palette.warn, palette.unknown, palette.accent]) {
      expect(ratio(color, palette.card)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(color, palette.accentTint)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(surfaces)('境界線とオレンジの縁は、隣接する背景 %s に対して3:1以上', (surface) => {
    expect(ratio(palette.edge, surface)).toBeGreaterThanOrEqual(3)
    expect(ratio(palette.accent, surface)).toBeGreaterThanOrEqual(3)
  })

  it('CSS変数は、パレットの全ての色を持つ', () => {
    expect(Object.values(paletteStyle)).toEqual(expect.arrayContaining(Object.values(palette)))
  })
})
