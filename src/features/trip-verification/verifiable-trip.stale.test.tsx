// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Trip } from '@/domain'

import type { VerificationResult } from './api-client'
import {
  generated,
  generated4,
  revisedStop,
  serverVerified,
  userReport,
  type ServerOptions,
} from './test-fixtures'
import type { VerifyTrip } from './use-trip-verification'
import { VerifiableTrip } from './verifiable-trip'

// 路線図の代役。親へ「旅程が変わった」ことを伝える操作だけを持つ。
// 変更の中身は、テストが queue に積む関数で決める（部分修正の適用・名称の変更・根拠の追加など）。
const script = vi.hoisted(() => ({ queue: [] as Array<(shown: Trip) => Trip> }))

vi.mock('@/features/revision-review/revision-route-view', () => ({
  RevisionRouteView: function FakeRouteView({
    trip,
    adoptTripChange,
  }: {
    trip: Trip
    adoptTripChange?: (changed: Trip) => Trip
  }) {
    const [local, setLocal] = useState<{ source: Trip; trip: Trip } | null>(null)
    // 本物と同じく、親から渡された旅程が変わったら、ローカルの変更は捨てる。
    const shown = local?.source === trip ? local.trip : trip
    return (
      <div>
        <ul aria-label="予定">
          {shown.stops.map((stop) => (
            <li key={stop.id} data-stop={stop.id}>
              {stop.name}｜Place ID:{stop.placeId ?? 'なし'}｜根拠:
              {stop.evidence.map((item) => `${item.id}=${item.status}`).join(',') || 'なし'}
              ｜固定:{String(stop.isFixed)}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            const change = script.queue.shift()
            if (!change) return
            const next = change(shown)
            setLocal({ source: trip, trip: adoptTripChange?.(next) ?? next })
          }}
        >
          次の変更を行う
        </button>
      </div>
    )
  },
}))

afterEach(() => {
  cleanup()
  script.queue.length = 0
})

const panel = () => within(screen.getByRole('region', { name: '根拠の確認' }))
const panelText = () => screen.getByRole('region', { name: '根拠の確認' }).textContent ?? ''
const statusText = () => panel().getByRole('status').textContent ?? ''
const row = (id: string) => document.querySelector(`[data-stop="${id}"]`)?.textContent ?? ''
const verifyButton = () =>
  screen.getByRole('button', { name: /^(根拠を確認する|もう一度確認する)$/ })

type User = ReturnType<typeof userEvent.setup>
const change = (user: User) => user.click(screen.getByRole('button', { name: '次の変更を行う' }))
const rename = (id: string, name: string) => (shown: Trip) => ({
  ...shown,
  version: shown.version + 1,
  stops: shown.stops.map((stop) => (stop.id === id ? { ...stop, name } : stop)),
})

// 照合APIの模擬。呼ばれるたびに、順に、結果（または失敗）を返す。
function verifySequence(
  ...steps: Array<ServerOptions | { fail: 'service_unavailable' | 'external_service_error' }>
) {
  const queue = [...steps]
  return vi.fn<VerifyTrip>(async (trip): Promise<VerificationResult> => {
    const step = queue.shift() ?? {}
    if ('fail' in step) {
      return { ok: false, failure: { kind: step.fail, message: 'サーバーからの説明' } }
    }
    return { ok: true, trip: serverVerified(trip, step) }
  })
}

async function verified(user: User) {
  await user.click(verifyButton())
  await act(async () => {})
}

describe('古い根拠・Place IDの復活防止（再照合・部分修正・連続変更）', () => {
  it('同定済み→部分修正→再照合で同定不可になった予定は、別の予定を変えても古いPlace IDと「整合」が復活しない', async () => {
    const verify = verifySequence({}, { unidentified: ['stop-lunch'] })
    script.queue.push(
      (shown) =>
        revisedStop(shown, 'stop-lunch', '昼食店B（架空候補）', '2026-11-08T11:00:00+09:00'),
      rename('stop-morning', '朝の別の庭園'),
    )
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)

    await verified(user)
    await change(user)
    // 部分修正で得た候補の根拠は、適用の直後は残る。
    expect(row('stop-lunch')).toContain('Place ID:place-stop-lunch-昼食店B（架空候補）')

    await verified(user)
    // 再照合で同定できなかった：Place IDは外れ、「確認できない」になる。
    expect(row('stop-lunch')).toContain('Place ID:なし')
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=unverifiable')

    await change(user)
    // 別の予定を変えても、古いPlace IDも、古い「情報源と整合」も戻らない。
    expect(row('stop-lunch')).toContain('Place ID:なし')
    expect(row('stop-lunch')).not.toContain('place-stop-lunch-昼食店B')
    expect(row('stop-lunch')).not.toContain('=consistent')
  })

  it('名称を変えた予定に本人の報告を足しても、変更前の名称に対する照合の根拠は残らない（本人の報告は残る）', async () => {
    const verify = verifySequence({})
    script.queue.push((shown) => ({
      ...shown,
      version: shown.version + 1,
      stops: shown.stops.map((stop) =>
        stop.id === 'stop-lunch'
          ? { ...stop, name: '別の昼食店', evidence: [...stop.evidence, userReport()] }
          : stop,
      ),
    }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await verified(user)

    await change(user)

    const lunch = row('stop-lunch')
    expect(lunch).toContain('Place ID:なし')
    expect(lunch).not.toContain('evidence-stop-lunch-place')
    expect(lunch).not.toContain('evidence-stop-lunch-hours')
    expect(lunch).not.toContain('evidence-stop-lunch-travel')
    expect(lunch).toContain('evidence-user-report=consistent')
  })

  it('名称を変えた予定の根拠を一部だけ消した変更でも、残りの照合の根拠は残らない', async () => {
    const verify = verifySequence({})
    script.queue.push((shown) => ({
      ...shown,
      version: shown.version + 1,
      stops: shown.stops.map((stop) =>
        stop.id === 'stop-lunch'
          ? {
              ...stop,
              name: '別の昼食店',
              evidence: stop.evidence.filter((item) => !item.id.endsWith('-hours')),
            }
          : stop,
      ),
    }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await verified(user)

    await change(user)

    expect(row('stop-lunch')).toContain('Place ID:なし')
    expect(row('stop-lunch')).toContain('根拠:なし')
  })

  it('隣接する2件を続けて差し替えたとき、変更前の区間についての根拠は残らない', async () => {
    const verify = verifySequence({})
    script.queue.push(
      (shown) =>
        revisedStop(shown, 'stop-lunch', '昼食店B（架空候補）', '2026-11-08T11:00:00+09:00'),
      (shown) =>
        revisedStop(shown, 'stop-walk', '別の散策（架空候補）', '2026-11-08T11:05:00+09:00'),
    )
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated4} verify={verify} />)
    await verified(user)

    await change(user)
    // 1件目を差し替えた直後：昼食店Bから散策への移動の根拠がある。
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-travel-next=consistent')

    await change(user)
    // 散策も差し替えた：昼食店Bから「元の散策」への移動の根拠は、もう成り立たない。
    expect(row('stop-lunch')).not.toContain('evidence-stop-lunch-travel-next')
    // 昼食店B自身の施設・営業時間・朝からの移動の根拠は、まだ有効。
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=consistent')
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-hours=consistent')
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-travel=consistent')
    // 新しい散策には、昼食店B→新しい散策の移動の根拠が付いている。
    expect(row('stop-walk')).toContain('evidence-stop-walk-travel=consistent')
  })

  it('再照合で、本人の報告は失われない（照合由来の根拠だけが置き換わる）', async () => {
    const withReport = {
      ...generated,
      stops: generated.stops.map((stop) =>
        stop.id === 'stop-lunch' ? { ...stop, evidence: [userReport()] } : stop,
      ),
    }
    const verify = verifySequence({})
    const user = userEvent.setup()
    render(<VerifiableTrip trip={withReport} verify={verify} />)

    await verified(user)

    expect(row('stop-lunch')).toContain('evidence-user-report=consistent')
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=consistent')
  })
})

describe('再照合の失敗・外部照会0件の表示', () => {
  it('成功済みの結果があるとき再照合が失敗したら、表示中の根拠は以前の照合結果（日時つき）と案内し、「未確認のまま」とは言わない', async () => {
    const verify = verifySequence({}, { fail: 'service_unavailable' })
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await verified(user)

    await verified(user)

    const alert = panel().getByRole('alert')
    expect(alert.textContent).toContain('以前の照合結果')
    expect(alert.textContent).toContain('2026/11/08 10:00')
    expect(alert.textContent).not.toContain('未確認のまま')
    expect(alert.textContent).toContain('今回の確認は反映していません')
    // 以前の結果は表示したまま（失敗で消さない）。
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=consistent')
    expect(statusText()).toContain('以前の照合結果')
  })

  it('照合の結果がまだ無いときの失敗は、「未確認のまま」と案内する', async () => {
    const verify = verifySequence({ fail: 'service_unavailable' })
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)

    await verified(user)

    expect(panel().getByRole('alert').textContent).toContain('未確認のまま')
    expect(panel().getByRole('alert').textContent).not.toContain('以前の照合結果')
  })

  it('外部の情報源に1件も照会しなかったとき（乗車・乗換だけなど）、施設・営業時間・移動を確認したように表示しない', async () => {
    const verify = verifySequence({ skipped: generated.stops.map((stop) => stop.id) })
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)

    await verified(user)

    expect(statusText()).not.toContain('照合結果あり')
    expect(statusText()).toContain('外部の情報源に照会した項目はありません')
    const text = panelText()
    expect(text).not.toContain('確認した範囲')
    expect(text).toContain('照合していません')
    // 乗車・乗換だけでも、照合が承認・予約・保存を意味しないことは伝える。
    expect(text).toContain('確定・予約・保存するものではありません')
  })
})

describe('照合の状態遷移（連続照合・通信断・古い応答・照合中の変更）', () => {
  it('別の予定を変えても、変更の影響を受けない予定の施設・営業時間の根拠は残る。隣の予定の移動の根拠は取り下げる', async () => {
    const verify = verifySequence({})
    script.queue.push(rename('stop-morning', '朝の別の庭園'))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await verified(user)

    await change(user)

    expect(row('stop-morning')).toContain('Place ID:なし')
    expect(row('stop-morning')).not.toContain('=consistent')
    expect(row('stop-lunch')).toContain('Place ID:place-stop-lunch')
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=consistent')
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-hours=consistent')
    // 朝→昼食の移動は、朝が変わったので成り立たない。昼食→展示の移動は変わらない。
    expect(row('stop-lunch')).not.toContain('evidence-stop-lunch-travel')
    expect(row('stop-exhibition')).toContain('evidence-stop-exhibition-travel=consistent')
    expect(statusText()).toContain('変更後の一部は未確認')
  })

  it('実行中の再押下は受け付けず、照合は1回だけ送る', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)

    await user.click(verifyButton())
    await user.click(screen.getByRole('button', { name: '確認しています…' }))
    await user.click(screen.getByRole('button', { name: '確認しています…' }))

    expect(verify).toHaveBeenCalledOnce()
    await act(async () => pending.resolve({ ok: true, trip: serverVerified(generated) }))
    expect(statusText()).toContain('照合結果あり')
    expect(verify).toHaveBeenCalledOnce()
  })

  it('通信が途切れた再照合は、以前の結果を保ち、押し直すと新しい結果に置き換わる', async () => {
    const verify = vi
      .fn<VerifyTrip>()
      .mockResolvedValueOnce({ ok: true, trip: serverVerified(generated) })
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'interrupted', message: '通信が中断されました。' },
      })
      .mockImplementationOnce(async (trip) => ({
        ok: true,
        trip: serverVerified(trip, {
          unidentified: ['stop-lunch'],
          checkedAt: '2026-11-08T12:00:00+09:00',
        }),
      }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await verified(user)

    await verified(user)
    // 失敗：以前の結果は表示したまま。
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=consistent')
    expect(panel().getByRole('alert').textContent).toContain('以前の照合結果')

    await verified(user)
    // 成功：新しい結果に置き換わり、失敗の通知は消える。以前の「整合」は残らない。
    expect(row('stop-lunch')).toContain('Place ID:なし')
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=unverifiable')
    expect(panel().queryByRole('alert')).toBeNull()
    expect(verify).toHaveBeenCalledTimes(3)
  })

  it('新しい旅程が生成されたあとに届いた、前の旅程の照合結果は採用しない', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const user = userEvent.setup()
    const { rerender } = render(<VerifiableTrip trip={generated} verify={verify} />)
    await user.click(verifyButton())

    const regenerated = { ...generated, id: 'trip-regenerated' }
    rerender(<VerifiableTrip trip={regenerated} verify={verify} />)
    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => pending.resolve({ ok: true, trip: serverVerified(generated) }))

    expect(statusText()).toContain('未確認')
    expect(row('stop-lunch')).toContain('Place ID:なし')
    expect(row('stop-lunch')).toContain('根拠:なし')
  })

  it('照合中に固定を切り替えても結果は採用され、固定は残り、本人の報告は失われない', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const withReport = {
      ...generated,
      stops: generated.stops.map((stop) =>
        stop.id === 'stop-lunch' ? { ...stop, evidence: [userReport()] } : stop,
      ),
    }
    script.queue.push((shown) => ({
      ...shown,
      version: shown.version + 1,
      stops: shown.stops.map((stop) =>
        stop.id === 'stop-lunch' ? { ...stop, isFixed: true } : stop,
      ),
    }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={withReport} verify={verify} />)
    await user.click(verifyButton())

    await change(user)
    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await act(async () => pending.resolve({ ok: true, trip: serverVerified(withReport) }))

    expect(statusText()).toContain('照合結果あり')
    expect(row('stop-lunch')).toContain('evidence-user-report=consistent')
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=consistent')
    // 固定は、結果の到着で巻き戻らない。
    expect(row('stop-lunch')).toContain('固定:true')
  })

  it('照合中に内容が変わったときは、結果を採用せず、中止の理由を出す。変更後の旅程の根拠は取り下げの判断を受ける', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    script.queue.push(rename('stop-lunch', '別の昼食店'))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await user.click(verifyButton())

    await change(user)
    await act(async () => pending.resolve({ ok: true, trip: serverVerified(generated) }))

    expect(panel().getByRole('alert').textContent).toContain('確認を中止しました')
    expect(statusText()).toContain('未確認')
    expect(row('stop-lunch')).toContain('Place ID:なし')
    expect(row('stop-lunch')).toContain('根拠:なし')
  })

  it('本人の報告・模擬データの根拠がある旅程でも、照合の件数には数えず、別に数える', async () => {
    const withReport = {
      ...generated,
      stops: generated.stops.map((stop) =>
        stop.id === 'stop-lunch' ? { ...stop, evidence: [userReport()] } : stop,
      ),
    }
    const user = userEvent.setup()
    render(<VerifiableTrip trip={withReport} verify={verifySequence({})} />)

    await verified(user)

    // 照合した根拠：施設3＋営業3＋移動2＝8件。本人の報告1件は含めない。
    expect(statusText()).toBe('状態：照合結果あり（根拠 8件）')
    expect(panelText()).toContain('ほかに、公式情報・本人の報告・模擬データ由来の根拠が1件')
  })
})

describe('部分修正の根拠だけがある、まだ照合していない旅程', () => {
  it('旅程全体は未確認のまま。部分修正の候補の根拠が付いていることを、矛盾なく伝える', async () => {
    script.queue.push((shown) =>
      revisedStop(shown, 'stop-lunch', '昼食店B', '2026-11-08T11:00:00+09:00'),
    )
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verifySequence({})} />)

    await change(user)

    expect(statusText()).toContain('未確認')
    expect(statusText()).not.toContain('照合結果あり')
    expect(panelText()).toContain('部分修正の候補を確認したときの根拠（Google由来 4件）')
    expect(panelText()).toContain('旅程全体は、まだ照合していません')
    // 部分修正の根拠は、旅程には残っている。
    expect(row('stop-lunch')).toContain('evidence-stop-lunch-place=consistent')
  })

  it('根拠が無い未照合の旅程では、その案内を出さない', () => {
    render(<VerifiableTrip trip={generated} verify={verifySequence({})} />)
    expect(panelText()).not.toContain('部分修正の候補')
  })
})
