import { describe, expect, it } from 'vitest'

import { ONSITE_PALETTE as p } from './palette'

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

describe('現地報告フォームの色のコントラスト', () => {
  it.each([
    ['入力枠・ラジオ枠（地色に対して）', p.edge, p.paper, 3],
    ['入力枠・ラジオ枠（選択中の地色に対して）', p.edge, p.selected, 3],
    ['選択中の枠', p.ink, p.selected, 3],
    ['送信ボタンの枠', p.ink, p.paper, 3],
    ['送信ボタンの地色（地色に対して）', p.accent, p.paper, 3],
    ['本文', p.ink, p.paper, 4.5],
    ['補足の文字', p.muted, p.paper, 4.5],
    ['選択中の行の補足の文字', p.muted, p.selected, 4.5],
    ['送信ボタンの白い文字', '#ffffff', p.accent, 4.5],
    ['不備・失敗の文字', p.warn, p.warnBg, 4.5],
    ['不備・失敗の枠（地色に対して）', p.warn, p.paper, 3],
    ['模擬報告の注意の文字', p.caution, p.cautionBg, 4.5],
    ['模擬報告の注意の枠（地色に対して）', p.caution, p.paper, 3],
  ])('%s', (_name, fg, bg, min) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min)
  })
})
