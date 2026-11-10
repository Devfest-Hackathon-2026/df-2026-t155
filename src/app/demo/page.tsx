import Link from 'next/link'

import { RevisionDemo } from './revision-demo'
import './demo.css'

export const metadata = { title: '旅程の路線図（モック） | GroundTrip' }

// 旅程の路線図UIの確認用ページ（モックデータ）。実際のAPIには接続しない。
export default function DemoPage() {
  return (
    <div data-demo-stage className="mx-auto max-w-[100rem]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4">
        <h1 className="text-xl font-semibold sm:text-2xl">旅程の路線図（モック）</h1>
        <Link
          href="/terms"
          className="inline-flex min-h-11 items-center text-sm text-gt-muted underline underline-offset-2"
        >
          利用規約・プライバシー
        </Link>
      </div>
      <RevisionDemo />
    </div>
  )
}
