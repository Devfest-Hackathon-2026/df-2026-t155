import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { DemoExitAction } from '@/features/demo-access/demo-exit-action'
import { SiteFooter } from '@/features/legal/site-footer'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'GroundTrip',
  description: 'AIが作った旅程の提案を、根拠を見ながら自分で選べる日帰り旅行アプリ',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

// アプリ共通の最小限の枠。配色・ナビゲーション・装飾は、デザインが確定するまで決めない。
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <header className="border-b border-gt-rule px-4 py-3">
          <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-between gap-x-3">
            <p className="font-semibold">GroundTrip</p>
            <DemoExitAction />
          </div>
        </header>
        <main className="mx-auto w-full max-w-xl px-4 py-6">{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
