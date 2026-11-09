// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision, sampleTrip } from '@/domain/samples'
import { TripSchema, type Evidence, type Stop, type Trip } from '@/domain'
import * as reportForm from '@/features/onsite-report/onsite-report-form'
import type {
  ApplyRevision,
  GenerateRevisions,
  RevisionProposal,
} from '@/features/revision-review/api-client'
import * as progressView from '@/features/trip-progress/trip-progress-view'

import { OnSiteReplanningFlow } from './onsite-replanning-flow'

afterEach(() => cleanup())

type User = ReturnType<typeof userEvent.setup>

const goToLunch = async (user: User) => {
  await user.click(screen.getByRole('button', { name: '次の予定へ進む' }))
  await user.click(screen.getByRole('button', { name: '予定が変わった？この予定だけ変更する' }))
}

const closedPreset = /閉店・臨時休業だった/
const delayedPreset = /遅れていて、次の予定に間に合わない/

const submitReport = async (
  user: User,
  kind: 'actual' | 'simulated',
  preset: RegExp = closedPreset,
) => {
  await user.click(screen.getByRole('radio', { name: preset }))
  await user.click(
    screen.getByRole('radio', {
      name: kind === 'actual' ? /いまの現地の状況（実際の報告）/ : /デモ用の模擬報告/,
    }),
  )
  await user.click(
    screen.getByRole('button', {
      name: kind === 'actual' ? '実際の報告で候補検索へ' : '模擬報告で候補検索へ',
    }),
  )
}

// 成立（satisfied）する候補と、根拠になる比較データ。revision-route-view.test.tsx と同じ前提を使う。
const lunch = sampleTrip.stops[1]
const after: Stop = {
  ...sampleRevision.diff.after,
  placeId: 'test-place',
  evidence: (['place_identity', 'opening_hours'] as const).map((subject) => ({
    ...sampleRevision.diff.after.evidence[0],
    id: `test-${subject}`,
    subject,
    source: { kind: 'places' as const, label: 'Google Places' },
    status: 'consistent' as const,
    explanation: '候補の根拠',
  })),
}

function leg(fromStopId: string, toStopId: string, durationMinutes: number) {
  return {
    presence: 'segment',
    segment: {
      fromStopId,
      toStopId,
      status: 'known',
      mode: 'walk',
      durationMinutes,
      source: { kind: 'routes', label: 'Google Routes' },
      checkedAt: '2026-11-08T11:46:00+09:00',
      explanation: '構造化された移動時間',
    },
  } as const
}

const [morning, , exhibition] = sampleTrip.stops

// サーバーと同じく、依頼の理由と文脈をそのまま写した成立候補を返す。
// 変更前の予定は依頼の旅程から取り、候補の内容（after）と判定は呼び出し側が決める。
const proposeWith =
  (candidate: Stop, status: 'satisfied' | 'unknown' = 'satisfied'): GenerateRevisions =>
  async (request): Promise<RevisionProposal> => {
    const before = request.trip.stops.find((stop) => stop.id === request.targetStopId)
    if (!before) throw new Error('テストデータが不正')
    return {
      status: 'proposed',
      revisions: [
        {
          ...sampleRevision,
          reason: request.reason,
          context: request.context,
          baseTripVersion: request.trip.version,
          diff: { before, after: candidate },
          constraintCheck: { status, explanation: '固定展示に間に合う' },
        },
      ],
      comparisons: [
        {
          revisionId: sampleRevision.id,
          originalPlaceId: before.placeId ?? 'test-original-place',
          before: {
            fromPrevious: leg(morning.id, lunch.id, 10),
            toNext: leg(lunch.id, exhibition.id, 10),
          },
          after: {
            fromPrevious: leg(morning.id, lunch.id, 8),
            toNext: leg(lunch.id, exhibition.id, 6),
          },
        },
      ],
      // サーバーから発行済みの候補であることを示すテスト用トークン。
      proposalTokens: { [sampleRevision.id]: `v2.1794132000000.e30.${'A'.repeat(43)}` },
    }
  }

const propose = proposeWith(after)

// 適用後の旅程。昼食だけが候補に置き換わる。
const savedTrip = (): Trip => {
  const saved = structuredClone({
    ...sampleTrip,
    version: 1,
    stops: sampleTrip.stops.with(1, after),
  })
  saved.stops[1].evidence[0].checkedAt = '2026-11-08T11:47:00+09:00'
  return saved
}

// 予定を差し替えた旅程（版は変えない）。学びの適用先は存在しない予定を指さないよう外す。
const withStops = (stops: Stop[], patch: Partial<Trip> = {}): Trip =>
  TripSchema.parse({ ...sampleTrip, learningApplications: [], ...patch, stops })
const cafe: Stop = {
  ...lunch,
  id: 'stop-cafe',
  name: 'カフェC（架空）',
  plannedStartTime: '13:20',
  durationMinutes: 20,
  evidence: [],
}
// 固定でない予定が昼食とカフェの2件ある旅程。
const fourStopTrip = withStops([morning, lunch, cafe, exhibition])
const transfer: Stop = { ...cafe, id: 'stop-transfer', name: '駅で乗換', kind: 'transport' }
const tripWithTransfer = withStops([morning, lunch, transfer, exhibition])

const openCandidates = async (
  user: User,
  kind: 'actual' | 'simulated',
  preset: RegExp = closedPreset,
) => {
  await goToLunch(user)
  await submitReport(user, kind, preset)
  await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
  await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
  await screen.findByRole('button', { name: '承認して適用を依頼' })
}

const approve = () => screen.getByRole<HTMLButtonElement>('button', { name: '承認して適用を依頼' })
const approvalNote = () => document.getElementById(approve().getAttribute('aria-describedby') ?? '')
const replanButton = () =>
  screen.getByRole('button', { name: '予定が変わった？この予定だけ変更する' })
const currentHeading = () => screen.getByRole('heading', { name: 'いまの予定' })
const reportHeading = () => screen.getByRole('heading', { name: '現地の状況を報告する' })
const currentStop = () => currentHeading().closest('section')?.textContent
// 導線全体の通知欄（先頭のライブリージョン）。子の画面にも別のstatusがあるため、位置で特定する。
const flowNotice = () => {
  const notice = screen.getByRole('region', { name: '旅行中の再計画' }).firstElementChild
  expect(notice?.getAttribute('role')).toBe('status')
  return notice as HTMLElement
}

describe('現地報告から再計画', () => {
  it('非固定の乗換は現在予定でも報告フォームでも対象外にし、通常の予定は候補を探せる', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue({
      status: 'no_candidates',
      message: '候補がありません',
    })
    render(<OnSiteReplanningFlow trip={tripWithTransfer} initialIndex={2} generate={generate} />)

    expect(currentStop()).toContain(transfer.name)
    expect(currentStop()).toContain('乗車・乗換は部分修正の対象外です。')
    expect(currentStop()).not.toContain('固定予定')
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
    expect(generate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'ひとつ前に戻す' }))
    await user.click(replanButton())
    expect(screen.queryByRole('radio', { name: /駅で乗換|朝の庭園|14時の予約展示/ })).toBeNull()
    expect(screen.getByRole('radio', { name: /昼食店A/ })).toBeTruthy()
    expect(screen.getByText('乗車・乗換は部分修正の対象外です。')).toBeTruthy()
    await submitReport(user, 'actual')
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0][0].targetStopId).toBe(lunch.id)
  })

  it('子から対象外のIDが渡されても報告を開始・送信しない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>()
    const progress = vi.spyOn(progressView, 'TripProgressView')
    const form = vi.spyOn(reportForm, 'OnSiteReportForm')
    try {
      render(<OnSiteReplanningFlow trip={tripWithTransfer} initialIndex={1} generate={generate} />)
      const start = progress.mock.lastCall?.[0].onReplan
      if (!start) throw new Error('報告開始のコールバックがありません')
      const invalidIds = [transfer.id, morning.id, 'missing-stop']
      for (const id of invalidIds) {
        act(() => start(id))
        expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
      }

      await user.click(replanButton())
      const submit = form.mock.lastCall?.[0].onSubmit
      if (!submit) throw new Error('報告送信のコールバックがありません')
      for (const id of invalidIds) {
        act(() =>
          submit({
            targetStopId: id,
            reason: '閉店していた',
            context: {
              phase: 'on_site',
              report: {
                kind: 'actual',
                category: 'closed',
                description: '閉店していた',
                targetStopId: id,
              },
            },
          }),
        )
        expect(flowNotice().textContent).toContain('修正できる予定を確認してください')
        expect(screen.queryByRole('button', { name: '変更候補を探す' })).toBeNull()
      }
      expect(generate).not.toHaveBeenCalled()
    } finally {
      form.mockRestore()
      progress.mockRestore()
    }
  })

  it('旅行中に固定でない予定を報告し、on_site文脈で既存の部分修正APIへ渡す', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue({
      status: 'no_candidates',
      message: '候補がありません',
    })
    const original = structuredClone(sampleTrip)
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)

    // 固定予定は選べず、手動進行した昼食から現地報告を開始する。
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
    await goToLunch(user)
    expect(screen.getByText('現地の状況を報告する')).toBeTruthy()

    await submitReport(user, 'actual')
    expect(screen.getByText('現地の報告内容')).toBeTruthy()
    expect(
      (screen.getByRole('textbox', { name: '現地の報告内容' }) as HTMLTextAreaElement).readOnly,
    ).toBe(true)
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    const [request] = generate.mock.calls[0]
    expect(request.targetStopId).toBe('stop-lunch')
    expect(request.context).toEqual({
      phase: 'on_site',
      report: {
        kind: 'actual',
        description: '閉店・臨時休業だった',
        category: 'closed',
        targetStopId: 'stop-lunch',
      },
    })
    expect(request.reason).toContain('閉店・臨時休業だった')
    expect(request.trip.stops.find((stop) => stop.id === 'stop-exhibition')?.isFixed).toBe(true)
    expect(sampleTrip).toEqual(original)

    // 成立する候補がなくても元の旅程を維持し、戻ったときの現在地点は昼食のまま。
    await waitFor(() =>
      expect(screen.getByText(/条件に合う候補が見つかりませんでした/)).toBeTruthy(),
    )
    // 現地報告のときのボタン名は、実際の動作（報告画面へ戻る）を表す。
    expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '報告を見直す' }))
    expect(document.activeElement).toBe(reportHeading())
    await user.click(screen.getByRole('button', { name: '旅行中の画面に戻る' }))
    expect(screen.getByText('旅行中の進行状況')).toBeTruthy()
    expect(currentStop()).toContain('昼食店A（架空）')
    expect(document.activeElement).toBe(currentHeading())
  })

  it('模擬報告の候補は比較できても、承認しても適用サービスを呼ばず旅程を変えない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>(propose)
    const apply = vi.fn<ApplyRevision>()
    const onTripChange = vi.fn()
    const original = structuredClone(sampleTrip)
    render(
      <OnSiteReplanningFlow
        trip={sampleTrip}
        generate={generate}
        apply={apply}
        onTripChange={onTripChange}
      />,
    )
    await goToLunch(user)
    await submitReport(user, 'simulated')
    expect(screen.getByText(/デモ用の想定です。現地で実際に起きたことではありません/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    expect(generate.mock.calls[0][0].context).toEqual({
      phase: 'on_site',
      report: {
        kind: 'simulated',
        description: '閉店・臨時休業だった',
        category: 'closed',
        targetStopId: 'stop-lunch',
      },
    })

    // 候補は成立していても、承認の操作は適用に届かない。理由は「未接続」ではなく模擬報告と伝える。
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(approvalNote()?.textContent).toBe('模擬報告のため適用できません。')
    expect(screen.queryByText(/未接続/)).toBeNull()
    approve().focus()
    await user.keyboard('{Enter}')
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
    expect(onTripChange).not.toHaveBeenCalled()
    expect(sampleTrip).toEqual(original)

    await user.click(screen.getByRole('button', { name: '報告を見直す' }))
    expect(onTripChange).not.toHaveBeenCalled()
  })

  it('実際の報告の承認は、on_site文脈つきで適用し、成功後に旅程を渡して進行画面へ戻る', async () => {
    const user = userEvent.setup()
    const saved = savedTrip()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'applied', trip: saved })
    const onTripChange = vi.fn()
    render(
      <OnSiteReplanningFlow
        trip={sampleTrip}
        generate={propose}
        apply={apply}
        onTripChange={onTripChange}
      />,
    )
    await openCandidates(user, 'actual')

    // 適用できる状態では、適用できない理由を出さない。
    expect(approve().getAttribute('aria-disabled')).toBe('false')
    expect(screen.queryByText(/適用できません|未接続/)).toBeNull()
    await user.click(approve())

    await waitFor(() => expect(onTripChange).toHaveBeenCalledTimes(1))
    expect(apply).toHaveBeenCalledTimes(1)
    const [decision] = apply.mock.calls[0]
    expect(decision.request.context).toEqual({
      phase: 'on_site',
      report: {
        kind: 'actual',
        description: '閉店・臨時休業だった',
        category: 'closed',
        targetStopId: 'stop-lunch',
      },
    })
    expect(decision.request.targetStopId).toBe('stop-lunch')
    expect(decision.request.reason).toContain('閉店・臨時休業だった')
    expect(decision.revision.id).toBe(sampleRevision.id)
    expect(onTripChange).toHaveBeenCalledWith(saved)

    // 進行画面へ戻り、置き換わった予定と通知を示し、フォーカスを「いまの予定」へ移す。
    expect(screen.getByRole('heading', { name: '旅行中の進行状況' })).toBeTruthy()
    expect(currentStop()).toContain(after.name)
    expect(flowNotice().textContent).toContain('承認した1件の変更を旅程に反映しました')
    expect(document.activeElement).toBe(currentHeading())

    // サーバーが適用を確定できたので、再計画を止めない（適用中の「結果不明」の状態は残さない）。
    expect(screen.queryByRole('note')).toBeNull()
    await user.click(replanButton())
    expect(document.activeElement).toBe(reportHeading())
  })

  it('実際の報告でも、適用サービスが無ければ未接続と伝えて承認を送らない', async () => {
    const user = userEvent.setup()
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} />)
    await openCandidates(user, 'actual')
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('承認・適用サービスは未接続です。')).toBeTruthy()
    await user.click(approve())
    expect(screen.queryByText(/旅程に反映しました/)).toBeNull()
  })

  it('現地の報告内容と希望条件を合わせて上限を超えるときは、送らずに短くするよう案内する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>(propose)
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)
    await goToLunch(user)
    await user.click(screen.getByRole('textbox', { name: /補足/ }))
    await user.paste('あ'.repeat(500))
    await submitReport(user, 'actual')

    const preferences = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: '希望条件（任意）',
    })
    await user.click(preferences)
    await user.paste('い'.repeat(500))
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))

    expect(generate).not.toHaveBeenCalled()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('1000文字以内')
    expect(alert.textContent).toContain('希望条件を短く')
    expect(preferences.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(preferences)

    // 短くすれば案内が消え、そのまま送れる。送る理由は上限に収まる。
    await user.clear(preferences)
    expect(screen.queryByRole('alert')).toBeNull()
    await user.paste('い'.repeat(100))
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(generate.mock.calls[0][0].reason.length).toBeLessThanOrEqual(1000)
  })

  it('候補生成サービス未接続時は操作できるかのように見せない', () => {
    render(<OnSiteReplanningFlow trip={sampleTrip} />)
    expect(screen.getByText(/候補生成サービスを接続すると利用できます/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
  })
})

describe('旅程が変わったあとの古い報告・比較は、元の内容に戻っても復活しない', () => {
  it('報告後に同じIDの予定が乗車・乗換に変わったら、古い報告から候補を生成しない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>()
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)
    await goToLunch(user)
    await submitReport(user, 'actual')
    expect(screen.getByRole('button', { name: '変更候補を探す' })).toBeTruthy()

    const updated = {
      ...sampleTrip,
      stops: sampleTrip.stops.with(1, { ...lunch, kind: 'transport' as const }),
    }
    rerender(<OnSiteReplanningFlow trip={updated} generate={generate} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('古い報告からの再計画を中止しました')
    expect(screen.queryByRole('button', { name: '変更候補を探す' })).toBeNull()
    await user.click(within(alert).getByRole('button', { name: '旅行中の画面に戻る' }))
    expect(currentStop()).toContain('乗車・乗換は部分修正の対象外です。')
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
    expect(generate).not.toHaveBeenCalled()
  })

  it('途中で旅程が更新された場合は、古い報告による候補生成を許可しない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>()
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)
    await goToLunch(user)
    await submitReport(user, 'actual')

    const updated: Trip = { ...sampleTrip, version: sampleTrip.version + 1 }
    rerender(<OnSiteReplanningFlow trip={updated} generate={generate} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('古い報告からの再計画を中止しました')
    expect(alert.textContent).not.toContain('適用結果')
    // 比較画面が消えてフォーカスを失わないよう、通知へ移す。
    expect(document.activeElement).toBe(alert)
    expect(screen.queryByRole('button', { name: '変更候補を探す' })).toBeNull()
    expect(generate).not.toHaveBeenCalled()

    // 適用を送っていないので、戻れば通常どおり報告を始められる。
    await user.click(within(alert).getByRole('button', { name: '旅行中の画面に戻る' }))
    expect(document.activeElement).toBe(currentHeading())
    await user.click(replanButton())
    expect(document.activeElement).toBe(reportHeading())
  })

  it('候補を比較中に旅程が v0→v1→v0 と変わっても、一度中止した比較と承認は復活しない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>(propose)
    const apply = vi.fn<ApplyRevision>()
    const props = { generate, apply }
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} {...props} />)
    await openCandidates(user, 'actual')
    expect(approve()).toBeTruthy()

    rerender(<OnSiteReplanningFlow trip={{ ...sampleTrip, version: 1 }} {...props} />)
    expect(screen.getByRole('alert').textContent).toContain('古い報告からの再計画を中止しました')
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()

    // 親の旅程が中身まで元と同じに戻っても、中止した比較・承認の操作は戻らない。
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} {...props} />)
    expect(screen.getByRole('alert').textContent).toContain('古い報告からの再計画を中止しました')
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
    expect(screen.queryByRole('button', { name: '承認して適用を依頼' })).toBeNull()
    expect(screen.queryByRole('button', { name: '変更候補を探す' })).toBeNull()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()

    // 戻れば、新しい報告として最初から始められる（古い入力は引き継がない）。
    await user.click(screen.getByRole('button', { name: '旅行中の画面に戻る' }))
    await user.click(replanButton())
    expect((screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
  })

  it('適用を送った比較が v0→v1→v0 で中止されても、遅れて届いた応答は旅程を置き換えない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const onTripChange = vi.fn()
    const props = { generate: propose, apply, onTripChange }
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} {...props} />)
    await openCandidates(user, 'actual')
    await user.click(approve())

    rerender(<OnSiteReplanningFlow trip={{ ...sampleTrip, version: 1 }} {...props} />)
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} {...props} />)
    await act(async () => pending.resolve({ status: 'applied', trip: savedTrip() }))

    expect(onTripChange).not.toHaveBeenCalled()
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('適用結果を確認できませんでした')
  })

  it('適用後の表示は、親の旅程が一度別の内容になってから元に戻っても復活しない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'applied', trip: savedTrip() })
    const props = { generate: propose, apply }
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} {...props} />)
    await openCandidates(user, 'actual')
    await user.click(approve())
    await waitFor(() => expect(currentStop()).toContain(after.name))

    // 親が適用後の旅程を反映しないまま、別の内容（v5）を渡す。親の旅程に従う。
    rerender(<OnSiteReplanningFlow trip={{ ...sampleTrip, version: 5 }} {...props} />)
    expect(currentStop()).toContain('昼食店A（架空）')
    // 元の内容（v0）に戻っても、以前の適用後の表示（ローカルの旅程）を呼び戻さない。
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} {...props} />)
    expect(currentStop()).toContain('昼食店A（架空）')
    expect(currentStop()).not.toContain(after.name)
  })

  it('適用の応答待ちに、中身が同じで参照だけ違う旅程を渡されても、適用結果を巻き戻さない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const onTripChange = vi.fn()
    const props = { generate: propose, apply, onTripChange }
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} {...props} />)
    await openCandidates(user, 'actual')
    await user.click(approve())

    // 送信後に、親が同じ内容の旅程を別のオブジェクトとして渡し直す（比較は続けられる）。
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} {...props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => pending.resolve({ status: 'applied', trip: savedTrip() }))
    expect(onTripChange).toHaveBeenCalledTimes(1)
    expect(currentStop()).toContain(after.name)

    // 親が旅程の更新を反映しないまま、さらに同じ内容を渡し直されても、適用後の表示を保つ。
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} {...props} />)
    expect(currentStop()).toContain(after.name)
    // 親が適用後の旅程を渡せば、それに従う。
    rerender(<OnSiteReplanningFlow trip={savedTrip()} {...props} />)
    expect(currentStop()).toContain(after.name)
  })
})

describe('適用結果が不明なときは、利用者の操作では再操作を解除しない', () => {
  it('適用の応答が届かないあいだは、承認を重ねて送れず、報告画面にも戻れない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(new Promise(() => {}))
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} apply={apply} />)
    await openCandidates(user, 'actual')
    await user.click(approve())

    // 応答が失われたまま。承認を押し直しても、適用は1回しか送られない。
    const waiting = screen.getByRole<HTMLButtonElement>('button', { name: '適用を確認中…' })
    await user.click(waiting)
    await user.click(waiting)
    expect(apply).toHaveBeenCalledTimes(1)
    // 画面を離れて別の操作へ進む手段も、確認が終わるまでは無効。
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '報告を見直す' }).disabled).toBe(
      true,
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '条件を見直す' }).disabled).toBe(
      true,
    )
  })

  it('応答が失われたまま親が旅程を差し替えたら、結果不明として再計画を止め、確認する操作を出さない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const generate = vi.fn<GenerateRevisions>(propose)
    const onTripChange = vi.fn()
    const props = { generate, apply, onTripChange }
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} {...props} />)
    await openCandidates(user, 'actual')
    await user.click(approve())
    expect(apply).toHaveBeenCalledTimes(1)

    // 送信済みの適用をサーバーが反映した可能性があるまま、親が旅程を差し替える。
    rerender(<OnSiteReplanningFlow trip={{ ...sampleTrip, version: 1 }} {...props} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('適用結果を確認できませんでした')
    expect(alert.textContent).toContain('この画面からは再操作できません')
    expect(alert.textContent).not.toContain('古い報告からの再計画を中止しました')
    expect(document.activeElement).toBe(alert)

    // 戻っても結果不明の状態を消さない。確認できるまで再計画を停止していることを、静的に案内する。
    await user.click(within(alert).getByRole('button', { name: '旅行中の画面に戻る' }))
    const unresolved = screen.getByRole('note')
    expect(unresolved.textContent).toContain('この画面からは再操作できません')
    expect(unresolved.textContent).toContain('再計画を停止しています')
    // 取得し直す手段（再読み込み）と、再読み込みで失われるものを、正直に伝える。
    expect(unresolved.textContent).toContain('ページを再読み込み')
    expect(unresolved.textContent).toContain('失われます')
    expect(document.activeElement).toBe(unresolved)
    expect(flowNotice().textContent).toContain('適用結果を確認できませんでした')
    // 利用者のボタン操作だけで解除できる手段（旧「最新の旅程を確認した」）は存在しない。
    expect(within(unresolved).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /確認した/ })).toBeNull()

    // 報告は始められない。ボタンは押せて、理由を伝えて案内の欄へ戻す。
    await user.click(replanButton())
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
    const firstNotice = screen.getByText(/再計画を停止しています。適用結果を確認できていない/, {
      selector: 'span',
    })
    expect(document.activeElement).toBe(unresolved)
    // 同じ文言が続いても、通知の要素を作り直して読み上げ直させる。
    await user.click(replanButton())
    const secondNotice = screen.getByText(/再計画を停止しています。適用結果を確認できていない/, {
      selector: 'span',
    })
    expect(secondNotice).not.toBe(firstNotice)

    // 遅れて届いた応答は、旅程を置き換えない。止めた状態もそのまま。
    await act(async () => pending.resolve({ status: 'applied', trip: savedTrip() }))
    expect(onTripChange).not.toHaveBeenCalled()
    expect(currentStop()).toContain('昼食店A（架空）')
    expect(screen.getByRole('note')).toBeTruthy()

    // 親が旅程をさらに更新しても、元の内容に戻しても、画面の操作では解除されない。
    rerender(<OnSiteReplanningFlow trip={{ ...sampleTrip, version: 2 }} {...props} />)
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} {...props} />)
    expect(screen.getByRole('note')).toBeTruthy()
    await user.click(replanButton())
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('適用の応答が失われた（通信エラー）後に比較画面から戻っても、不明の状態を保ち、解除する操作を出さない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockRejectedValue(new Error('通信が切れた'))
    const generate = vi.fn<GenerateRevisions>(propose)
    const { rerender } = render(
      <OnSiteReplanningFlow trip={sampleTrip} generate={generate} apply={apply} />,
    )
    await openCandidates(user, 'actual')
    await user.click(approve())
    await user.click(await screen.findByRole('button', { name: '旅程を確認' }))

    const unresolved = screen.getByRole('note')
    expect(unresolved.textContent).toContain('この画面からは再操作できません')
    expect(document.activeElement).toBe(unresolved)
    expect(within(unresolved).queryAllByRole('button')).toHaveLength(0)
    await user.click(replanButton())
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()

    // 親が別の旅程を渡しても、サーバーで確認できたことにはならない。
    rerender(
      <OnSiteReplanningFlow
        trip={{ ...sampleTrip, version: 3 }}
        generate={generate}
        apply={apply}
      />,
    )
    expect(screen.getByRole('note')).toBeTruthy()
    await user.click(replanButton())
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('サーバーが適用を確定して失敗と返した場合は、止めずに報告をやり直せる', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'failed' })
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} apply={apply} />)
    await openCandidates(user, 'actual')
    await user.click(approve())
    await screen.findByText(/候補を適用できませんでした/)
    await user.click(screen.getByRole('button', { name: '報告を見直す' }))
    await user.click(screen.getByRole('button', { name: '旅行中の画面に戻る' }))
    expect(screen.queryByRole('note')).toBeNull()
    await user.click(replanButton())
    expect(document.activeElement).toBe(reportHeading())
  })

  it('ページを読み込み直した（新しく表示した）画面では、止めた状態は引き継がれない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockRejectedValue(new Error('通信が切れた'))
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} apply={apply} />)
    await openCandidates(user, 'actual')
    await user.click(approve())
    await user.click(await screen.findByRole('button', { name: '旅程を確認' }))
    expect(screen.getByRole('note')).toBeTruthy()

    cleanup()
    render(<OnSiteReplanningFlow trip={savedTrip()} generate={propose} apply={apply} />)
    expect(screen.queryByRole('note')).toBeNull()
    await goToLunch(user)
    expect(reportHeading()).toBeTruthy()
  })
})

describe('報告の入力中に対象の予定が変わった場合', () => {
  const fixedLunch = withStops([morning, { ...lunch, isFixed: true }, cafe, exhibition])
  const deletedLunch = withStops([morning, cafe, exhibition])
  const swappedLunch = withStops([
    morning,
    { ...lunch, name: '別の昼食店（架空）', placeId: 'place-other' },
    cafe,
    exhibition,
  ])

  it.each([
    ['固定された', fixedLunch],
    ['削除された', deletedLunch],
    ['同じIDのまま別の施設に差し替えられた', swappedLunch],
  ])(
    '対象が%s（版は同じ）とき、残った予定へ報告を引き継がず、対象と内容の再確認を求める',
    async (_, changed) => {
      const user = userEvent.setup()
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue({
        status: 'no_candidates',
        message: '候補がありません',
      })
      const { rerender } = render(<OnSiteReplanningFlow trip={fourStopTrip} generate={generate} />)
      await goToLunch(user)
      await user.type(screen.getByRole('textbox', { name: /補足/ }), '貼り紙があった')
      await user.click(screen.getByRole('radio', { name: closedPreset }))
      await user.click(screen.getByRole('radio', { name: /いまの現地の状況（実際の報告）/ }))
      expect(changed.version).toBe(fourStopTrip.version)

      rerender(<OnSiteReplanningFlow trip={changed} generate={generate} />)

      // 入力は残さず、どの項目も選ばれていない（残った予定が自動で選ばれることもない）。
      expect((screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement).value).toBe('')
      expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(0)
      expect(flowNotice().textContent).toContain('旅程が更新されたため入力をリセットしました')
      expect(flowNotice().textContent).toContain('対象の予定を選び直し')
      // 入力欄を作り直しても、キーボードのフォーカスを失わない。
      expect(document.activeElement).toBe(reportHeading())

      // 対象を選ばないまま送ろうとしても、別の予定への報告にはならない。
      await user.click(screen.getByRole('radio', { name: closedPreset }))
      await user.click(screen.getByRole('radio', { name: /いまの現地の状況（実際の報告）/ }))
      await user.click(screen.getByRole('button', { name: '実際の報告で候補検索へ' }))
      expect(screen.getByText(/どの予定の状況かを選んでください/)).toBeTruthy()
      expect(screen.queryByRole('button', { name: '変更候補を探す' })).toBeNull()
      expect(generate).not.toHaveBeenCalled()

      // 利用者が対象を選び直せば、その予定として進められる。
      await user.click(screen.getByRole('radio', { name: /カフェC（架空）/ }))
      await user.click(screen.getByRole('button', { name: '実際の報告で候補検索へ' }))
      await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
      expect(generate.mock.calls[0][0].targetStopId).toBe('stop-cafe')
    },
  )

  it('旅程の版が変わったときも、入力をリセットしたことを知らせ、フォーカスを見出しへ移す', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} />)
    await goToLunch(user)
    await user.type(screen.getByRole('textbox', { name: /補足/ }), '貼り紙があった')
    expect((screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement).value).toBe(
      '貼り紙があった',
    )

    rerender(<OnSiteReplanningFlow trip={{ ...sampleTrip, version: 1 }} generate={propose} />)
    expect((screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement).value).toBe('')
    expect(
      screen.getByText(/旅程が更新されたため入力をリセットしました。/).closest('[role="status"]'),
    ).toBeTruthy()
    expect(document.activeElement).toBe(reportHeading())
  })

  it('旅程が v0→v1→v0 と変わっても、入力は復活せず、リセットしたままになる', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} />)
    await goToLunch(user)
    await user.type(screen.getByRole('textbox', { name: /補足/ }), '貼り紙があった')

    rerender(<OnSiteReplanningFlow trip={{ ...sampleTrip, version: 1 }} generate={propose} />)
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} generate={propose} />)
    expect((screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(0)
    expect(document.activeElement).toBe(reportHeading())
  })

  it('中身が同じで参照だけ違う旅程を渡されただけなら、入力中の内容を消さない', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<OnSiteReplanningFlow trip={fourStopTrip} generate={propose} />)
    await goToLunch(user)
    await user.type(screen.getByRole('textbox', { name: /補足/ }), '貼り紙があった')

    rerender(<OnSiteReplanningFlow trip={structuredClone(fourStopTrip)} generate={propose} />)
    expect((screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement).value).toBe(
      '貼り紙があった',
    )
    expect(screen.queryByText(/入力をリセットしました/)).toBeNull()
  })
})

describe('現地報告の候補は、暫定ガードで承認可能の判定を下げる方向にだけ働く', () => {
  const lunchWithPlace: Stop = { ...lunch, placeId: 'place-lunch-a' }
  const tripWithPlace = withStops([morning, lunchWithPlace, exhibition])
  const userReport = (status: Evidence['status']): Evidence => ({
    ...after.evidence[0],
    id: `user-report-${status}`,
    subject: 'opening_hours',
    source: { kind: 'user_report', label: '本人の現地報告' },
    status,
    explanation: '現地で利用者が見たこと',
  })

  it('休業した施設と同じPlace IDの候補は、名称が違っても承認できず、理由を承認欄に示す', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>()
    render(
      <OnSiteReplanningFlow
        trip={tripWithPlace}
        generate={proposeWith({ ...after, placeId: lunchWithPlace.placeId })}
        apply={apply}
      />,
    )
    await openCandidates(user, 'actual')

    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(approvalNote()?.textContent).toContain('休業と報告された')
    expect(approvalNote()?.textContent).toContain('同じPlace ID')
    expect(screen.queryByText(/予定に間に合う見込みです/)).toBeNull()
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
  })

  it('Place IDが違う候補は、同じ報告でも承認できる（ガードで過剰に止めない）', async () => {
    const user = userEvent.setup()
    render(
      <OnSiteReplanningFlow
        trip={tripWithPlace}
        generate={propose}
        apply={vi.fn<ApplyRevision>()}
      />,
    )
    await openCandidates(user, 'actual')
    expect(approve().getAttribute('aria-disabled')).toBe('false')
    expect(screen.getByText(/予定に間に合う見込みです/)).toBeTruthy()
  })

  it('本人の現地報告と矛盾する根拠が残る候補は、ほかの根拠が整合していても承認できない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>()
    render(
      <OnSiteReplanningFlow
        trip={sampleTrip}
        generate={proposeWith({
          ...after,
          evidence: [...after.evidence, userReport('conflicting')],
        })}
        apply={apply}
      />,
    )
    await openCandidates(user, 'actual')

    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(approvalNote()?.textContent).toContain('現地報告と矛盾する根拠')
    expect(screen.queryByText(/予定に間に合う見込みです/)).toBeNull()
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
  })

  it('矛盾していない現地報告の根拠が付いた候補は、そのまま承認できる', async () => {
    const user = userEvent.setup()
    render(
      <OnSiteReplanningFlow
        trip={sampleTrip}
        generate={proposeWith({
          ...after,
          evidence: [...after.evidence, userReport('consistent')],
        })}
        apply={vi.fn<ApplyRevision>()}
      />,
    )
    await openCandidates(user, 'actual')
    expect(approve().getAttribute('aria-disabled')).toBe('false')
  })

  it('遅れの報告では、元の時刻表だけを根拠に「間に合う見込み」と断定せず、未確認として理由を示す', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>()
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} apply={apply} />)
    await openCandidates(user, 'actual', delayedPreset)

    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByText(/予定に間に合う見込みです/)).toBeNull()
    expect(screen.queryByText('予定に収まる')).toBeNull()
    expect(screen.getAllByText('確認が必要').length).toBeGreaterThan(0)
    expect(approvalNote()?.textContent).toContain('遅れの報告')
    expect(approvalNote()?.textContent).toContain('評価できていない')
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
  })

  it('遅れ以外の報告（休業）では、同じ候補を「間に合う見込み」と示して承認できる', async () => {
    const user = userEvent.setup()
    render(
      <OnSiteReplanningFlow trip={sampleTrip} generate={propose} apply={vi.fn<ApplyRevision>()} />,
    )
    await openCandidates(user, 'actual', closedPreset)
    expect(screen.getByText(/14:00の予定に間に合う見込みです/)).toBeTruthy()
    expect(approve().getAttribute('aria-disabled')).toBe('false')
  })

  it('模擬報告でもガードは同じ。承認の操作は適用に届かず、理由は模擬ではなくガードの内容を示す', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>()
    render(
      <OnSiteReplanningFlow
        trip={tripWithPlace}
        generate={proposeWith({ ...after, placeId: lunchWithPlace.placeId })}
        apply={apply}
      />,
    )
    await openCandidates(user, 'simulated')
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(approvalNote()?.textContent).toContain('同じPlace ID')
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
  })

  it('もともと承認できない（未確認）候補は、ガードに当たっても承認できる状態にならない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>()
    render(
      <OnSiteReplanningFlow
        trip={sampleTrip}
        generate={proposeWith({ ...after, evidence: [] }, 'unknown')}
        apply={apply}
      />,
    )
    await openCandidates(user, 'actual', delayedPreset)
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('候補生成サービスが一時的に利用できなくなった場合', () => {
  it('サービスが外れた描画の直後でも、古い比較から適用を開始しない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'failed' })
    function Flow({ available }: { available: boolean }) {
      useLayoutEffect(() => {
        if (!available)
          screen.getByRole<HTMLButtonElement>('button', { name: '承認して適用を依頼' }).click()
      }, [available])
      return (
        <OnSiteReplanningFlow
          trip={sampleTrip}
          generate={available ? propose : undefined}
          apply={apply}
        />
      )
    }
    const { rerender } = render(<Flow available />)
    await openCandidates(user, 'actual')

    rerender(<Flow available={false} />)

    expect(apply).not.toHaveBeenCalled()
    rerender(<Flow available />)
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
  })

  it('適用の応答待ちにサービスが外れて戻っても、適用中状態を保ち二重送信しない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const onTripChange = vi.fn()
    const props = { apply, onTripChange }
    const { rerender } = render(
      <OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />,
    )
    await openCandidates(user, 'actual')
    await user.click(approve())
    expect(
      screen.getByRole('button', { name: '適用を確認中…' }).getAttribute('aria-disabled'),
    ).toBe('true')

    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={undefined} {...props} />)
    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />)

    const waiting = screen.getByRole<HTMLButtonElement>('button', { name: '適用を確認中…' })
    expect(waiting.getAttribute('aria-disabled')).toBe('true')
    await user.click(waiting)
    expect(apply).toHaveBeenCalledTimes(1)

    await act(async () => pending.resolve({ status: 'applied', trip: savedTrip() }))
    expect(onTripChange).toHaveBeenCalledTimes(1)
  })

  it('適用結果不明の後にサービスが外れて戻っても、候補と再操作禁止を維持する', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockRejectedValue(new Error('通信が切れた'))
    const props = { apply }
    const { rerender } = render(
      <OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />,
    )
    await openCandidates(user, 'actual')
    await user.click(approve())
    await screen.findByText('適用結果未確認')

    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={undefined} {...props} />)
    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />)

    expect(screen.getByText('詳細な比較・根拠を見る')).toBeTruthy()
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    await user.click(approve())
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('サービスが外れている間に結果不明の応答が届いても、戻った後に再送できない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const props = { apply }
    const { rerender } = render(
      <OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />,
    )
    await openCandidates(user, 'actual')
    await user.click(approve())

    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={undefined} {...props} />)
    await act(async () => pending.resolve({ status: 'uncertain' }))
    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />)

    expect(screen.getByText('詳細な比較・根拠を見る')).toBeTruthy()
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    await user.click(approve())
    expect(apply).toHaveBeenCalledTimes(1)
    // 結果不明は、進行画面へ戻っても再計画を再開できない。
    await user.click(screen.getByRole('button', { name: '旅程を確認' }))
    await user.click(replanButton())
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
  })

  it('サービスが外れている間に適用成功の応答が届いた場合は、その結果を反映する', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const onTripChange = vi.fn()
    const props = { apply, onTripChange }
    const { rerender } = render(
      <OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />,
    )
    await openCandidates(user, 'actual')
    await user.click(approve())

    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={undefined} {...props} />)
    await act(async () => pending.resolve({ status: 'applied', trip: savedTrip() }))

    expect(onTripChange).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
  })

  it('サービスが外れている間に明確な失敗が届いたら、戻った後に新しい比較で再操作できる', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const props = { apply }
    const { rerender } = render(
      <OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />,
    )
    await openCandidates(user, 'actual')
    await user.click(approve())

    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={undefined} {...props} />)
    await act(async () => pending.resolve({ status: 'failed' }))
    rerender(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} {...props} />)

    expect(screen.queryByRole('note')).toBeNull()
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
