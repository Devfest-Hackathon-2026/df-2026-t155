import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { DemoExitAction } from '@/features/demo-access/demo-exit-action'
import { SiteFooter } from '@/features/legal/site-footer'
import { GroundTripBrand } from '@/features/screen-chrome/screen-header'
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
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja">
      <body
        className={`${geistSans.variable} ${geistMono.variable} flex min-h-dvh flex-col antialiased`}
      >
        <header className="gt-site-header border-b border-gt-rule bg-gt-paper">
          <div className="mx-auto grid w-full max-w-4xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 lg:grid-cols-[auto_auto_minmax(0,1fr)]">
            <div className="col-start-1 row-start-1 flex min-w-0 items-center">
              <GroundTripBrand />
            </div>
            <DemoExitAction />
            <div
              id="gt-desktop-nav"
              className="col-span-2 row-start-2 empty:hidden lg:col-span-1 lg:col-start-3 lg:row-start-1"
            />
          </div>
        </header>
        <main className="gt-site-main mx-auto w-full max-w-xl grow py-6">{children}</main>
        <SiteFooter />
        <div id="gt-mobile-nav" className="gt-mobile-nav" />
      </body>
    </html>
  )
}
