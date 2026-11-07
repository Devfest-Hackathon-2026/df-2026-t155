import { RevisionDemo } from './revision-demo'

export const metadata = { title: '旅程の路線図（モック） | GroundTrip' }

// 旅程の路線図UIの確認用ページ（モックデータ）。実際のAPIには接続しない。
export default function DemoPage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">旅程の路線図（モック）</h1>
      <RevisionDemo />
    </>
  )
}
