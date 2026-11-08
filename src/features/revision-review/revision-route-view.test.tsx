// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision } from '@/domain/samples'
import { sampleRouteMeta as meta, sampleRouteTrip as trip } from '@/features/trip-map/sample'

import {
  requestRevisions,
  type ApplyRevision,
  type GenerateRevisions,
  type RevisionProposal,
} from './api-client'
import { RevisionRouteView } from './revision-route-view'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
  constraintCheck: { status: 'unknown', explanation: '営業時間が不明' },
} satisfies RevisionProposal['revisions'][number]

function routes(minutes: number): RevisionProposal['comparisons'] {
  return [
    {
      revisionId: first.id,
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

describe('部分修正の候補比較', () => {
  it('選択したStopだけを徒歩で生成し、分岐、固定予定、構造化比較を切り替える', async () => {
    const user = userEvent.setup()
    // 希望条件を足すと理由が変わるため、応答も送られた理由に合わせる。
    const generate = vi.fn<GenerateRevisions>(async ({ reason }) => ({
      ...proposal,
      revisions: proposal.revisions.map((revision) => ({ ...revision, reason })),
    }))
    const apply = vi.fn<ApplyRevision>()
    const original = structuredClone(trip)
    render(<RevisionRouteView trip={trip} meta={meta} generate={generate} apply={apply} />)

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
    const table = within(await screen.findByRole('table'))
    const scope = () => within(screen.getByRole('region', { name: '予定への影響' }))
    expect(scope().getByText(/営業時間：情報源と整合（照合/)).toBeTruthy()
    expect(scope().getByText(/前の予定から：徒歩8分/)).toBeTruthy()
    expect(scope().getByText(/臨時休業・渋滞・遅延は確認の対象外/)).toBeTruthy()
    expect(table.getByText('徒歩8分')).toBeTruthy()
    expect(table.getByText('2分短い')).toBeTruthy()
    expect(table.getByText('4分短い')).toBeTruthy()
    expect(
      screen.getByText(`${trip.stops[2].plannedStartTime}の予定に間に合う見込みです。`),
    ).toBeTruthy()
    expect(table.queryByText(/999分/)).toBeNull()
    expect(
      route().getByText(after.name).closest('[data-variant]')?.getAttribute('data-variant'),
    ).toBe('ticket')
    expect(route().getByText(target.name)).toBeTruthy()
    expect(route().getByText('この先は元の旅程に合流')).toBeTruthy()
    expect(
      route().getByText(trip.stops[2].name).closest('[data-variant]')?.querySelector('svg'),
    ).toBeTruthy()
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain('矛盾あり')
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain(
      '情報源と整合',
    )
    expect(route().getByText('営業時間：確認できない')).toBeTruthy()
    expect(approvalDisabled()).toBe(false)

    await user.click(screen.getByRole('button', { name: /候補 B/ }))
    expect(route().getByText('別の食堂')).toBeTruthy()
    expect(route().queryByText(after.name)).toBeNull()
    expect(within(screen.getByRole('table')).getAllByText('移動時間は未取得')).toHaveLength(4)
    expect(within(screen.getByRole('table')).getAllByText('時間差：未確認')).toHaveLength(2)
    expect(scope().getByText('営業時間：未確認')).toBeTruthy()
    expect(screen.queryByText(/間に合う見込みです/)).toBeNull()
    expect(screen.getByText(/確認できていないため、この候補は選べません/)).toBeTruthy()
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain('未照合')
    expect(approvalDisabled()).toBe(true)
    approve().focus()
    expect(approve().getAttribute('aria-describedby')).toBe('approval-note')
    await user.keyboard('{Enter}')
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
    expect(trip).toEqual(original)

    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(route().queryByText('別の食堂')).toBeNull()
    expect(document.activeElement?.id).toBe('stop-button-stop-lunch')
    expect(trip).toEqual(original)
  })

  it('修正理由と希望条件を合わせて保存契約の上限を超えるときは、送らずに案内する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    render(<RevisionRouteView trip={trip} generate={generate} />)
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
    render(<RevisionRouteView trip={trip} generate={async () => modified} />)
    await open(user)
    await user.click(screen.getByRole('checkbox', { name: /車を利用できる/ }))
    await request(user)
    const table = within(await screen.findByRole('table'))
    expect(table.getByText('車8分')).toBeTruthy()
    expect(table.getByText('徒歩6分')).toBeTruthy()
    expect(table.getAllByText('時間差：未確認')).toHaveLength(2)
  })

  it('固定予定の修正を防ぎ、明示したときだけ車を送信する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    render(<RevisionRouteView trip={trip} meta={meta} generate={generate} />)
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
    render(<RevisionRouteView trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(route().getByText(target.name)).toBeTruthy()
    expect(route().queryByText(after.name)).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>('修正理由（必須）').value).toBe('店が休み')
  })

  it('待機中にTabでキャンセルへ移ると、502の後もEnterで再送信しない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Response>()
    const fetchFn = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetchFn)
    const { container } = render(<RevisionRouteView trip={trip} generate={requestRevisions} />)
    const liveRegion = container.querySelector('[role="status"][aria-atomic="true"]')
    expect(liveRegion?.textContent).toBe('')
    await open(user)
    expect(container.querySelector('[role="status"][aria-atomic="true"]')).toBe(liveRegion)
    await request(user)
    const cancel = screen.getByRole('button', { name: 'キャンセル' })
    await user.tab({ shift: document.activeElement !== document.body })
    expect(document.activeElement).toBe(cancel)

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

  it('409でフォーカスを失った場合はキャンセルへ移す', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(pending.promise))
    render(<RevisionRouteView trip={trip} generate={requestRevisions} />)
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
    render(<RevisionRouteView trip={trip} generate={requestRevisions} />)
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
      render(<RevisionRouteView trip={source} generate={generate} />)
      await open(user)
      await request(user)
      expect((await screen.findByRole('alert')).textContent).toContain(
        status === 'failed' ? '外部サービスでエラー' : '候補の応答を確認できません',
      )
      expect(source).toEqual(trip)
      expect(route().getByText(target.name)).toBeTruthy()
      expect(route().queryByText(/改変された/)).toBeNull()
      expect(screen.queryByRole('table')).toBeNull()
    },
  )

  it('生成中のキャンセルで通信を中断し、遅れて届いた候補を破棄する', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<RevisionProposal>()
    const generate = vi.fn<GenerateRevisions>().mockReturnValue(pending.promise)
    render(<RevisionRouteView trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(generate.mock.calls[0][1].aborted).toBe(true)
    await act(async () => pending.resolve(proposal))
    expect(screen.queryByRole('table')).toBeNull()
    expect(route().getByText(target.name)).toBeTruthy()
  })

  it('候補生成中の親Trip差し替えで中断し、古い候補が届いても最新の旅程を保つ', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<RevisionProposal>()
    const generate = vi.fn<GenerateRevisions>().mockReturnValue(pending.promise)
    const view = render(<RevisionRouteView trip={trip} generate={generate} />)
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
    view.rerender(<RevisionRouteView trip={latest} generate={generate} />)
    expect(generate.mock.calls[0][1].aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('旅程が更新された')
    await act(async () => pending.resolve(proposal))
    expect(screen.queryByRole('table')).toBeNull()
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
    render(<RevisionRouteView trip={trip} generate={async () => simulated} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
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
    const view = render(<RevisionRouteView trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    view.rerender(
      <RevisionRouteView
        trip={{ ...trip, version: 1, stops: trip.stops.with(1, { ...target, isFixed: true }) }}
        generate={generate}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('旅程が更新された')
    expect(screen.queryByRole('table')).toBeNull()
    expect(route().getByRole('button', { name: /昼食店A.*固定予定/ })).toBeTruthy()
  })
})

describe('本人承認とサーバー適用', () => {
  it('適用中は元の旅程を保持し、サーバー成功後にだけ置き換える', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const original = structuredClone(trip)
    const { container } = render(
      <RevisionRouteView trip={trip} meta={meta} generate={generate} apply={apply} />,
    )
    const liveRegion = container.querySelector('[role="status"][aria-atomic="true"]')
    expect(liveRegion?.textContent).toBe('')
    await open(user)
    expect(container.querySelector('[role="status"][aria-atomic="true"]')).toBe(liveRegion)
    await request(user)
    await screen.findByRole('table')
    await user.click(approve())
    expect(apply).toHaveBeenCalledOnce()
    expect(apply.mock.calls[0][0]).toMatchObject({
      request: { trip, targetStopId: target.id, travelModes: ['walk'] },
      revision: first,
    })
    expect(route().getByText(target.name)).toBeTruthy()
    expect(screen.getByText('承認操作済み・適用結果を確認中')).toBeTruthy()
    expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
    expect(route().queryByText('変更を反映済み')).toBeNull()
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
    render(<RevisionRouteView trip={trip} generate={generate} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    returned.revisions[0].diff.after.name = '応答後に変更された候補'
    returned.revisions[0].constraintCheck.status = 'unknown'
    await user.click(screen.getByRole('button', { name: /候補 B/ }))
    await user.click(screen.getByRole('button', { name: /候補 A/ }))
    expect(route().getByText(after.name)).toBeTruthy()
    await user.click(approve())
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ reason: '店が休み', travelModes: ['walk'] }),
        revision: first,
      }),
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
    render(<RevisionRouteView trip={source} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    await user.click(approve())
    expect(source).toEqual(trip)
    expect(route().getByText(after.name)).toBeTruthy()
    await act(async () => pending.resolve({ status: 'failed' }))
    expect((await screen.findByRole('alert')).textContent).toContain('候補を適用できませんでした')
    expect(source).toEqual(trip)
    expect(route().getByText(after.name)).toBeTruthy()
    expect(route().queryByText('改変された候補')).toBeNull()
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
        <RevisionRouteView
          trip={source}
          generate={async () => ({
            status: 'proposed',
            revisions: [{ ...first, baseTripVersion: source.version }],
            comparisons: routes(8),
          })}
          apply={apply}
        />,
      )
      await open(user)
      await request(user)
      await screen.findByRole('table')
      await user.click(approve())
      expect((await screen.findByRole('alert')).textContent).toContain(
        '適用結果を確認できませんでした',
      )
      expect(source).toEqual(original)
      expect(route().getByText(target.name)).toBeTruthy()
      expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
      expect(approvalDisabled()).toBe(true)
    },
  )

  it('適用中に親Tripが変わると更新通知へフォーカスを移し、古い成功応答を破棄する', async () => {
    const user = userEvent.setup()
    const generate: GenerateRevisions = async () => proposal
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const view = render(<RevisionRouteView trip={trip} generate={generate} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    approve().focus()
    await user.keyboard('{Enter}')
    expect(apply).toHaveBeenCalledOnce()

    const latest = {
      ...trip,
      version: 1,
      stops: trip.stops.with(1, { ...target, name: '親が更新した昼食', isFixed: true }),
    }
    view.rerender(<RevisionRouteView trip={latest} generate={generate} apply={apply} />)
    const update = screen.getByRole('alert')
    expect(document.activeElement).toBe(update)
    expect(update.textContent).toContain('最新の旅程')
    expect(update.textContent).toContain('適用結果を確認できませんでした')
    expect(update.textContent).not.toContain('取り消しました')
    expect(route().getByRole('button', { name: /親が更新した昼食.*固定予定/ })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
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
    render(<RevisionRouteView trip={trip} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    await user.click(approve())
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(route().getByText(target.name)).toBeTruthy()
    expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
    expect(approvalDisabled()).toBe(
      ['conflict', 'network', 'invalid-success', 'uncertain'].includes(status),
    )
  })

  it('適用の結果が不明なときは旅程へ戻ってもキャンセル完了と案内しない', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
    render(<RevisionRouteView trip={trip} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    await user.click(approve())
    await user.click(await screen.findByRole('button', { name: '旅程を確認' }))
    expect(screen.getByRole('alert').textContent).toContain('適用結果を確認できませんでした')
    expect(screen.queryByText('部分修正をキャンセルしました。')).toBeNull()
    expect(route().getByText(target.name)).toBeTruthy()
  })

  it.each(['not_checked', 'violated'] as const)('%s の候補は承認できない', async (status) => {
    const user = userEvent.setup()
    render(
      <RevisionRouteView
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
    await screen.findByRole('table')
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
    render(<RevisionRouteView trip={trip} meta={meta} adoptTripChange={adopt} />)

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
      <RevisionRouteView
        trip={trip}
        meta={meta}
        generate={async () => proposal}
        apply={apply}
        adoptTripChange={adopt}
      />,
    )
    await open(user)
    await request(user)
    await screen.findByRole('table')
    await user.click(approve())

    await screen.findByText(/旅程に反映されました/)
    expect(adopt).toHaveBeenCalledOnce()
    expect(adopt.mock.calls[0][0]).toEqual(saved)
    expect(route().getByRole('button', { name: /採用後の店/ })).toBeTruthy()
  })

  it('指定しなければ、従来どおり変更後の旅程をそのまま使う', async () => {
    const user = userEvent.setup()
    render(<RevisionRouteView trip={trip} meta={meta} />)
    await user.click(route().getByRole('button', { name: /昼食店A/ }))
    await user.click(screen.getByRole('button', { name: 'この予定を固定する' }))
    expect(screen.getByRole('button', { name: '固定を解除する' })).toBeTruthy()
  })
})
