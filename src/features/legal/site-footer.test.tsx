// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SiteFooter } from './site-footer'

afterEach(() => {
  cleanup()
})

describe('SiteFooter', () => {
  it('全ページ共通のフッターから、/terms とGoogleの3文書へ到達できる', () => {
    render(<SiteFooter />)

    const footer = screen.getByRole('contentinfo')
    const nav = within(footer).getByRole('navigation', { name: '利用条件' })
    expect(
      within(nav)
        .getByRole('link', { name: /利用規約・プライバシー/ })
        .getAttribute('href'),
    ).toBe('/terms')
    expect(within(nav).getAllByRole('link')).toHaveLength(4)
  })
})
