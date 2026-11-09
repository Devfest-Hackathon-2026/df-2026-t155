// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { sampleTrip } from '@/domain/samples'
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
