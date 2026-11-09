// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VerificationFailureKind } from './api-client'
import { verificationFailureGuidance } from './failure-messages'
import type { VerificationPhase } from './use-trip-verification'
import { VerificationPanel, type PanelStatus } from './verification-panel'
import type { VerificationSummary } from './verification-summary'

afterEach(() => cleanup())

const google = (overrides: Partial<VerificationSummary['google']> = {}) => ({
  counts: { consistent: 2, conflicting: 1, unverifiable: 1 },
  total: 4,
  latestCheckedAt: '2026-11-08T10:01:00+09:00',
  earliestCheckedAt: '2026-11-08T10:01:00+09:00',
  bySubject: { place_identity: 2, opening_hours: 0, travel_time: 2 },
  ...overrides,
})

const summary = (
  overrides: Partial<VerificationSummary['google']> = {},
  otherTotal = 0,
): VerificationSummary => ({ google: google(overrides), otherTotal })

const noGoogle = (otherTotal = 0): VerificationSummary => ({
  google: google({
    counts: { consistent: 0, conflicting: 0, unverifiable: 0 },
    total: 0,
    latestCheckedAt: null,
    earliestCheckedAt: null,
    bySubject: { place_identity: 0, opening_hours: 0, travel_time: 0 },
  }),
  otherTotal,
})

function renderPanel(
  status: PanelStatus,
  phase: VerificationPhase = { phase: 'idle' },
  interrupted = false,
) {
  return render(
    <VerificationPanel
      status={status}
      phase={phase}
      interrupted={interrupted}
      onVerify={vi.fn()}
    />,
  )
}

const regionText = () => screen.getByRole('region', { name: '根拠の確認' }).textContent ?? ''
const statusText = () => screen.getByRole('status').textContent ?? ''
const failed = (
  kind: VerificationFailureKind,
  message = 'サーバーからの説明',
): VerificationPhase => ({
  phase: 'failed',
  failure: { kind, message },
})

describe('VerificationPanel: 照合した項目・未確認の項目・照合日時', () => {
  it('項目ごとの件数と、照合していない項目（未確認）を区別して示す', () => {
    renderPanel({ kind: 'verified', summary: summary() })

    const text = regionText()
    expect(text).toContain('施設の存在（名称と地域）：2件')
    expect(text).toContain('通常の営業時間：照合していません（未確認）')
    expect(text).toContain('徒歩での移動：2件')
    expect(text).toContain('2026/11/08 10:01時点')
  })

  it('照合日時が根拠によって違うときは、最も古い根拠の日時も示す', () => {
    renderPanel({
      kind: 'partial',
      summary: summary({ earliestCheckedAt: '2026-11-08T09:30:00+09:00' }),
    })

    const text = regionText()
    expect(text).toContain('2026/11/08 10:01時点')
    expect(text).toContain('最も古い根拠は2026/11/08 9:30の照合')
  })

  it('Google由来の内容だけを枠（帰属つき）に入れ、本人の報告・模擬データ等は枠の外で、照合の結果ではないと伝える', () => {
    renderPanel({ kind: 'verified', summary: summary({}, 3) })

    const box = screen.getByRole('group', { name: '確認に使った情報源' })
    expect(within(box).getByRole('img', { name: 'Google Maps' })).toBeTruthy()
    const other = screen.getByText(/ほかに、公式情報・本人の報告・模擬データ由来の根拠が3件/)
    expect(other.textContent).toContain('Google Mapsでの照合の結果ではありません')
    expect(box.contains(other)).toBe(false)
  })

  it('照合の根拠が無く、本人の報告などだけがあるときは、Google の枠も帰属も出さない', () => {
    renderPanel({ kind: 'verified', summary: noGoogle(2) })

    expect(screen.queryByRole('group', { name: '確認に使った情報源' })).toBeNull()
    expect(document.querySelector('[translate="no"]')).toBeNull()
    expect(regionText()).toContain('ほかに、公式情報・本人の報告・模擬データ由来の根拠が2件')
  })
})

describe('VerificationPanel: 外部の情報源に1件も照会しなかったとき', () => {
  it('施設・営業時間・徒歩移動を確認したように表示しない', () => {
    renderPanel({ kind: 'verified', summary: noGoogle() })

    expect(statusText()).toBe('状態：照合しましたが、外部の情報源に照会した項目はありません')
    const text = regionText()
    expect(text).toContain('照会は行われませんでした')
    expect(text).toContain('いずれも照合していません（未確認）')
    expect(text).not.toContain('照合結果あり')
    expect(text).not.toContain('根拠 0件の内訳')
    expect(text).not.toContain('情報源と整合 0件')
    // 帰属表示の枠は、Google由来の内容があるときだけ。
    expect(screen.queryByRole('group', { name: '確認に使った情報源' })).toBeNull()
  })
})

describe('VerificationPanel: 旅程の内容が変わった後', () => {
  it('一部の根拠が残っているとき：取り下げた理由と、残した根拠があることを示す', () => {
    renderPanel({ kind: 'partial', summary: summary({ total: 2 }) })

    expect(statusText()).toBe('状態：変更後の一部は未確認（残っている根拠 2件）')
    const text = regionText()
    expect(text).toContain('変更の影響を受けた予定の根拠は取り下げ、未確認に戻しました')
    expect(text).toContain('照合日時つきで残しています')
    expect(screen.getByRole('button', { name: 'もう一度確認する' })).toBeTruthy()
  })

  it('照合の根拠がすべてなくなったとき：変更後は未確認', () => {
    renderPanel({ kind: 'withdrawn' })

    expect(statusText()).toBe('状態：変更後は未確認')
    expect(regionText()).toContain('前回の照合結果は取り下げました')
    expect(screen.getByRole('button', { name: '根拠を確認する' })).toBeTruthy()
  })
})

describe('VerificationPanel: まだ照合していないとき', () => {
  it('部分修正の候補の根拠だけがあるときは、その件数と、旅程全体は未照合であることを伝える', () => {
    renderPanel({ kind: 'unverified', googleTotal: 3 })

    expect(statusText()).toBe('状態：未確認')
    expect(regionText()).toContain('部分修正の候補を確認したときの根拠（Google由来 3件）')
    expect(regionText()).toContain('旅程全体は、まだ照合していません')
  })

  it('根拠が無いとき（0件・指定なし）は、その案内を出さない', () => {
    for (const status of [
      { kind: 'unverified' },
      { kind: 'unverified', googleTotal: 0 },
    ] as const) {
      cleanup()
      renderPanel(status)
      expect(regionText()).not.toContain('部分修正の候補')
    }
  })
})

describe('VerificationPanel: 再照合の失敗', () => {
  it('以前の照合結果を表示しているとき：以前の結果であること（照合日時つき）と、今回は反映していないことを伝え、「未確認のまま」とは言わない', () => {
    renderPanel({ kind: 'verified', summary: summary() }, failed('service_unavailable'))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(
      '表示中の根拠は、以前の照合結果です（2026/11/08 10:01時点）',
    )
    expect(alert.textContent).toContain('今回の確認は反映していません')
    expect(alert.textContent).not.toContain('未確認のまま')
    expect(statusText()).toBe('状態：以前の照合結果を表示中（2026/11/08 10:01時点）')
    // 以前の結果は、消さずに表示している。
    expect(regionText()).toContain('施設の存在（名称と地域）：2件')
  })

  it('変更後に一部が残っている状態で失敗したときも、残っている根拠は以前の照合結果と伝える', () => {
    renderPanel(
      { kind: 'partial', summary: summary({ total: 2 }) },
      failed('external_service_error'),
    )

    expect(screen.getByRole('alert').textContent).toContain('以前の照合結果です')
    expect(screen.getByRole('alert').textContent).not.toContain('未確認のまま')
  })

  it('表示している照合の根拠が無いとき：根拠は未確認のままと伝える（以前の結果とは言わない）', () => {
    for (const status of [
      { kind: 'unverified' },
      { kind: 'withdrawn' },
      { kind: 'verified', summary: noGoogle() },
    ] satisfies PanelStatus[]) {
      cleanup()
      renderPanel(status, failed('service_unavailable'))
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toContain('根拠は未確認のままです')
      expect(alert.textContent).not.toContain('以前の照合結果')
    }
  })

  it('401・403（認証）、429（利用制限）、送信しなかった認証失敗は、それぞれ別の文言で案内し、旅程が変わらないことを伝える', () => {
    const titles = new Set<string>()
    for (const [kind, expected] of [
      ['unauthorized', '認証、招待、またはアプリの検証が通らず、根拠を確認できませんでした'],
      ['rate_limited', '利用の回数が上限に達したため、根拠を確認できませんでした'],
      ['auth_required', '認証情報を取得できず、根拠の確認を送信しませんでした'],
    ] as const) {
      cleanup()
      renderPanel({ kind: 'unverified' }, failed(kind))
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toContain(expected)
      expect(alert.textContent).toContain('旅程はそのまま')
      expect(alert.textContent).toContain('エラー：')
      titles.add(verificationFailureGuidance[kind].title)
    }
    expect(titles.size).toBe(3)
    // 送信しなかった場合は、外部へ問い合わせていないことも伝える。
    expect(verificationFailureGuidance.auth_required.action).toContain('問い合わせていません')
  })

  it('どの失敗の案内も、「未確認のまま」を単独では言わない（表示中の状態と矛盾させない）', () => {
    for (const guidance of Object.values(verificationFailureGuidance)) {
      expect(guidance.action).not.toContain('未確認のまま')
    }
  })
})

describe('VerificationPanel: 説明の正確さ', () => {
  it('アプリのサーバーへの依頼は1回で、サーバーが外部へ複数回問い合わせることを伝える（外部の呼び出しが1回とは言わない）', () => {
    renderPanel({ kind: 'unverified' })

    expect(
      screen.getByText(/予定の施設・営業時間・移動時間を外部の情報源で確認します/),
    ).toBeTruthy()
    expect(screen.getByText('確認に使う情報源と仕組み').closest('details')?.open).toBe(false)
    const text = regionText()
    expect(text).toContain('このアプリのサーバーへ、照合を1回依頼します')
    expect(text).toContain('予定の数に応じて')
    expect(text).toContain('複数回問い合わせます')
    expect(text).not.toContain('1回だけ、外部の情報源')
  })

  it('照合は、旅程の確定・予約・保存を意味しないと伝える（どの状態でも）', () => {
    for (const status of [
      { kind: 'unverified' },
      { kind: 'withdrawn' },
      { kind: 'verified', summary: summary() },
      { kind: 'verified', summary: noGoogle() },
      { kind: 'partial', summary: summary() },
    ] satisfies PanelStatus[]) {
      cleanup()
      renderPanel(status)
      expect(regionText()).toContain('旅程を確定・予約・保存するものではありません')
    }
  })

  it('「情報源と整合」を正しさの保証と受け取らせない（照合した結果があるとき）', () => {
    renderPanel({ kind: 'verified', summary: summary() })

    expect(regionText()).toContain('現実の正しさや当日の営業を保証するものではありません')
    expect(regionText()).toContain('確認していないこと：臨時休業・混雑・公共交通')
  })
})
