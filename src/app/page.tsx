import { SessionHomePlanner } from '@/features/home/session-home-planner'
import { WelcomeEntry } from '@/features/welcome/welcome-entry'

export default function Home() {
  return (
    <WelcomeEntry>
      <SessionHomePlanner />
    </WelcomeEntry>
  )
}
