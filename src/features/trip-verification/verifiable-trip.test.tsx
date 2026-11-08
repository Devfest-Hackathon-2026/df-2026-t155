// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TripSchema, type Evidence, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'
import { setStopFixed } from '@/features/trip-map/model'

import type { VerificationResult } from './api-client'
import type { VerifyTrip } from './use-trip-verification'
import { VerifiableTrip } from './verifiable-trip'

// 路線図の代役。親へ「旅程が変わった」ことを伝える操作だけを持つ。
// 実際のトップ画面では、旅程の内容が変わる操作（部分修正の適用）がまだ接続されていないため、
// 内容の変更は、この代役から adoptTripChange を呼んで再現する。
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
    const change = (next: Trip) => setLocal({ source: trip, trip: adoptTripChange?.(next) ?? next })
    const lunch = shown.stops.find((stop) => stop.id === 'stop-lunch')!
    return (
      <div>
        <ul aria-label="予定">
          {shown.stops.map((stop) => (
            <li key={stop.id}>
              {stop.name}／根拠{stop.evidence.length}件／{stop.isFixed ? '固定' : '固定なし'}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() =>
            change({
              ...shown,
              version: shown.version + 1,
              stops: shown.stops.map((stop, index) =>
                index === 0 ? { ...stop, name: '変更後の名称' } : stop,
              ),
            })
          }
        >
          内容を変更する
        </button>
        <button
          type="button"
          onClick={() => change(setStopFixed(shown, lunch.id, !lunch.isFixed)!)}
        >
          昼食の固定を切り替える
        </button>
        <button
          type="button"
          onClick={() => change({ ...shown, version: shown.version + 1, date: '2026-11-09' })}
        >
          日付を変更する
        </button>
      </div>
    )
  },
}))

afterEach(() => cleanup())

const generated = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
})

// 照合の結果の模擬：送られた旅程の各予定に、根拠を1件ずつ付ける（idの接頭辞で、どの照合の結果か区別する）。
function verifiedFrom(trip: Trip, tag = 'a'): Trip {
  return TripSchema.parse({
    ...trip,
    stops: trip.stops.map((stop) => ({
      ...stop,
      placeId: `place-${stop.id}`,
      evidence: [
        {
          id: `evidence-${tag}-${stop.id}`,
          subject: 'place_identity',
          claim: `${stop.name}は、旅行先の地域に実在する施設として確認できる`,
          applicability: '名称の完全一致と地域の住所で確認',
          source: { kind: 'places', label: 'Google Places' },
          checkedAt: '2026-11-08T10:00:00+09:00',
          status: 'consistent',
          explanation: '名称と所在地が候補と一致した',
        } satisfies Evidence,
      ],
    })),
  })
}

const panel = () => within(screen.getByRole('region', { name: '根拠の確認' }))
const statusText = () => panel().getByRole('status').textContent ?? ''
const list = () => within(screen.getByRole('list', { name: '予定' }))
const verifyButton = (name: string = '根拠を確認する') => screen.getByRole('button', { name })
const changeContent = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: '内容を変更する' }))
const toggleLunch = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: '昼食の固定を切り替える' }))

describe('VerifiableTrip: 旅程の内容が変わったとき', () => {
  it('確認中に内容が変わると、通信を中止して結果を採用せず、理由を role="alert" で出す', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)

    await user.click(verifyButton())
    await changeContent(user)

    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(true)
    // 黙って「未確認」へ戻らない：中止した理由と、次にとる行動を出す。
    const alert = panel().getByRole('alert')
    expect(alert.textContent).toContain('確認を中止しました')
    expect(alert.textContent).toContain('照合中に旅程の内容が変わりました')
    expect(alert.textContent).toContain('最新の内容で照合し直してください')
    // 結果の通知（status）とは別の要素で、通知の読み上げを重くしない。
    expect(panel().getByRole('status').contains(alert)).toBe(false)

    // 遅れて届いた結果は採用しない。
    await act(async () => pending.resolve({ ok: true, trip: verifiedFrom(generated) }))
    expect(statusText()).toContain('未確認')
    expect(statusText()).not.toContain('照合結果あり')
    expect(list().getByText(/変更後の名称／根拠0件/)).toBeTruthy()
    expect(panel().getByRole('alert')).toBeTruthy()
    expect(verifyButton()).toBeTruthy()
  })

  it('もう一度「根拠を確認する」を押すと中止の通知は消え、変更後の旅程を送る', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi
      .fn<VerifyTrip>()
      .mockReturnValueOnce(pending.promise)
      .mockImplementationOnce(async (trip) => ({ ok: true, trip: verifiedFrom(trip) }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)

    await user.click(verifyButton())
    await changeContent(user)
    expect(panel().getByRole('alert')).toBeTruthy()

    await user.click(verifyButton())
    expect(panel().queryByRole('alert')).toBeNull()
    expect((verify.mock.calls[1][0] as Trip).stops[0].name).toBe('変更後の名称')
    expect(await panel().findByText(/照合結果あり/)).toBeTruthy()
    expect(panel().queryByRole('alert')).toBeNull()
  })

  it('確認中でなければ、内容が変わっても中止の通知は出さない', async () => {
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={vi.fn<VerifyTrip>()} />)

    await changeContent(user)

    expect(statusText()).toContain('未確認')
    expect(panel().queryByRole('alert')).toBeNull()
  })

  it('照合済みの旅程の内容が変わると、変更の影響を受けた予定の根拠だけを取り下げ、「変更後の一部は未確認」にする', async () => {
    const verify = vi.fn<VerifyTrip>().mockImplementation(async (trip) => ({
      ok: true,
      trip: verifiedFrom(trip),
    }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await user.click(verifyButton())
    await panel().findByText(/照合結果あり/)
    expect(list().getAllByText(/根拠1件/)).toHaveLength(3)

    // 1番目の予定の名称を変える（影響を受けるのは、その予定の施設の根拠だけ）。
    await changeContent(user)

    expect(statusText()).toContain('変更後の一部は未確認')
    expect(statusText()).toContain('残っている根拠 2件')
    expect(statusText()).not.toContain('照合結果あり')
    expect(list().getByText(/変更後の名称／根拠0件/)).toBeTruthy()
    expect(list().getAllByText(/根拠1件/)).toHaveLength(2)
    // 取り下げた理由と、残した根拠があることを伝える。
    expect(panel().getByText(/変更の影響を受けた予定の根拠は取り下げ/)).toBeTruthy()
    // 確認中ではなかったので、中止の通知は出さない。
    expect(panel().queryByRole('alert')).toBeNull()
  })

  it('照合結果の根拠がすべて取り下げられたときは、「変更後は未確認」に戻る', async () => {
    const verify = vi.fn<VerifyTrip>().mockImplementation(async (trip) => ({
      ok: true,
      trip: verifiedFrom(trip),
    }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await user.click(verifyButton())
    await panel().findByText(/照合結果あり/)

    // 旅程の日付が変わると、どの予定の根拠も、照合した時の旅程のものではなくなる。
    await user.click(screen.getByRole('button', { name: '日付を変更する' }))

    expect(statusText()).toContain('変更後は未確認')
    expect(statusText()).not.toContain('照合結果あり')
    expect(list().getAllByText(/根拠0件/)).toHaveLength(3)
    expect(panel().getByText(/前回の照合結果は取り下げました/)).toBeTruthy()
  })

  it('再確認した結果の根拠を取り下げても、前回の結果ではなく、最新の照合結果に対する判断になる', async () => {
    const verify = vi
      .fn<VerifyTrip>()
      .mockImplementationOnce(async (trip) => ({ ok: true, trip: verifiedFrom(trip, 'first') }))
      .mockImplementationOnce(async (trip) => ({ ok: true, trip: verifiedFrom(trip, 'second') }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await user.click(verifyButton())
    await panel().findByText(/照合結果あり/)
    await user.click(verifyButton('もう一度確認する'))
    await panel().findByText(/照合結果あり/)
    expect(verify).toHaveBeenCalledTimes(2)

    await changeContent(user)

    // 1番目の予定の根拠は取り下げる。2回目の結果（残った分）は、1回目の結果に置き換わらない。
    expect(list().getByText(/変更後の名称／根拠0件/)).toBeTruthy()
    expect(list().getAllByText(/根拠1件/)).toHaveLength(2)
    expect(screen.getByRole('list', { name: '予定' }).textContent).not.toContain('first')
  })

  it('結果の内容が送った旅程と違っていれば取り込まず、理由を出す', async () => {
    const verify = vi.fn<VerifyTrip>().mockImplementation(async (trip) => {
      const renamed = verifiedFrom(trip)
      return {
        ok: true,
        trip: {
          ...renamed,
          stops: renamed.stops.map((stop, index) =>
            index === 0 ? { ...stop, name: '違う目的地' } : stop,
          ),
        },
      }
    })
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)

    await user.click(verifyButton())

    expect(await panel().findByRole('alert')).toBeTruthy()
    expect(panel().getByRole('alert').textContent).toContain('最新の内容で照合し直してください')
    expect(statusText()).toContain('未確認')
    expect(list().queryByText(/違う目的地/)).toBeNull()
    expect(list().getAllByText(/根拠0件/)).toHaveLength(3)
  })
})

describe('VerifiableTrip: 固定だけが変わったとき', () => {
  it('照合済みなら、取り下げず、根拠を残して固定だけを反映する', async () => {
    const verify = vi.fn<VerifyTrip>().mockImplementation(async (trip) => ({
      ok: true,
      trip: verifiedFrom(trip),
    }))
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await user.click(verifyButton())
    await panel().findByText(/照合結果あり/)

    await toggleLunch(user)

    expect(statusText()).toBe('状態：照合結果あり（根拠 3件）')
    expect(list().getByText(/昼食店A（架空）／根拠1件／固定$/)).toBeTruthy()
    expect(list().getAllByText(/根拠1件/)).toHaveLength(3)
    expect(panel().queryByRole('alert')).toBeNull()

    // 解除しても同じ。
    await toggleLunch(user)
    expect(statusText()).toBe('状態：照合結果あり（根拠 3件）')
    expect(list().getByText(/昼食店A（架空）／根拠1件／固定なし$/)).toBeTruthy()
  })

  it('確認中なら、通信を中止せず、結果の到着後も固定が残る', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await user.click(verifyButton())

    await toggleLunch(user)
    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(false)
    expect(panel().queryByRole('alert')).toBeNull()

    await act(async () => pending.resolve({ ok: true, trip: verifiedFrom(generated) }))

    expect(statusText()).toBe('状態：照合結果あり（根拠 3件）')
    expect(list().getByText(/昼食店A（架空）／根拠1件／固定$/)).toBeTruthy()
    expect(verify).toHaveBeenCalledOnce()
  })

  it('確認中に固定を切り替えたあと、内容も変わったときは、結果を採用せず理由を出す', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const user = userEvent.setup()
    render(<VerifiableTrip trip={generated} verify={verify} />)
    await user.click(verifyButton())
    await toggleLunch(user)

    await changeContent(user)

    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(panel().getByRole('alert').textContent).toContain('確認を中止しました')
    await act(async () => pending.resolve({ ok: true, trip: verifiedFrom(generated) }))
    expect(statusText()).toContain('未確認')
    expect(list().getAllByText(/根拠0件/)).toHaveLength(3)
  })
})
