import Link from 'next/link'

// 利用条件の文書へのリンク一覧。サイト内の利用条件ページと、Googleの3つの文書。
// 外部リンクは別のタブで開き、そのことを支援技術にも伝える。

export const googleLegalLinks = [
  {
    label: 'Google Maps追加利用規約',
    href: 'https://maps.google.com/help/terms_maps/',
  },
  {
    label: 'Google利用規約',
    href: 'https://policies.google.com/terms',
  },
  {
    label: 'Googleプライバシーポリシー',
    href: 'https://policies.google.com/privacy',
  },
] as const

const linkClass = 'inline-flex min-h-11 items-center underline underline-offset-2'

export function LegalLinks({ includeSiteTerms = true }: { includeSiteTerms?: boolean }) {
  return (
    <ul className="m-0 list-none space-y-0.5 p-0">
      {includeSiteTerms && (
        <li>
          <Link href="/terms" className={linkClass}>
            利用規約・プライバシー・Google Mapsについて
          </Link>
        </li>
      )}
      {googleLegalLinks.map((link) => (
        <li key={link.href}>
          <a href={link.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {link.label}
            <span className="sr-only">（新しいタブで開きます）</span>
            <span aria-hidden="true" className="ml-1 text-xs">
              ↗
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}
