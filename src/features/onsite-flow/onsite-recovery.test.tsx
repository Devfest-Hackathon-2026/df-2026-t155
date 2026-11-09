// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { sampleRevision, sampleTrip } from '@/domain/samples'
import {
  markApplyUnresolved,
  readUnresolvedApply,
} from '@/features/revision-review/unresolved-apply'
import { OnSiteReplanningFlow } from './onsite-replanning-flow'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('keeps a pending apply blocked after the onsite flow is remounted', () => {
  markApplyUnresolved('owner', sampleTrip.id, sampleTrip.version, 'revision')
  render(<OnSiteReplanningFlow trip={sampleTrip} ownerUid="owner" />)
  expect(screen.getByText(/適用結果を確認できませんでした/)).toBeTruthy()
})
it('does not unlock when the latest trip has the same version and the revision is unconfirmed', async () => {
  markApplyUnresolved('owner', sampleTrip.id, sampleTrip.version, 'revision')
  render(
    <OnSiteReplanningFlow
      trip={sampleTrip}
      ownerUid="owner"
      loadLatestTrip={vi.fn().mockResolvedValue(sampleTrip)}
      loadAppliedRevision={vi.fn().mockResolvedValue(null)}
    />,
  )
  await userEvent.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
  expect(readUnresolvedApply('owner', sampleTrip.id).status).toBe('pending')
})

it('再読込後は対象候補の承認記録と最新旅程が揃った場合だけ復旧する', async () => {
  const id = sampleRevision.id
  markApplyUnresolved('owner', sampleTrip.id, sampleTrip.version, id)
  const latest = {
    ...sampleTrip,
    version: sampleTrip.version + 1,
    stops: sampleTrip.stops.map((stop) =>
      stop.id === sampleRevision.targetStopId ? sampleRevision.diff.after : stop,
    ),
  }
  const approved = {
    ...sampleRevision,
    context: { phase: 'on_site', report: { kind: 'actual', description: '昼食店が休業' } },
    approval: { status: 'approved', decidedAt: '2026-11-08T12:00:00+09:00' },
  }
  const onTripChange = vi.fn()
  render(
    <OnSiteReplanningFlow
      trip={sampleTrip}
      ownerUid="owner"
      loadLatestTrip={vi.fn().mockResolvedValue(latest)}
      loadAppliedRevision={vi.fn().mockResolvedValue(approved)}
      onTripChange={onTripChange}
    />,
  )
  await userEvent.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
  await waitFor(() => expect(onTripChange).toHaveBeenCalledWith(latest))
  expect(readUnresolvedApply('owner', sampleTrip.id).status).toBe('clear')
})

it('再読込後に別候補の承認記録が返っても未確認状態を解除しない', async () => {
  markApplyUnresolved('owner', sampleTrip.id, sampleTrip.version, sampleRevision.id)
  const onTripChange = vi.fn()
  const otherRevision = {
    ...sampleRevision,
    id: 'another-revision',
    context: { phase: 'on_site', report: { kind: 'actual', description: '昼食店が休業' } },
    approval: { status: 'approved', decidedAt: '2026-11-08T12:00:00+09:00' },
  }
  render(
    <OnSiteReplanningFlow
      trip={sampleTrip}
      ownerUid="owner"
      loadLatestTrip={vi.fn().mockResolvedValue({ ...sampleTrip, version: sampleTrip.version + 1 })}
      loadAppliedRevision={vi.fn().mockResolvedValue(otherRevision)}
      onTripChange={onTripChange}
    />,
  )
  await userEvent.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
  await screen.findByText(/対象の適用を確認できませんでした/)
  expect(readUnresolvedApply('owner', sampleTrip.id).status).toBe('pending')
  expect(onTripChange).not.toHaveBeenCalled()
})
