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
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <header className="bg-gt-paper px-4">
          <div className="mx-auto grid w-full max-w-[34rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
            <div className="gt-site-brand col-start-1 row-start-1 flex min-h-[69px] min-w-0 items-center">
              <GroundTripBrand />
            </div>
            <DemoExitAction />
          </div>
        </header>
        <main className="mx-auto w-full max-w-xl px-4 py-6">{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
