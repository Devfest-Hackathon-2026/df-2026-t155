// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { TripSchema } from '@/domain'
import { sampleTrip } from '@/domain/samples'
import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'

import { homeScope, noSavedLearnings } from '../../../tests/helpers/home-session'

import { HomePlanner } from './home-planner'

const auth = vi.hoisted(() => ({ session: vi.fn() }))
vi.mock('@/lib/auth/use-session-scope', () => ({ useSessionScope: auth.session }))

afterEach(cleanup)
beforeEach(() => {
  auth.session.mockReturnValue({ status: 'authenticated', scope: homeScope, scopeEpoch: 0 })
})

const generatedTrip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, isFixed: false, evidence: [] })),
})

it('写真テーマを既存フォームへ渡すが、選択や遷移だけでは生成を呼ばない', async () => {
  const generate = vi.fn<GenerateTrip>()
  const user = userEvent.setup()
  render(<HomePlanner showDiscoveryHome generate={generate} loadLearnings={noSavedLearnings} />)

  await user.click(screen.getByRole('button', { name: /城と歴史/ }))
  expect(generate).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('旅の希望（任意）'), '座って休める場所も入れたい')
  await user.click(screen.getByRole('button', { name: '旅の条件へ進む' }))

  expect(((await screen.findByLabelText('旅行先（必須）')) as HTMLInputElement).value).toBe(
    '名古屋市',
  )
  expect((screen.getByLabelText('希望条件（任意）') as HTMLTextAreaElement).value).toBe(
    '名古屋の歴史や街並みを楽しみたい\n座って休める場所も入れたい',
  )
  expect((screen.getByLabelText('日付（必須）') as HTMLInputElement).value).toBe('')
  expect(generate).not.toHaveBeenCalled()
})

it('認証案内が不要な状態では共通status帯を描画しない', () => {
  const { container } = render(<HomePlanner showDiscoveryHome loadLearnings={noSavedLearnings} />)

  expect(container.querySelector('[data-session-status]')).toBeNull()
})

it('認証状態と復旧操作はDiscoveryHomeと旅程の両方で一度だけ表示する', async () => {
  const generate = vi.fn<GenerateTrip>().mockResolvedValue({ ok: true, trip: generatedTrip })
  const startNewSession = vi.fn()
  const statusContent = (
    <div>
      <p role="status">利用状態を確認できません。新しい利用を始められます。</p>
      <button type="button" onClick={startNewSession}>
        新しい利用を始める
      </button>
    </div>
  )
  const user = userEvent.setup()
  const { rerender } = render(
    <HomePlanner
      showDiscoveryHome
      statusContent={statusContent}
      generate={generate}
      loadLearnings={noSavedLearnings}
    />,
  )

  expect(screen.getByRole('status').textContent).toContain('利用状態を確認できません')
  expect(screen.getAllByRole('status')).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: '新しい利用を始める' }))
  expect(startNewSession).toHaveBeenCalledOnce()

  await user.click(screen.getByRole('button', { name: '名古屋城の写真をテーマに選ぶ' }))
  await user.click(screen.getByRole('button', { name: '旅の条件へ進む' }))
  await user.type(screen.getByLabelText('旅行先（必須）'), '名古屋市')
  await user.type(screen.getByLabelText('日付（必須）'), '2026-11-14')
  await user.click(screen.getByRole('button', { name: '旅程を作成する' }))

  expect(await screen.findByRole('list', { name: '旅程の路線図' })).toBeTruthy()
  expect(screen.getAllByText('利用状態を確認できません。新しい利用を始められます。')).toHaveLength(
    1,
  )
  expect(screen.getByRole('button', { name: '新しい利用を始める' })).toBeTruthy()

  auth.session.mockReturnValue({
    status: 'session_ended',
    error: { message: 'session ended' },
    scopeEpoch: 1,
  })
  rerender(
    <HomePlanner
      showDiscoveryHome
      statusContent={statusContent}
      generate={generate}
      loadLearnings={noSavedLearnings}
    />,
  )
  expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull()
  expect(screen.getByLabelText('旅行先（必須）')).toBeTruthy()
  expect(screen.getAllByText('利用状態を確認できません。新しい利用を始められます。')).toHaveLength(
    1,
  )
})
