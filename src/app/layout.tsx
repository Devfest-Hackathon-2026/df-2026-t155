import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
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
        <header className="border-b border-current/20 px-4 py-3">
          <p className="mx-auto w-full max-w-xl font-semibold">GroundTrip</p>
        </header>
        <main className="mx-auto w-full max-w-xl px-4 py-6">{children}</main>
      </body>
    </html>
  )
}
