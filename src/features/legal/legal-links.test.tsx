// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { LegalLinks } from './legal-links'

afterEach(() => {
  cleanup()
})

describe('LegalLinks', () => {
  it('Googleの3つの文書のURLが正確', () => {
    render(<LegalLinks />)
    const hrefOf = (name: RegExp) => screen.getByRole('link', { name }).getAttribute('href')
    expect(hrefOf(/Google Maps追加利用規約/)).toBe('https://maps.google.com/help/terms_maps/')
    expect(hrefOf(/^Google利用規約/)).toBe('https://policies.google.com/terms')
    expect(hrefOf(/Googleプライバシーポリシー/)).toBe('https://policies.google.com/privacy')
  })

  it('外部リンクは新しいタブで開き、noopener noreferrer と、開き方を伝える文言が付く', () => {
    render(<LegalLinks />)
    const external = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith('https://'))
    expect(external).toHaveLength(3)
    for (const a of external) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
      expect(a.textContent).toContain('（新しいタブで開きます）')
    }
  })

  it('サイト内の /terms へのリンクは、新しいタブで開かない', () => {
    render(<LegalLinks />)
    const own = screen.getByRole('link', { name: /利用規約・プライバシー/ })
    expect(own.getAttribute('href')).toBe('/terms')
    expect(own.getAttribute('target')).toBeNull()
  })

  it('includeSiteTerms={false} では、サイト内のリンクを出さない', () => {
    render(<LegalLinks includeSiteTerms={false} />)
    expect(screen.queryByRole('link', { name: /利用規約・プライバシー/ })).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })
})
