import { LegalLinks } from './legal-links'

// 全ページ共通のフッター。利用規約・プライバシー（/terms）とGoogleの3文書へ、どの画面からも到達できるようにする。
// 配色はページ全体の明色テーマに合わせる（背景に対して4.5:1以上）。
export function SiteFooter() {
  return (
    <footer className="gt-site-footer mt-8 border-t border-gt-rule py-6">
      <nav aria-label="利用条件" className="mx-auto w-full max-w-xl text-sm">
        <p className="mb-1 font-semibold">利用条件</p>
        <LegalLinks />
      </nav>
    </footer>
  )
}
