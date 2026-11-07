import { TripPlanner } from '@/features/trip-planner/trip-planner'

export default function Home() {
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">日帰り旅程を作る</h1>
      <TripPlanner />
    </>
  )
}
