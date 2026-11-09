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
    expect(screen.queryByRole('button', { name: '旅程を作成する' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '旅行中の進行状況' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '旅程の提案' }))
    await user.click(screen.getByRole('button', { name: '旅行中' }))
    expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull()
    expect(screen.getByRole('heading', { name: '旅行中の進行状況' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '旅行前' }))
    expect(screen.getByRole('list', { name: '旅程の路線図' })).toBe(route)
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

  it('再生成に失敗した後も、入力と前の旅程に戻れる', async () => {
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
    const route = await screen.findByRole('list', { name: '旅程の路線図' })
    await user.click(screen.getByRole('button', { name: '旅行条件・保存済みの旅程' }))
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    const alert = await screen.findByRole('alert')

    expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull()
    expect(alert.textContent).toContain('入力内容は保持されています。')
    expect((screen.getByLabelText(/旅行先/) as HTMLInputElement).value).toBe('京都市東山エリア')
    await user.click(screen.getByRole('button', { name: '旅程へ戻る' }))
    expect(screen.getByRole('list', { name: '旅程の路線図' })).toBe(route)
  })
})
