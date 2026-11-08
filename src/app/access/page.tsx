import type { Metadata } from 'next'

import { AccessScreen } from './access-screen'

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function AccessPage() {
  return <AccessScreen />
}
