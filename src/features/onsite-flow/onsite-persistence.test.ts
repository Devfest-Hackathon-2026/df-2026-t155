import { expect, it, vi } from 'vitest'
import { sampleRevision, sampleReviseTripRequest } from '@/domain/samples'
import { ReflectionApiError } from '@/features/reflection-flow/api-client'
import { createOnSiteApply } from './onsite-persistence'

it('does not apply a revision when saving the candidate has an unknown outcome', async () => {
  const send = vi.fn().mockRejectedValue(new Error('connection lost'))
  const apply = createOnSiteApply(send)
  const result = await apply({
    request: sampleReviseTripRequest,
    revision: sampleRevision,
    proposalToken: 'token',
  })
  expect(result.status).toBe('failed')
  expect(send).toHaveBeenCalledTimes(1)
})
it('keeps an apply result uncertain after a 503 response', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ revision: sampleRevision })
    .mockRejectedValueOnce(
      new ReflectionApiError('unavailable', 503, 'protection_unavailable', 'rejected'),
    )
  const result = await createOnSiteApply(send)({
    request: sampleReviseTripRequest,
    revision: sampleRevision,
    proposalToken: 'token',
  })
  expect(result.status).toBe('uncertain')
})
it('does not apply if the saved candidate targets a different base version', async () => {
  const send = vi.fn().mockResolvedValue({
    revision: { ...sampleRevision, baseTripVersion: sampleRevision.baseTripVersion + 1 },
  })
  const result = await createOnSiteApply(send)({
    request: sampleReviseTripRequest,
    revision: sampleRevision,
    proposalToken: 'token',
  })
  expect(result.status).toBe('failed')
  expect(send).toHaveBeenCalledTimes(1)
})

it('does not apply if the review was abandoned while the candidate was saving', async () => {
  const controller = new AbortController()
  let finish!: (value: unknown) => void
  const send = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const result = createOnSiteApply(send)(
    { request: sampleReviseTripRequest, revision: sampleRevision, proposalToken: 'token' },
    controller.signal,
  )
  controller.abort()
  finish({ revision: sampleRevision })
  expect((await result).status).toBe('failed')
  expect(send).toHaveBeenCalledTimes(1)
})
