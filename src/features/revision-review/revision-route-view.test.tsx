// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision } from '@/domain/samples'
import { sampleRouteMeta as meta, sampleRouteTrip as trip } from '@/features/trip-map/sample'

import {
  requestRevisions,
  type ApplyRevision,
  type GenerateRevisions,
  type RevisionProposal,
} from './api-client'
import {
  RevisionRouteView,
  type LoadAppliedRevision,
  type LoadLatestTrip,
} from './revision-route-view'

// 保護APIのヘッダー（Bearer＋App Check）はモックし、送信までの経路は実物を通す。
vi.mock('@/lib/auth/protected-api', () => ({
  getProtectedApiHeaders: async () =>
    new Headers({ Authorization: 'Bearer test.id.token', 'X-Firebase-AppCheck': 'test.app.check' }),
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// 実適用を試すテストはすべて本人UIDに紐付くブラウザ状態を使う。
const RevisionRouteTest = (props: ComponentProps<typeof RevisionRouteView>) => (
  <RevisionRouteView ownerUid="test-owner" {...props} />
)

const target = trip.stops[1]
const after = {
  ...sampleRevision.diff.after,
  placeId: 'test-place',
  evidence: (['place_identity', 'opening_hours'] as const).map((subject) => ({
    ...sampleRevision.diff.after.evidence[0],
    id: `test-${subject}`,
    subject,
    source: { kind: 'places' as const, label: 'Google Places' },
    status: 'consistent' as const,
    explanation: '説明文にだけ含まれる例示値：徒歩999分',
  })),
}
// サーバーは依頼の理由と文脈をそのままRevisionへ写す。画面の入力（店が休み・旅行前）と揃えておく。
const first = {
  ...sampleRevision,
  reason: '店が休み',
  context: { phase: 'planning' },
  diff: { before: target, after },
  constraintCheck: { status: 'satisfied', explanation: '固定展示に間に合う' },
} satisfies RevisionProposal['revisions'][number]
const second = {
  ...first,
  id: 'candidate-b',
  diff: { before: target, after: { ...after, name: '別の食堂', evidence: [] } },
  constraintCheck: { status: 'unknown', explanation: '営業時間を確認できませんでした。' },
} satisfies RevisionProposal['revisions'][number]

function routes(minutes: number): RevisionProposal['comparisons'] {
  return [
    {
      revisionId: first.id,
      originalPlaceId: 'test-original-place',
      before: {
        fromPrevious: leg(trip.stops[0].id, target.id, 10),
        toNext: leg(target.id, trip.stops[2].id, 10),
      },
      after: {
        fromPrevious: leg(trip.stops[0].id, target.id, minutes),
        toNext: leg(target.id, trip.stops[2].id, 6),
      },
    },
  ]
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
      explanation: '説明に含まれる移動時間の例：999分',
    },
  } as const
}

const proposal: RevisionProposal = {
  status: 'proposed',
  revisions: [first, second],
  comparisons: routes(8),
  proposalTokens: { [first.id]: `v2.1794132000000.e30.${'A'.repeat(43)}` },
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /昼食店A/ }))
  await user.click(screen.getByRole('button', { name: 'この予定だけ変更' }))
}
const request = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
  await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
}
const route = () => within(screen.getByRole('list', { name: '旅程の路線図' }))
const approve = () => screen.getByRole<HTMLButtonElement>('button', { name: '承認して適用を依頼' })
const approvalDisabled = () => approve().getAttribute('aria-disabled') === 'true'
const tableInConfirmation = () => within(screen.getByRole('table', { hidden: true }))

describe('部分修正の候補比較', () => {
  it('チケットの比較ボタンから開き、食事の希望を既存の修正理由として送る', async () => {
    const user = userEvent.setup()
    const generate = vi
      .fn<GenerateRevisions>()
      .mockResolvedValue({ status: 'no_candidates', message: '候補がありません' })
    render(<RevisionRouteTest trip={trip} meta={meta} generate={generate} />)

    await user.click(screen.getByRole('button', { name: 'この予定だけ変更して比較' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.type(screen.getByLabelText('修正理由（必須）'), '店内が静かな場所がよい')
    await user.type(screen.getByLabelText('希望条件（任意）'), '温かい麺')
    await user.click(screen.getByRole('button', { name: /^早い/ }))
    expect(screen.getByLabelText<HTMLTextAreaElement>('修正理由（任意）').value).toBe(
      '店内が静かな場所がよい',
    )
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetStopId: target.id,
        reason: '移動時間を短くしたい\n店内が静かな場所がよい\n希望条件：温かい麺',
      }),
      expect.any(AbortSignal),
    )
  })

  it('おまかせのボタンは理由の手入力なしで既存の候補生成へ進む', async () => {
    const user = userEvent.setup()
    const generate = vi
      .fn<GenerateRevisions>()
      .mockResolvedValue({ status: 'no_candidates', message: '候補がありません' })
    render(<RevisionRouteTest trip={trip} meta={meta} generate={generate} />)

    await open(user)
    await user.click(screen.getByRole('button', { name: 'こだわらない（おまかせで探す）' }))

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ targetStopId: target.id, reason: 'おまかせで別の場所を探したい' }),
      expect.any(AbortSignal),
    )
  })

  it('非固定の乗車・乗換は旅行前の部分修正の対象外にする', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>()
    const transfer = { ...target, name: '駅で乗換', kind: 'transport' as const, isFixed: false }
    render(
      <RevisionRouteTest
        trip={{ ...trip, stops: trip.stops.with(1, transfer) }}
        generate={generate}
      />,
    )

    await user.click(screen.getByRole('button', { name: /駅で乗換/ }))
    const sheet = within(screen.getByRole('dialog'))
    expect(sheet.getByText('乗車・乗換は部分修正の対象外です。')).toBeTruthy()
    expect(sheet.queryByRole('button', { name: 'この予定だけ変更' })).toBeNull()
    expect(generate).not.toHaveBeenCalled()
  })

  it('選択したStopだけを徒歩で生成し、分岐、固定予定、構造化比較を切り替える', async () => {
    const user = userEvent.setup()
    // 希望条件を足すと理由が変わるため、応答も送られた理由に合わせる。
    const generate = vi.fn<GenerateRevisions>(async ({ reason }) => ({
      ...proposal,
      revisions: proposal.revisions.map((revision) => ({ ...revision, reason })),
    }))
    const apply = vi.fn<ApplyRevision>()
    const original = structuredClone(trip)
    render(<RevisionRouteTest trip={trip} meta={meta} generate={generate} apply={apply} />)

    await open(user)
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    expect(screen.getByRole('alert').textContent).toContain('修正理由を入力')
    expect(generate).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('希望条件（任意）'), '静かな店')
    await request(user)
    expect(generate).toHaveBeenCalledWith(
      {
        trip,
        targetStopId: target.id,
        reason: '店が休み\n希望条件：静かな店',
        context: { phase: 'planning' },
        travelModes: ['walk'],
      },
      expect.any(AbortSignal),
    )
    expect(screen.queryByRole('button', { name: '承認して適用を依頼' })).toBeNull()
    expect(screen.getByRole('button', { name: /候補 A .*承認可能/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /候補 B .*承認不可/ })).toBeTruthy()
    expect(
      route().getByText(after.name).closest('[data-variant]')?.getAttribute('data-variant'),
    ).toBe('ticket')
    expect(route().getByText(target.name)).toBeTruthy()
    expect(route().getByText('この先は元の旅程に合流')).toBeTruthy()
    expect(
      route().getByText(trip.stops[2].name).closest('[data-variant]')?.querySelector('svg'),
    ).toBeTruthy()
    expect(route().getByText('変更は未適用')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    const disclosure = screen.getByText('詳細な比較・根拠を見る')
    expect(disclosure.closest('details')?.open).toBe(false)
    const beforeApproval = (element: HTMLElement) =>
      element.compareDocumentPosition(approve()) & Node.DOCUMENT_POSITION_FOLLOWING
    const summary = screen.getByRole('region', { name: '予定への影響' })
    expect(beforeApproval(summary)).toBeTruthy()
    expect(beforeApproval(screen.getByRole('heading', { name: '変更されるもの' }))).toBeTruthy()
    expect(beforeApproval(disclosure)).toBeTruthy()
    expect(within(summary).getByText('予定に収まる')).toBeTruthy()
    expect(within(summary).getByText(/出典：Google Places/)).toBeTruthy()
    expect(within(summary).getAllByText('Google Routes')).toHaveLength(2)
    await user.click(disclosure)
    expect(disclosure.closest('details')?.open).toBe(true)
    const table = within(await screen.findByRole('table'))
    const scope = () => within(screen.getByRole('region', { name: '予定への影響' }))
    expect(scope().getByText(/営業時間：情報源と整合（照合/)).toBeTruthy()
    expect(
      scope().getByText(
        (_text, element) =>
          element?.tagName === 'LI' &&
          Boolean(element.textContent?.includes('前の予定から：')) &&
          Boolean(element.textContent?.includes('徒歩8分')),
      ),
    ).toBeTruthy()
    expect(scope().getByText(/臨時休業・渋滞・遅延は確認の対象外/)).toBeTruthy()
    expect(table.getByText('徒歩8分')).toBeTruthy()
    expect(table.getByText('2分短い')).toBeTruthy()
    expect(table.getByText('4分短い')).toBeTruthy()
    expect(
      screen.getByText(`${trip.stops[2].plannedStartTime}の予定に間に合う見込みです。`),
    ).toBeTruthy()
    expect(table.queryByText(/999分/)).toBeNull()
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain('矛盾あり')
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain(
      '情報源と整合',
    )
    expect(approvalDisabled()).toBe(false)

    await user.click(screen.getByRole('button', { name: '候補の選択へ戻る' }))
    await user.click(screen.getByRole('button', { name: /候補 B/ }))
    expect(route().getByText('別の食堂')).toBeTruthy()
    expect(route().queryByText(after.name)).toBeNull()
    await user.click(screen.getByRole('button', { name: '変更内容を確認する' }))
    expect(screen.getByText('詳細な比較・根拠を見る').closest('details')?.open).toBe(false)
    expect(beforeApproval(scope().getByText('営業時間：未確認'))).toBeTruthy()
    expect(
      scope()
        .getAllByRole('listitem')
        .filter((item) => item.textContent?.includes('移動時間は未取得')),
    ).toHaveLength(2)
    await user.click(screen.getByText('詳細な比較・根拠を見る'))
    expect(within(screen.getByRole('table')).getAllByText('移動時間は未取得')).toHaveLength(4)
    expect(within(screen.getByRole('table')).getAllByText('時間差：未確認')).toHaveLength(2)
    expect(scope().getByText('営業時間：未確認')).toBeTruthy()
    expect(screen.queryByText(/間に合う見込みです/)).toBeNull()
    expect(screen.getByText('営業時間を確認できませんでした。')).toBeTruthy()
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain('未照合')
    expect(approvalDisabled()).toBe(true)
    approve().focus()
    expect(
      document.getElementById(approve().getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('営業時間を確認できませんでした。')
    await user.keyboard('{Enter}')
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
    expect(trip).toEqual(original)

    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(route().queryByText('別の食堂')).toBeNull()
    expect(document.activeElement?.id).toBe('stop-button-stop-lunch')
    expect(trip).toEqual(original)
  })

  it('全候補に共通する乗車・乗換の制約を候補選択時に示し、条件の再入力に誘導しない', async () => {
    const user = userEvent.setup()
    const transport = { ...trip.stops[2], kind: 'transport' as const, name: '固定の乗換予定' }
    const itinerary = { ...trip, stops: trip.stops.with(2, transport) }
    const originalComparison = routes(8)?.[0]
    if (!originalComparison) throw new Error('比較のテストデータがありません')
    const missingLeg = {
      presence: 'segment',
      segment: {
        fromStopId: target.id,
        toStopId: transport.id,
        status: 'unknown',
        reason: 'not_queried',
        mode: 'walk',
        explanation: '隣接地点を経路の端点として照会できません。',
      },
    } as const
    const generate: GenerateRevisions = async () => ({
      ...proposal,
      revisions: proposal.revisions.map((revision) => ({
        ...revision,
        constraintCheck: {
          status: 'unknown',
          explanation: '次の予定への移動を確認できていません。',
        },
      })),
      comparisons: proposal.revisions.map(({ id }) => ({
        ...originalComparison,
        revisionId: id,
        routeEndpoints: { previousPlaceId: 'garden', nextPlaceId: null },
        before: { ...originalComparison.before, toNext: missingLeg },
        after: { ...originalComparison.after, toNext: missingLeg },
      })),
    })
    const apply = vi.fn<ApplyRevision>()
    render(<RevisionRouteTest trip={itinerary} generate={generate} apply={apply} />)
    await open(user)
    expect(screen.getByText(/開始時刻と滞在時間を維持/)).toBeTruthy()
    await request(user)
    expect(await screen.findByText('承認できる候補はありません ／ 承認不可 2件')).toBeTruthy()
    const overview = within(screen.getByRole('region', { name: '選択中の候補の概要' }))
    expect(overview.getByText(/固定の乗換予定.*経路の端点として照合できません/)).toBeTruthy()
    expect(overview.getByText(/候補を切り替えるだけでは解消しません/)).toBeTruthy()
    expect(overview.getByText(/元の旅程に戻り、対象や前後の予定を確認/)).toBeTruthy()
    expect(overview.getByText(/移動を確認できていません/)).toBeTruthy()
    expect(overview.getByText('徒歩・未確認（未照会）')).toBeTruthy()
    expect(overview.queryByRole('button', { name: '条件を見直す' })).toBeNull()
    expect(apply).not.toHaveBeenCalled()
    await user.click(overview.getByRole('button', { name: '変更内容を確認する' }))
    expect(approvalDisabled()).toBe(true)
    expect(screen.queryByRole('button', { name: '条件を見直す' })).toBeNull()
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    '隣接施設の通信失敗（%s）と未同定で異なる案内を表示する',
    async (failed) => {
      const user = userEvent.setup()
      const comparison = routes(8)?.[0]
      if (!comparison) throw new Error('比較のテストデータがありません')
      const missingLeg = {
        presence: 'segment',
        segment: {
          fromStopId: target.id,
          toStopId: trip.stops[2].id,
          status: 'unknown',
          reason: 'not_queried',
          mode: 'walk',
          explanation: '隣接地点を経路の端点として照会できません。',
        },
      } as const
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue({
        ...proposal,
        revisions: [
          {
            ...first,
            constraintCheck: {
              status: 'unknown',
              explanation: failed
                ? '次の予定の施設検索に失敗しました。時間をおいて、もう一度お試しください。'
                : '次の予定への移動を確認できませんでした。',
            },
          },
        ],
        comparisons: [
          {
            ...comparison,
            routeEndpoints: { previousPlaceId: 'garden', nextPlaceId: null },
            ...(failed ? { failedPlaceLookups: ['next' as const] } : {}),
            before: { ...comparison.before, toNext: missingLeg },
            after: { ...comparison.after, toNext: missingLeg },
          },
        ],
      })
      const apply = vi.fn<ApplyRevision>()
      render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)
      await open(user)
      await request(user)
      const overview = within(await screen.findByRole('region', { name: '選択中の候補の概要' }))
      const retry = '条件に戻って再試行'
      if (failed) {
        expect(overview.getByText(/施設検索に失敗しました/)).toBeTruthy()
        expect(overview.queryByText(/予定の施設名を確認/)).toBeNull()
        expect(overview.getByRole('button', { name: retry })).toBeTruthy()
      } else {
        expect(overview.getByText(/予定の施設名を確認/)).toBeTruthy()
        expect(overview.queryByRole('button', { name: retry })).toBeNull()
      }
      await user.click(overview.getByRole('button', { name: '変更内容を確認する' }))
      expect(approvalDisabled()).toBe(true)
      await user.click(approve())
      expect(apply).not.toHaveBeenCalled()
      if (failed) {
        await user.click(screen.getByRole('button', { name: retry }))
        expect(screen.getByLabelText<HTMLTextAreaElement>('修正理由（必須）').value).toBe(
          '店が休み',
        )
        expect(generate).toHaveBeenCalledTimes(1)
      }
    },
  )

  it('修正理由と希望条件を合わせて保存契約の上限を超えるときは、送らずに案内する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    render(<RevisionRouteTest trip={trip} generate={generate} />)
    await open(user)
    const reasonField = screen.getByLabelText('修正理由（必須）')
    const preferences = screen.getByLabelText('希望条件（任意）')
    await user.click(reasonField)
    await user.paste('あ'.repeat(500))
    await user.click(preferences)
    await user.paste('い'.repeat(500))
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))

    expect(generate).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('1000文字以内')
    expect(document.activeElement).toBe(preferences)
    // 上限ちょうど（理由500＋改行1＋「希望条件：」5＋希望条件494）は送れる。
    await user.clear(preferences)
    await user.paste('い'.repeat(494))
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0][0].reason).toHaveLength(1000)
  })

  it('移動手段や照合時刻が異なる区間は、所要時間を表示しても時間差を算出しない', async () => {
    const user = userEvent.setup()
    const modified = structuredClone(proposal)
    const comparison = modified.comparisons?.[0]
    const inbound = comparison?.after.fromPrevious
    const outbound = comparison?.after.toNext
    if (inbound?.presence === 'segment' && inbound.segment.status === 'known') {
      inbound.segment.mode = 'drive'
    }
    if (outbound?.presence === 'segment' && outbound.segment.status === 'known') {
      outbound.segment.checkedAt = '2026-11-08T11:47:00+09:00'
    }
    render(<RevisionRouteTest trip={trip} generate={async () => modified} />)
    await open(user)
    await user.click(screen.getByRole('checkbox', { name: /車を利用できる/ }))
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    const table = within(await screen.findByRole('table'))
    expect(table.getByText('車8分')).toBeTruthy()
    expect(table.getByText('徒歩6分')).toBeTruthy()
    expect(table.getAllByText('時間差：未確認')).toHaveLength(2)
  })

  it('固定予定の修正を防ぎ、明示したときだけ車を送信する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    render(<RevisionRouteTest trip={trip} meta={meta} generate={generate} />)
    await user.click(screen.getByRole('button', { name: /14時の予約展示/ }))
    const sheet = within(screen.getByRole('dialog'))
    expect(
      sheet.getByRole<HTMLButtonElement>('button', { name: '固定中は変更できません' }).disabled,
    ).toBe(true)
    expect(generate).not.toHaveBeenCalled()

    await user.click(sheet.getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await open(user)
    await user.click(screen.getByRole('checkbox', { name: /車を利用できる/ }))
    await request(user)
    expect(generate.mock.calls[0][0].travelModes).toEqual(['walk', 'drive'])
    expect(await screen.findByText('承認・適用サービスは未接続です。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '変更内容を確認する' }))
    expect(approvalDisabled()).toBe(true)
  })

  it.each([
    ['no_candidates', '条件に合う候補が見つかりませんでした'],
    ['insufficient_information', '情報が不足しています'],
    ['external_service_error', '外部サービスでエラー'],
    ['unavailable', 'APIは現在利用できません'],
    ['interrupted', '通信が中断されました'],
    ['conflict', '旅程が更新されています'],
  ] as const)('%s を区別して表示し、入力と旅程を保持する', async (status, message) => {
    const user = userEvent.setup()
    const generate = vi
      .fn<GenerateRevisions>()
      .mockResolvedValue({ status, message: 'テスト用の詳細' })
    render(<RevisionRouteTest trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(route().getByText(target.name)).toBeTruthy()
    expect(route().queryByText(after.name)).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>('修正理由（必須）').value).toBe('店が休み')
  })

  it('候補が見つからなかった理由を示し、希望条件を変更して再探索できる', async () => {
    const user = userEvent.setup()
    const generate = vi
      .fn<GenerateRevisions>()
      .mockResolvedValueOnce({
        status: 'no_candidates',
        message: '同じ名前の施設が複数見つかり、1か所に絞れませんでした。',
      })
      .mockImplementationOnce(async ({ reason }) => ({
        ...proposal,
        revisions: proposal.revisions.map((revision) => ({ ...revision, reason })),
      }))
    render(<RevisionRouteTest trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toContain('同じ名前の施設が複数')
    expect(notice.textContent).toContain('希望条件を減らすか')
    expect(route().getByText(target.name)).toBeTruthy()

    await user.type(screen.getByLabelText('希望条件（任意）'), '喫茶店')
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    expect(generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: '店が休み\n希望条件：喫茶店' }),
      expect.any(AbortSignal),
    )
    expect(await screen.findByRole('group', { name: '変更候補を切り替える' })).toBeTruthy()
  })

  it('待機中にTabでキャンセル操作へ移ると、502の後もEnterで再送信しない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Response>()
    const fetchFn = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetchFn)
    const { container } = render(<RevisionRouteTest trip={trip} generate={requestRevisions} />)
    const liveRegion = container.querySelector('[role="status"][aria-atomic="true"]')
    expect(liveRegion?.textContent).toBe('')
    await open(user)
    expect(container.querySelector('[role="status"][aria-atomic="true"]')).toBe(liveRegion)
    await request(user)
    await user.tab({ shift: document.activeElement !== document.body })
    const cancel = document.activeElement
    expect([
      screen.getByRole('button', { name: '部分修正を閉じる' }),
      screen.getByRole('button', { name: 'キャンセル' }),
    ]).toContain(cancel)

    await act(async () =>
      pending.resolve(
        Response.json(
          { status: 'external_service_error', message: '候補生成サービスの障害' },
          { status: 502 },
        ),
      ),
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('外部サービスでエラー')
    expect(alert.getAttribute('data-tone')).toBe('error')
    expect(document.activeElement).toBe(cancel)
    await user.keyboard('{Enter}')
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(screen.getByText('部分修正をキャンセルしました。').closest('[role="status"]')).toBe(
      liveRegion,
    )
  })

  it.each([
    [401, '認証、招待、またはアプリの検証が通りませんでした'],
    [403, '認証、招待、またはアプリの検証が通りませんでした'],
    [429, '利用の回数が上限に達しています'],
    [503, '候補生成APIは現在利用できません'],
  ] as const)(
    'HTTP %i は区別した案内を出し、入力と旅程を保ち、自動では再送しない',
    async (status, text) => {
      const user = userEvent.setup()
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ message: 'サーバー内部の詳細' }, { status }))
      vi.stubGlobal('fetch', fetchFn)
      render(<RevisionRouteTest trip={trip} generate={requestRevisions} />)
      await open(user)
      await request(user)

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain(text)
      expect(alert.textContent).not.toContain('サーバー内部の詳細')
      expect((screen.getByLabelText('修正理由（必須）') as HTMLTextAreaElement).value).toBe(
        '店が休み',
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fetchFn).toHaveBeenCalledOnce()
      const sent = new Headers(fetchFn.mock.calls[0][1]?.headers)
      expect(sent.get('Authorization')).toBe('Bearer test.id.token')
      expect(sent.get('X-Firebase-AppCheck')).toBe('test.app.check')
    },
  )

  it('409でフォーカスを失った場合はキャンセルへ移す', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(pending.promise))
    render(<RevisionRouteTest trip={trip} generate={requestRevisions} />)
    await open(user)
    await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '変更候補を探す' })
    submit.focus()
    await user.keyboard('{Enter}')
    submit.blur()
    expect(document.activeElement).toBe(document.body)

    await act(async () => pending.resolve(new Response(null, { status: 409 })))
    expect(screen.getByRole('alert').textContent).toContain('旅程が更新されています')
    expect(submit.disabled).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'キャンセル' }))
  })

  it('フォーカスを失った状態で404が返ると送信ボタンに戻り、Enterで再試行できる', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Response>()
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json(proposal))
    vi.stubGlobal('fetch', fetchFn)
    render(<RevisionRouteTest trip={trip} generate={requestRevisions} />)
    await open(user)
    await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '変更候補を探す' })
    submit.focus()
    await user.keyboard('{Enter}')
    expect(submit.disabled).toBe(true)
    // jsdomではボタンを無効にしてもフォーカスが残るため、失われた状態を再現する。
    submit.blur()
    expect(document.activeElement).toBe(document.body)
    await act(async () => pending.resolve(new Response(null, { status: 404 })))
    expect(submit.disabled).toBe(false)
    expect(document.activeElement).toBe(submit)
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    expect(await screen.findByRole('table')).toBeTruthy()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it.each(['failed', 'proposed'] as const)(
    '生成コールバックが入力を書き換えて %s を返しても、元のTripは変わらない',
    async (status) => {
      const user = userEvent.setup()
      const source = structuredClone(trip)
      const generate: GenerateRevisions = async ({ trip: input }) => {
        input.stops[1].name = '改変された変更前の予定'
        input.stops[2].isFixed = false
        input.stops[2].evidence[0].explanation = '改変された根拠'
        input.version += 1
        return status === 'failed'
          ? { status: 'external_service_error', message: '生成失敗' }
          : {
              status: 'proposed',
              revisions: [
                {
                  ...first,
                  baseTripVersion: input.version,
                  diff: { ...first.diff, before: input.stops[1] },
                },
              ],
            }
      }
      render(<RevisionRouteTest trip={source} generate={generate} />)
      await open(user)
      await request(user)
      expect((await screen.findByRole('alert')).textContent).toContain(
        status === 'failed' ? '外部サービスでエラー' : '候補の応答を確認できません',
      )
      expect(source).toEqual(trip)
      expect(route().getByText(target.name)).toBeTruthy()
      expect(route().queryByText(/改変された/)).toBeNull()
      expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
    },
  )

  it('生成中のキャンセルで通信を中断し、遅れて届いた候補を破棄する', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<RevisionProposal>()
    const generate = vi.fn<GenerateRevisions>().mockReturnValue(pending.promise)
    render(<RevisionRouteTest trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(generate.mock.calls[0][1].aborted).toBe(true)
    await act(async () => pending.resolve(proposal))
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
    expect(route().getByText(target.name)).toBeTruthy()
  })

  it('候補生成中の親Trip差し替えで中断し、古い候補が届いても最新の旅程を保つ', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<RevisionProposal>()
    const generate = vi.fn<GenerateRevisions>().mockReturnValue(pending.promise)
    const view = render(<RevisionRouteTest trip={trip} generate={generate} />)
    await open(user)
    const status = within(screen.getByRole('region', { name: 'この予定だけ変更' })).getByRole(
      'status',
    )
    expect(status.textContent).toBe('')
    await request(user)
    expect(status.textContent).toContain('候補を探し')
    const latest = {
      ...trip,
      version: 1,
      stops: trip.stops.with(1, { ...target, name: '新しい予定' }),
    }
    view.rerender(<RevisionRouteTest trip={latest} generate={generate} />)
    expect(generate.mock.calls[0][1].aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('旅程が更新された')
    await act(async () => pending.resolve(proposal))
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
    expect(route().getByText('新しい予定')).toBeTruthy()
  })

  it('成立を申告した模擬候補は到着見込みを出さず、承認を送信できない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>()
    const simulated = structuredClone(proposal)
    const slot = simulated.comparisons?.[0].after.toNext
    if (slot?.presence === 'segment' && slot.segment.status === 'known') {
      slot.segment.source = { kind: 'simulation', label: '試験用の架空データ' }
    }
    render(<RevisionRouteTest trip={trip} generate={async () => simulated} apply={apply} />)
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    expect(
      within(screen.getByRole('region', { name: '予定への影響' })).getByText(/徒歩6分（模擬）/),
    ).toBeTruthy()
    expect(screen.queryByText(/間に合う見込みです/)).toBeNull()
    approve().focus()
    await user.keyboard('{Enter}')
    expect(approvalDisabled()).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('比較中に旅程の版や固定状態が変われば候補を破棄する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    const view = render(<RevisionRouteTest trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    view.rerender(
      <RevisionRouteTest
        trip={{ ...trip, version: 1, stops: trip.stops.with(1, { ...target, isFixed: true }) }}
        generate={generate}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('旅程が更新された')
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
    expect(route().getByRole('button', { name: /昼食店A.*固定予定/ })).toBeTruthy()
  })
})

describe('本人承認とサーバー適用', () => {
  it('署名がない候補は理由を示し、適用コールバックを呼ばない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'failed' })
    render(
      <RevisionRouteTest
        trip={trip}
        generate={async () => ({ ...proposal, proposalTokens: {} })}
        apply={apply}
      />,
    )
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    await user.click(approve())
    expect(approvalDisabled()).toBe(true)
    expect(screen.getByText(/候補の来歴を確認できません/)).toBeTruthy()
    expect(apply).not.toHaveBeenCalled()
  })

  it('確定後に別施設へ変更された最新版では反映済みラベルを出さない', async () => {
    const user = userEvent.setup()
    const latest = {
      ...trip,
      version: 2,
      stops: trip.stops
        .with(1, {
          ...after,
          name: 'その後の施設',
          placeId: 'later-place',
          evidence: [],
        })
        .map((stop) => ({ ...stop, evidence: [] })),
    }
    const apply: ApplyRevision = async () => ({
      status: 'applied',
      trip: latest,
      receipt: {
        status: 'already_applied',
        verification: 'not_available',
        appliedTripVersion: 1,
        trip: latest,
        revision: {
          ...first,
          constraintCheck: { status: 'not_checked', explanation: '再確認が必要' },
          approval: { status: 'approved', decidedAt: '2026-11-08T11:47:00+09:00' },
        },
      },
    })
    render(<RevisionRouteTest trip={trip} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    await user.click(approve())
    expect(await screen.findByText('その後の施設')).toBeTruthy()
    expect(route().queryByText('変更を反映済み')).toBeNull()
  })

  it('適用中は元の旅程を保持し、サーバー成功後にだけ置き換える', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const original = structuredClone(trip)
    const { container } = render(
      <RevisionRouteTest trip={trip} meta={meta} generate={generate} apply={apply} />,
    )
    const liveRegion = container.querySelector('[role="status"][aria-atomic="true"]')
    expect(liveRegion?.textContent).toBe('')
    await open(user)
    expect(container.querySelector('[role="status"][aria-atomic="true"]')).toBe(liveRegion)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    await user.click(approve())
    expect(apply).toHaveBeenCalledOnce()
    expect(apply.mock.calls[0][0]).toMatchObject({
      request: { trip, targetStopId: target.id, travelModes: ['walk'] },
      revision: first,
    })
    expect(tableInConfirmation().getByText(target.name)).toBeTruthy()
    expect(screen.getByText('承認操作済み・適用結果を確認中')).toBeTruthy()
    expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
    expect(screen.queryByText('変更を反映済み')).toBeNull()
    expect(trip).toEqual(original)

    const saved = structuredClone({ ...trip, version: 1, stops: trip.stops.with(1, after) })
    saved.stops[1].evidence[0].checkedAt = '2026-11-08T11:47:00+09:00'
    await act(async () => pending.resolve({ status: 'applied', trip: saved }))
    expect(route().getByRole('button', { name: /昼食店B/ })).toBeTruthy()
    expect(route().queryByText(target.name)).toBeNull()
    expect(route().getByRole('button', { name: /14時の予約展示.*固定予定/ })).toBeTruthy()
    const notice = screen.getByText(/旅程に反映されました/)
    expect(notice.closest('[role="status"]')).toBe(liveRegion)
    expect(notice.getAttribute('data-tone')).toBe('success')
    expect(route().getByText('変更を反映済み')).toBeTruthy()
    expect(trip).toEqual(original)

    const appliedButton = route().getByRole('button', { name: /昼食店B/ })
    saved.stops[1].name = '応答後に変更された店'
    await user.click(appliedButton)
    expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe(after.name)
  })

  it('生成コールバックが入力や返却済みの候補を変更しても、承認時の条件と候補は変わらない', async () => {
    const user = userEvent.setup()
    const returned = structuredClone(proposal)
    const generate: GenerateRevisions = async (input) => {
      input.reason = '改変された理由'
      input.travelModes?.push('drive')
      return returned
    }
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'failed' })
    render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)
    await open(user)
    await request(user)
    const confirm = await screen.findByRole('button', { name: '変更内容を確認する' })
    returned.revisions[0].diff.after.name = '応答後に変更された候補'
    returned.revisions[0].constraintCheck.status = 'unknown'
    await user.click(screen.getByRole('button', { name: /候補 B/ }))
    await user.click(screen.getByRole('button', { name: /候補 A/ }))
    expect(route().getByText(after.name)).toBeTruthy()
    await user.click(confirm)
    await user.click(approve())
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ reason: '店が休み', travelModes: ['walk'] }),
        revision: first,
      }),
      expect.any(AbortSignal),
    )
  })

  it('適用コールバックが引数を直接書き換えて失敗しても、候補と固定予定を保持する', async () => {
    const user = userEvent.setup()
    const source = structuredClone(trip)
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>(({ request: { trip: input }, revision }) => {
      input.stops[2].isFixed = false
      input.stops[2].evidence[0].explanation = '改変された根拠'
      input.preferences.push('改変された希望条件')
      revision.diff.after.name = '改変された候補'
      revision.diff.after.evidence[0].explanation = '改変された候補の根拠'
      return pending.promise
    })
    render(<RevisionRouteTest trip={source} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    await user.click(approve())
    expect(source).toEqual(trip)
    expect(tableInConfirmation().getByText(after.name)).toBeTruthy()
    await act(async () => pending.resolve({ status: 'failed' }))
    expect((await screen.findByRole('alert')).textContent).toContain('候補を適用できませんでした')
    expect(source).toEqual(trip)
    expect(tableInConfirmation().getByText(after.name)).toBeTruthy()
    expect(tableInConfirmation().queryByText('改変された候補')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(route().getByRole('button', { name: /14時の予約展示.*固定予定/ })).toBeTruthy()
  })

  it.each(['fixed', 'outside', 'revision', 'version', 'evidence'] as const)(
    '適用コールバックが %s を書き換えたTripを成功応答に使っても拒否する',
    async (change) => {
      const user = userEvent.setup()
      const source = structuredClone(trip)
      source.version = 4
      source.stops[0].isFixed = false
      const original = structuredClone(source)
      const apply: ApplyRevision = async ({ request: { trip: input }, revision }) => {
        if (change === 'fixed') input.stops[2].isFixed = false
        if (change === 'outside') input.stops[0].name = '対象外の予定の改変'
        if (change === 'revision') revision.diff.after.name = '承認していない候補'
        if (change === 'version') input.version = 0
        if (change === 'evidence') revision.diff.after.evidence[0].status = 'conflicting'
        input.stops[1] = revision.diff.after
        return { status: 'applied', trip: { ...input, version: input.version + 1 } }
      }
      render(
        <RevisionRouteTest
          trip={source}
          generate={async () => ({
            status: 'proposed',
            revisions: [{ ...first, baseTripVersion: source.version }],
            comparisons: routes(8),
            proposalTokens: proposal.proposalTokens,
          })}
          apply={apply}
        />,
      )
      await open(user)
      await request(user)
      await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
      await screen.findByRole('button', { name: '承認して適用を依頼' })
      await user.click(approve())
      expect((await screen.findByRole('alert')).textContent).toContain(
        '適用結果を確認できませんでした',
      )
      expect(source).toEqual(original)
      expect(tableInConfirmation().getByText(target.name)).toBeTruthy()
      expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
      expect(approvalDisabled()).toBe(true)
    },
  )

  it('適用中に親Tripが変わると更新通知へフォーカスを移し、古い成功応答を破棄する', async () => {
    const user = userEvent.setup()
    const generate: GenerateRevisions = async () => proposal
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const view = render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    approve().focus()
    await user.keyboard('{Enter}')
    expect(apply).toHaveBeenCalledOnce()

    const latest = {
      ...trip,
      version: 1,
      stops: trip.stops.with(1, { ...target, name: '親が更新した昼食', isFixed: true }),
    }
    view.rerender(<RevisionRouteTest trip={latest} generate={generate} apply={apply} />)
    const update = screen.getByRole('alert')
    expect(document.activeElement).toBe(update)
    expect(update.textContent).toContain('最新の旅程')
    expect(update.textContent).toContain('適用結果を確認できませんでした')
    expect(update.textContent).not.toContain('取り消しました')
    expect(route().getByRole('button', { name: /親が更新した昼食.*固定予定/ })).toBeTruthy()
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
    await user.tab()
    expect(document.activeElement).toBe(
      within(update).getByRole('button', { name: '比較を閉じる' }),
    )
    await act(async () =>
      pending.resolve({
        status: 'applied',
        trip: { ...trip, version: 2, stops: trip.stops.with(1, after) },
      }),
    )
    expect(route().getByRole('button', { name: /親が更新した昼食/ })).toBeTruthy()
    expect(route().queryByText(after.name)).toBeNull()
    expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
  })

  it.each([
    ['conflict', '旅程が更新され'],
    ['failed', '候補を適用できませんでした'],
    ['unavailable', '適用するサービスは現在利用できません'],
    ['network', '適用結果を確認できませんでした'],
    ['invalid-success', '適用結果を確認できませんでした'],
    ['uncertain', '適用結果を確認できませんでした'],
  ] as const)('適用時の %s では変更も成功表示もしない', async (status, message) => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>()
    if (status === 'network') {
      apply.mockRejectedValue(new TypeError('offline'))
    } else if (status === 'invalid-success') {
      // サーバーが成功を返しても、固定予定まで変わっていれば結果は受け入れない。
      apply.mockResolvedValue({
        status: 'applied',
        trip: {
          ...trip,
          version: 1,
          stops: [trip.stops[0], after, { ...trip.stops[2], isFixed: false }],
        },
      })
    } else {
      apply.mockResolvedValue({ status })
    }
    render(<RevisionRouteTest trip={trip} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    await user.click(approve())
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(tableInConfirmation().getByText(target.name)).toBeTruthy()
    expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
    expect(approvalDisabled()).toBe(
      ['conflict', 'network', 'invalid-success', 'uncertain'].includes(status),
    )
  })

  it('適用の結果が不明なときは旅程へ戻ってもキャンセル完了と案内しない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
    render(<RevisionRouteTest trip={trip} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    await user.click(approve())
    await user.click(await screen.findByRole('button', { name: '旅程を確認' }))
    expect(screen.getByRole('alert').textContent).toContain('適用結果を確認できませんでした')
    expect(screen.queryByText('部分修正をキャンセルしました。')).toBeNull()
    expect(route().getByText(target.name)).toBeTruthy()
  })

  it('結果不明の比較を閉じても同じTripへの新しい部分修正を始めず、再操作を解禁しない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)

    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    await user.click(approve())
    expect(apply).toHaveBeenCalledTimes(1)

    await user.click(await screen.findByRole('button', { name: '旅程を確認' }))
    expect(screen.getByRole('alert').textContent).toContain('適用結果を確認できませんでした')
    await user.click(screen.getByRole('button', { name: '比較を閉じる' }))

    // 同じTripを表示していても、サーバーで確定結果を照合するまでは新規操作を出さない。
    expect(screen.getByRole('alert').textContent).toContain('再操作できません')
    await user.click(route().getByRole('button', { name: /昼食店A/ }))
    expect(screen.queryByRole('button', { name: 'この予定だけ変更' })).toBeNull()
    expect(screen.queryByText('詳細な比較・根拠を見る')).toBeNull()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  describe('結果不明の適用の解禁', () => {
    const latestOf = (version: number, name?: string) => ({
      ...trip,
      version,
      stops: name ? trip.stops.map((stop, i) => (i === 0 ? { ...stop, name } : stop)) : trip.stops,
    })
    // 適用を結果不明にして、比較を閉じた状態まで進める。
    const reachUnresolved = async (
      user: ReturnType<typeof userEvent.setup>,
      props: {
        apply: ApplyRevision
        generate: GenerateRevisions
        loadLatestTrip?: LoadLatestTrip
        loadAppliedRevision?: LoadAppliedRevision
      },
    ) => {
      const view = render(<RevisionRouteTest trip={trip} {...props} />)
      await open(user)
      await request(user)
      await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
      await screen.findByRole('button', { name: '承認して適用を依頼' })
      await user.click(approve())
      await user.click(await screen.findByRole('button', { name: '旅程を確認' }))
      await user.click(screen.getByRole('button', { name: '比較を閉じる' }))
      return view
    }
    const startButton = () => screen.queryByRole('button', { name: 'この予定だけ変更' })
    const locked = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(route().getByRole('button', { name: /昼食店A/ }))
      expect(startButton()).toBeNull()
      expect(screen.getByRole('alert').textContent).toContain('再操作できません')
    }

    it('uncertain → 旅程を確認 → 比較を閉じる → 新しい候補生成 → 適用 の順では、2回目のapplyを呼ばない', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      await reachUnresolved(user, { apply, generate })

      await locked(user)
      // 開始の入口を使えないので、新しい候補生成にも、承認にも進めない。
      expect(screen.queryByLabelText('修正理由（必須）')).toBeNull()
      expect(screen.queryByRole('button', { name: '承認して適用を依頼' })).toBeNull()
      expect(generate).toHaveBeenCalledTimes(1)
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('画面を作り直しても、同じTripの結果不明は解禁されない', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const first = await reachUnresolved(user, { apply, generate })
      first.unmount()

      render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)
      expect(screen.getByRole('alert').textContent).toContain('再操作できません')
      await locked(user)
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('UIDが違うTripの記録は混同せず、元のUIDへ戻ればロックを復元する', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const old = await reachUnresolved(user, { apply, generate })
      old.unmount()

      const other = render(
        <RevisionRouteTest ownerUid="other-owner" trip={trip} generate={generate} apply={apply} />,
      )
      await user.click(route().getByRole('button', { name: /昼食店A/ }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'この予定だけ変更' })).toBeTruthy(),
      )
      other.unmount()

      render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)
      await locked(user)
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('未確認状態を永続保存できなければ適用APIを呼ばず、操作を止める', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>()
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage unavailable')
      })
      render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)
      await open(user)
      await request(user)
      await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
      await screen.findByRole('button', { name: '承認して適用を依頼' })
      await user.click(approve())
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('適用を開始しませんでした'),
      )
      expect(apply).not.toHaveBeenCalled()
    })

    it('適用の応答を待つ途中で画面が外れても、同じTripは再操作できない', async () => {
      const user = userEvent.setup()
      const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
      const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const view = render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)
      await open(user)
      await request(user)
      await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
      await screen.findByRole('button', { name: '承認して適用を依頼' })
      await user.click(approve())
      view.unmount()
      pending.resolve({ status: 'uncertain' })

      render(<RevisionRouteTest trip={trip} generate={generate} apply={apply} />)
      await locked(user)
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['取得に失敗（例外）', () => Promise.reject(new TypeError('offline'))],
      ['取得結果なし', () => Promise.resolve(null)],
      ['別の旅程', () => Promise.resolve({ ...latestOf(trip.version + 1), id: 'other-trip' })],
      ['版が古い', () => Promise.resolve(latestOf(trip.version - 1))],
      ['形式が不正', () => Promise.resolve({ id: trip.id } as never)],
    ])('サーバーの旅程を照合できなければ解禁しない（%s）', async (_name, load) => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const loadLatestTrip = vi.fn<LoadLatestTrip>(load)
      const loadAppliedRevision = vi.fn<LoadAppliedRevision>().mockResolvedValue(null)
      await reachUnresolved(user, { apply, generate, loadLatestTrip, loadAppliedRevision })

      await user.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('まだ再操作できません'),
      )
      expect(loadLatestTrip).toHaveBeenCalledWith(trip.id, expect.any(AbortSignal))
      await locked(user)
      expect(generate).toHaveBeenCalledTimes(1)
      expect(apply).toHaveBeenCalledTimes(1)
    })

    const savedApprovedRevision = {
      ...first,
      constraintCheck: { status: 'not_checked' as const, explanation: '再確認が必要' },
      approval: { status: 'approved' as const, decidedAt: '2026-11-08T11:47:00+09:00' },
    }

    it('別の更新で版が進んでも、対象Revisionが未承認なら解禁しない', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const loadLatestTrip = vi.fn<LoadLatestTrip>().mockResolvedValue(latestOf(trip.version + 1))
      const loadAppliedRevision = vi
        .fn<LoadAppliedRevision>()
        .mockResolvedValue({ ...savedApprovedRevision, approval: { status: 'pending' } })
      await reachUnresolved(user, { apply, generate, loadLatestTrip, loadAppliedRevision })
      await user.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('まだ再操作できません'),
      )
      await locked(user)
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('同じ版のGET後に遅延コミットが成立する場合も、先に再操作を許可しない', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      let committed = false
      const loadLatestTrip = vi
        .fn<LoadLatestTrip>()
        .mockImplementation(async () => latestOf(trip.version + (committed ? 1 : 0)))
      const loadAppliedRevision = vi
        .fn<LoadAppliedRevision>()
        .mockImplementation(async () =>
          committed
            ? savedApprovedRevision
            : { ...savedApprovedRevision, approval: { status: 'pending' } },
        )
      await reachUnresolved(user, { apply, generate, loadLatestTrip, loadAppliedRevision })
      await user.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('まだ再操作できません'),
      )
      expect(screen.getByRole('alert').textContent).toContain('再操作できません')
      expect(apply).toHaveBeenCalledTimes(1)
      committed = true
      await user.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
      expect((await screen.findByRole('status')).textContent).toContain('適用を確認し')
      await user.click(route().getByRole('button', { name: /昼食店A/ }))
      expect(startButton()).not.toBeNull()
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('対象Revisionの承認済み記録と版の進んだTripが揃えば解禁する', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const loadLatestTrip = vi
        .fn<LoadLatestTrip>()
        .mockResolvedValue(latestOf(trip.version + 1, '更新後の集合'))
      const loadAppliedRevision = vi
        .fn<LoadAppliedRevision>()
        .mockResolvedValue(savedApprovedRevision)
      await reachUnresolved(user, { apply, generate, loadLatestTrip, loadAppliedRevision })
      await user.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
      expect((await screen.findByRole('status')).textContent).toContain('適用を確認し')
      expect(route().getByText('更新後の集合')).toBeTruthy()
      expect(loadAppliedRevision).toHaveBeenCalledWith(trip.id, first.id, expect.any(AbortSignal))
      await user.click(route().getByRole('button', { name: /昼食店A/ }))
      expect(startButton()).not.toBeNull()
    })

    it('別候補の承認済み記録では、この候補の適用結果を確定しない', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const loadLatestTrip = vi.fn<LoadLatestTrip>().mockResolvedValue(latestOf(trip.version + 1))
      const loadAppliedRevision = vi
        .fn<LoadAppliedRevision>()
        .mockResolvedValue({ ...savedApprovedRevision, id: 'another-revision' })
      await reachUnresolved(user, { apply, generate, loadLatestTrip, loadAppliedRevision })
      await user.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('まだ再操作できません'),
      )
      await locked(user)
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('同じ版では対象Revisionが承認済みでも不整合として解禁しない', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const loadLatestTrip = vi.fn<LoadLatestTrip>().mockResolvedValue(latestOf(trip.version))
      const loadAppliedRevision = vi
        .fn<LoadAppliedRevision>()
        .mockResolvedValue(savedApprovedRevision)
      await reachUnresolved(user, { apply, generate, loadLatestTrip, loadAppliedRevision })
      await user.click(screen.getByRole('button', { name: '最新の旅程を取得して確認する' }))
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain('まだ再操作できません'),
      )
      await locked(user)
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('親が版の進んだ旅程を渡しても、サーバーの照合までは解禁しない', async () => {
      const user = userEvent.setup()
      const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
      const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
      const view = await reachUnresolved(user, { apply, generate })

      view.rerender(
        <RevisionRouteTest trip={latestOf(trip.version + 1)} generate={generate} apply={apply} />,
      )
      await locked(user)
      expect(apply).toHaveBeenCalledTimes(1)
    })
  })

  it.each(['not_checked', 'violated'] as const)('%s の候補は承認できない', async (status) => {
    const user = userEvent.setup()
    render(
      <RevisionRouteTest
        trip={trip}
        generate={async () => ({
          status: 'proposed',
          revisions: [{ ...first, constraintCheck: { ...first.constraintCheck, status } }],
        })}
        apply={vi.fn<ApplyRevision>()}
      />,
    )
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    expect(approvalDisabled()).toBe(true)
  })
})

describe('旅程の変更を親が採用する（adoptTripChange）', () => {
  it('固定の切り替えで呼ばれ、親が返した旅程を画面に採用する。通知は残る', async () => {
    const user = userEvent.setup()
    const adopt = vi.fn((changed: typeof trip) => ({
      ...changed,
      stops: changed.stops.map((stop) =>
        stop.id === target.id ? { ...stop, evidence: [] } : stop,
      ),
    }))
    render(<RevisionRouteTest trip={trip} meta={meta} adoptTripChange={adopt} />)

    await user.click(route().getByRole('button', { name: /昼食店A/ }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'この予定を固定する' }))

    expect(adopt).toHaveBeenCalledOnce()
    expect(adopt.mock.calls[0][0].stops.find((stop) => stop.id === target.id)?.isFixed).toBe(true)
    // 採用された旅程（根拠なし）が表示され、固定の通知は消えない。
    expect(within(dialog).getByText('施設情報や移動時間と照合していません。')).toBeTruthy()
    expect(within(dialog).getByRole('status').textContent).toContain('固定しました')
    expect(within(dialog).getByRole('button', { name: '固定を解除する' })).toBeTruthy()
  })

  it('候補の適用成功でも呼ばれ、採用された旅程が路線図に出る', async () => {
    const user = userEvent.setup()
    const saved = { ...trip, version: 1, stops: trip.stops.with(1, after) }
    const adopt = vi.fn((changed: typeof trip) => ({
      ...changed,
      stops: changed.stops.map((stop) =>
        stop.id === after.id ? { ...stop, name: '採用後の店' } : stop,
      ),
    }))
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'applied', trip: saved })
    render(
      <RevisionRouteTest
        trip={trip}
        meta={meta}
        generate={async () => proposal}
        apply={apply}
        adoptTripChange={adopt}
      />,
    )
    await open(user)
    await request(user)
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('button', { name: '承認して適用を依頼' })
    await user.click(approve())

    await screen.findByText(/旅程に反映されました/)
    expect(adopt).toHaveBeenCalledOnce()
    expect(adopt.mock.calls[0][0]).toEqual(saved)
    expect(route().getByRole('button', { name: /採用後の店/ })).toBeTruthy()
  })

  it('指定しなければ、従来どおり変更後の旅程をそのまま使う', async () => {
    const user = userEvent.setup()
    render(<RevisionRouteTest trip={trip} meta={meta} />)
    await user.click(route().getByRole('button', { name: /昼食店A/ }))
    await user.click(screen.getByRole('button', { name: 'この予定を固定する' }))
    expect(screen.getByRole('button', { name: '固定を解除する' })).toBeTruthy()
  })
})
