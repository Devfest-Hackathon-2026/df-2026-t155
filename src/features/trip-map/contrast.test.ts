import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// 路線図UIの色トークン（globals.css）の組み合わせが、文字のコントラスト（WCAG AA 4.5:1）を満たすことを
// 保証する。色を差し替えたときに、読みにくい組み合わせが入らないようにする。
const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf-8')

const token = (name: string): string => {
  const match = new RegExp(`--gt-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)
  if (!match) throw new Error(`色トークン --gt-${name} が見つかりません`)
  return match[1]
}

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

// 前景色（透明度つき）を背景に重ねた色。
const blend = (fg: string, bg: string, alpha: number) => {
  const mix = (i: number) =>
    Math.round(
      Number.parseInt(fg.slice(i, i + 2), 16) * alpha +
        Number.parseInt(bg.slice(i, i + 2), 16) * (1 - alpha),
    )
  return `#${[1, 3, 5].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`
}

const WHITE = '#ffffff'

describe('路線図UIの文字のコントラスト（4.5:1以上）', () => {
  it.each([
    ['地の上の本文', () => ratio(token('ink'), token('bg'))],
    ['チケット（白）の上の本文', () => ratio(token('ink'), token('paper'))],
    ['地の上の補足（muted）', () => ratio(token('muted'), token('bg'))],
    ['チケット（白）の上の補足', () => ratio(token('muted'), token('paper'))],
    ['ロックの印（白い印）', () => ratio(WHITE, token('ink'))],
    ['部分修正ボタン（白い文字）', () => ratio(WHITE, token('line-strong'))],
    ['情報源と整合', () => ratio(token('ok'), token('ok-bg'))],
    ['矛盾あり', () => ratio(token('warn'), token('warn-bg'))],
    ['確認できない', () => ratio(token('unk'), token('unk-bg'))],
    ['エラー表示の見出し', () => ratio(token('warn'), token('warn-bg'))],
  ])('%s', (_name, compute) => {
    expect(compute()).toBeGreaterThanOrEqual(4.5)
  })

  it('白い文字を載せるボタンに、元のアクセント色（--gt-line）は使えない（だから別トークンにしている）', () => {
    expect(ratio(WHITE, token('line'))).toBeLessThan(4.5)
  })
})
