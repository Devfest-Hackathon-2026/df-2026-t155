// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TripSchema } from '@/domain'
import { sampleTrip } from '@/domain/samples'
import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'

import { noSavedLearnings } from '../../../tests/helpers/home-session'

import { HomePlanner } from './home-planner'

// 認証済みの利用者として扱う（認証SDKは使わない）。
vi.mock(
  '@/lib/auth/use-session-scope',
  async () => (await import('../../../tests/helpers/home-session')).sessionScopeModule,
)

afterEach(() => {
  cleanup()
})

// 生成直後の旅程は、AIの提案であり未照合（根拠は空）。
const generatedTrip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, isFixed: false, evidence: [] })),
})

describe('HomePlanner: 入力から路線図まで', () => {
  it('生成された旅程を路線図で表示し、未照合であることを示す', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue({ ok: true, trip: generatedTrip })
    const user = userEvent.setup()
    render(<HomePlanner generate={generate} loadLearnings={noSavedLearnings} />)

    await user.type(screen.getByLabelText(/旅行先/), '京都市東山エリア')
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))

    const route = await screen.findByRole('list', { name: '旅程の路線図' })
    expect(within(route).getAllByRole('listitem')).toHaveLength(3)
    expect(route.textContent).toContain('朝の庭園（架空）')
    expect(route.textContent?.match(/未照合/g)).toHaveLength(3)
    expect(route.textContent).not.toContain('情報源と整合')
  })

  it('生成された旅程では、候補生成APIが未接続の間は部分修正の導線を出さない', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue({ ok: true, trip: generatedTrip })
    const user = userEvent.setup()
    render(<HomePlanner generate={generate} loadLearnings={noSavedLearnings} />)

    await user.type(screen.getByLabelText(/旅行先/), '京都')
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    await user.click(await screen.findByRole('button', { name: /昼食店A/ }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'この予定を固定する' })).toBeTruthy()
    expect(dialog.textContent).toContain('照合していません')
    expect(within(dialog).queryByRole('button', { name: 'この予定だけ変更' })).toBeNull()
  })

  it('再生成に失敗すると、以前の旅程は表示から消える。保持されていると案内しない（保持されるのは入力内容だけ）', async () => {
    const generate = vi
      .fn<GenerateTrip>()
      .mockResolvedValueOnce({ ok: true, trip: generatedTrip })
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'external_service_error', message: '接続できませんでした' },
      })
    const user = userEvent.setup()
    render(<HomePlanner generate={generate} loadLearnings={noSavedLearnings} />)

    await user.type(screen.getByLabelText(/旅行先/), '京都市東山エリア')
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    expect(await screen.findByRole('list', { name: '旅程の路線図' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    const alert = await screen.findByRole('alert')

    expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull()
    expect(alert.textContent).toContain('入力内容は保持されています。')
    expect(alert.textContent).not.toContain('元の旅程')
    expect((screen.getByLabelText(/旅行先/) as HTMLInputElement).value).toBe('京都市東山エリア')
  })
})
