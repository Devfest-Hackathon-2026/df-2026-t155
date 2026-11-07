// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import TermsPage, { metadata } from './page'

afterEach(() => {
  cleanup()
})

describe('利用条件ページ', () => {
  it('メタデータのタイトルが付く', () => {
    expect(String(metadata.title)).toContain('利用規約・プライバシー・Google Mapsについて')
  })

  it('見出し構造：h1が1つ、h2が4つ（この順）', () => {
    render(<TermsPage />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(h2).toEqual([
      '1. このアプリについて',
      '2. Google Maps Platformの利用',
      '3. プライバシー',
      '4. お問い合わせ・変更',
    ])
  })

  it('各セクションに、見出しで名前が付く', () => {
    render(<TermsPage />)
    expect(screen.getAllByRole('region')).toHaveLength(4)
  })

  it('Googleの3つの文書へのリンクがある（新しいタブ・noopener noreferrer）', () => {
    render(<TermsPage />)
    for (const href of [
      'https://maps.google.com/help/terms_maps/',
      'https://policies.google.com/terms',
      'https://policies.google.com/privacy',
    ]) {
      const link = document.querySelector(`a[href="${href}"]`)
      expect(link, href).not.toBeNull()
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
      expect(link?.getAttribute('target')).toBe('_blank')
    }
  })

  it('位置情報を取得しないこと、Place IDだけが例外であること、AIとGoogle Maps Platformへ送ることを書く', () => {
    render(<TermsPage />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('位置情報を取得しません')
    expect(text).toMatch(/Place\s*ID/)
    expect(text).toContain('Vertex AI')
    expect(text).toMatch(/Google\s*Maps\s*Platformへ送ります/)
    expect(text).toContain('この版のアプリは')
  })

  it('断定的な保証表現や、未確定の運用（保存期間・連絡先の個別情報）を書かない', () => {
    render(<TermsPage />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/保証します|保証いたします|必ず|絶対|完全に|100%/)
    expect(text).not.toMatch(/保存期間|@[a-z0-9.-]+\.[a-z]{2,}|法的責任/)
  })
})
