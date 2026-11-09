import type { Metadata } from 'next'

import { DemoEndedScreen } from '@/features/demo-access/demo-exit-action'

export const metadata: Metadata = {
  title: 'デモを終了しました | GroundTrip',
  robots: { index: false, follow: false },
}

export default function DemoEndedPage() {
  return <DemoEndedScreen />
}
