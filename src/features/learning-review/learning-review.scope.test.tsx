// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleLearning, sampleTrip } from '@/domain/samples'
import { captureSessionScope } from '@/lib/auth/session-scope'

import { fakeAuth } from '../../../tests/helpers/fake-auth-client'
import type { CandidatesResult } from './api-client'
import { LearningReview, type RequestCandidates } from './learning-review'

vi.mock('@/lib/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/client')>()
  const { fakeAuth: fake } = await import('../../../tests/helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

beforeEach(() => {
  fakeAuth.reset()
  fakeAuth.signInAs('user-a')
})
afterEach(() => cleanup())

describe('LearningReview: 認証セッションに束縛した候補生成', () => {
  it('取得したセッションをAPIクライアントへ渡す', async () => {
    const scope = await captureSessionScope()
    const request = vi
      .fn<RequestCandidates>()
      .mockResolvedValue({ ok: true, learnings: [sampleLearning] })
    render(<LearningReview trip={sampleTrip} scope={scope} requestCandidates={request} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/感想・変更した理由/), '昼食後は休みたかった')
    await user.click(screen.getByRole('button', { name: /学びの候補を作/ }))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(request.mock.calls[0][1]).toMatchObject({ scope })
  })

  it('送信中に別のセッションへ切り替わったら、成功した古い結果も画面に反映しない', async () => {
    const scope = await captureSessionScope()
    let respond!: (result: CandidatesResult) => void
    const request = vi
      .fn<RequestCandidates>()
      .mockReturnValue(new Promise((resolve) => (respond = resolve)))
    render(<LearningReview trip={sampleTrip} scope={scope} requestCandidates={request} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/感想・変更した理由/), '昼食後は休みたかった')
    await user.click(screen.getByRole('button', { name: /学びの候補を作/ }))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    fakeAuth.signInAs('user-b')
    respond({ ok: true, learnings: [sampleLearning] })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.queryByText(sampleLearning.content)).toBeNull()
    expect(screen.queryByDisplayValue(sampleLearning.content)).toBeNull()
  })
})
