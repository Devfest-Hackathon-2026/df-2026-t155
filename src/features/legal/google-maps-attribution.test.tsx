// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ATTRIBUTION_FONT_SIZE_PX,
  attributionTones,
  GoogleMapsAttribution,
  GoogleMapsSourceBox,
  type AttributionTone,
} from './google-maps-attribution'

afterEach(() => {
  cleanup()
})

// コントラスト比の計算（WCAG）。trip-map/contrast.test.ts と同じ方法。
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

// 色の許可リスト（Googleの要件）：白・#1F1F1F・#5E5E5E
const ALLOWED_COLORS = ['#ffffff', '#1f1f1f', '#5e5e5e']
// 各色を載せてよい背景。white は暗い背景の上でだけ使う。
const backgroundFor: Record<AttributionTone, string> = {
  gray: '#FFFFFF',
  black: '#FFFFFF',
  white: '#1F1F1F',
}
const tones = Object.keys(attributionTones) as AttributionTone[]

const attribution = (tone?: AttributionTone) => {
  render(<GoogleMapsAttribution tone={tone} />)
  return screen.getByText('Google Maps')
}

describe('GoogleMapsAttribution: 書式', () => {
  it('テキストが厳密に「Google Maps」で、翻訳されない（translate="no"）', () => {
    const el = attribution()
    expect(el.textContent).toBe('Google Maps')
    expect(el.getAttribute('translate')).toBe('no')
  })

  it('折り返さず、通常体・太さ400・letter-spacing normal・Roboto／sans-serif', () => {
    const el = attribution()
    expect(el.style.whiteSpace).toBe('nowrap')
    expect(el.style.fontStyle).toBe('normal')
    expect(el.style.fontWeight).toBe('400')
    expect(el.style.letterSpacing).toBe('normal')
    expect(el.style.fontFamily).toBe('Roboto, sans-serif')
  })

  it('文字サイズが12〜16pxの範囲', () => {
    const size = Number.parseFloat(attribution().style.fontSize)
    expect(size).toBe(ATTRIBUTION_FONT_SIZE_PX)
    expect(size).toBeGreaterThanOrEqual(12)
    expect(size).toBeLessThanOrEqual(16)
  })

  it('既定の色は #5E5E5E（gray）', () => {
    expect(attribution().style.color).toBe('rgb(94, 94, 94)')
  })

  it.each(tones)('%s: 色が許可された3色のいずれかで、載せる背景に対して4.5:1以上', (tone) => {
    const hex = attributionTones[tone]
    expect(ALLOWED_COLORS).toContain(hex.toLowerCase())
    expect(ratio(hex, backgroundFor[tone])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(tones)('%s: 表示される色が、定義した色と一致する', (tone) => {
    const el = attribution(tone)
    const hex = attributionTones[tone]
    const rgb = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')
    expect(el.style.color).toBe(`rgb(${rgb})`)
  })
})

describe('GoogleMapsSourceBox', () => {
  it('帰属が内容の後（下）にあり、同じ枠の中にある', () => {
    render(
      <GoogleMapsSourceBox caption="確認に使った情報源">
        <p>清水寺（名称の一致を確認）</p>
      </GoogleMapsSourceBox>,
    )
    const box = screen.getByRole('group', { name: '確認に使った情報源' })
    const content = screen.getByText('清水寺（名称の一致を確認）')
    const mark = screen.getByText('Google Maps')
    expect(box.contains(content)).toBe(true)
    expect(box.contains(mark)).toBe(true)
    // 内容が先、帰属が後（文書順）
    expect(content.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('枠と白い背景で他の内容と区別し、色をこのコンポーネントの中で決めている', () => {
    render(
      <GoogleMapsSourceBox>
        <p>内容</p>
      </GoogleMapsSourceBox>,
    )
    const box = screen.getByRole('group')
    expect(box.className).toMatch(/\bborder-/)
    expect(box.className).toContain('bg-white')
    expect(box.className).toContain('text-[#1F1F1F]')
  })

  it('説明文が無くても、グループに名前が付く', () => {
    render(
      <GoogleMapsSourceBox>
        <p>内容</p>
      </GoogleMapsSourceBox>,
    )
    expect(screen.getByRole('group', { name: 'Google Maps Platform由来の情報' })).toBeTruthy()
  })

  it('枠の外の内容と帰属が混ざらない（帰属は枠の中の1か所だけ）', () => {
    render(
      <>
        <p>AIの提案（Google由来ではない）</p>
        <GoogleMapsSourceBox>
          <p>内容</p>
        </GoogleMapsSourceBox>
      </>,
    )
    const marks = screen.getAllByText('Google Maps')
    expect(marks).toHaveLength(1)
    expect(screen.getByRole('group').contains(marks[0])).toBe(true)
  })
})
