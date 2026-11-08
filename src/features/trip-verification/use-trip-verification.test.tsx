// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import type { VerificationResult } from './api-client'
import { useTripVerification, type VerifyTrip } from './use-trip-verification'
import { VerificationPanel } from './verification-panel'
import type { VerificationSummary } from './verification-summary'

// 保護APIのヘッダー（Bearer＋App Check）はモックし、既定の照合の経路は実物を通す。
const protectedApi = vi.hoisted(() => ({ getProtectedApiHeaders: vi.fn() }))
vi.mock('@/lib/auth/protected-api', () => ({
  getProtectedApiHeaders: protectedApi.getProtectedApiHeaders,
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useTripVerification: 既定の照合', () => {
  it('verifyを省略しても、Bearer と App Check の両方を付けて送る', async () => {
    protectedApi.getProtectedApiHeaders.mockResolvedValue(
      new Headers({
        Authorization: 'Bearer test.id.token',
        'X-Firebase-AppCheck': 'test.app.check',
      }),
    )
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchFn)
    const { result } = renderHook(() => useTripVerification())

    await act(async () => {
      await result.current.run(sampleTrip)
    })
    const headers = new Headers(fetchFn.mock.calls[0][1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer test.id.token')
    expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
  })

  it('ヘッダーを用意できなければ、既定でも送信しない', async () => {
    protectedApi.getProtectedApiHeaders.mockRejectedValue(new Error('x'))
    const fetchFn = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchFn)
    const { result } = renderHook(() => useTripVerification())

    await act(async () => {
      await result.current.run(sampleTrip)
    })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(result.current.state).toMatchObject({ phase: 'failed' })
  })
})

describe('useTripVerification', () => {
  it('実行中の再送信は受け付けず、APIを1回だけ呼ぶ', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const { result } = renderHook(() => useTripVerification(verify))

    let first!: Promise<unknown>
    let second!: Promise<unknown>
    act(() => {
      first = result.current.run(sampleTrip)
      second = result.current.run(sampleTrip)
    })
    expect(verify).toHaveBeenCalledOnce()
    expect(await second).toBeNull()

    await act(async () => pending.resolve({ ok: true, trip: sampleTrip }))
    expect(await first).toBe(sampleTrip)
    expect(result.current.state).toEqual({ phase: 'idle' })
  })

  it('失敗は種類ごとに state に出し、成功を返さない。次の実行ができる', async () => {
    const verify = vi
      .fn<VerifyTrip>()
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'service_unavailable', message: '停止中' },
      })
      .mockResolvedValueOnce({ ok: true, trip: sampleTrip })
    const { result } = renderHook(() => useTripVerification(verify))

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.run(sampleTrip)
    })
    expect(outcome).toBeNull()
    expect(result.current.state).toEqual({
      phase: 'failed',
      failure: { kind: 'service_unavailable', message: '停止中' },
    })

    await act(async () => {
      outcome = await result.current.run(sampleTrip)
    })
    expect(outcome).toBe(sampleTrip)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('cancel で通信を中止し、その結果は返さず、すぐ次の実行ができる', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi
      .fn<VerifyTrip>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, trip: sampleTrip })
    const { result } = renderHook(() => useTripVerification(verify))

    let cancelled!: Promise<unknown>
    act(() => {
      cancelled = result.current.run(sampleTrip)
    })
    let aborted: boolean | undefined
    act(() => {
      aborted = result.current.cancel()
    })
    // 進行中の確認を中止したことが分かる（呼び出し側が、中止した理由を利用者に伝えるため）。
    expect(aborted).toBe(true)
    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(result.current.state).toEqual({ phase: 'idle' })

    let next: unknown
    await act(async () => {
      next = await result.current.run(sampleTrip)
    })
    expect(next).toBe(sampleTrip)

    await act(async () => pending.resolve({ ok: true, trip: sampleTrip }))
    expect(await cancelled).toBeNull()
  })

  it('進行中でなければ、cancel は何も中止していないと返す', async () => {
    const verify = vi.fn<VerifyTrip>().mockResolvedValue({ ok: true, trip: sampleTrip })
    const { result } = renderHook(() => useTripVerification(verify))

    let before: boolean | undefined
    act(() => {
      before = result.current.cancel()
    })
    expect(before).toBe(false)

    // 完了した後も、中止するものはない。
    await act(async () => {
      await result.current.run(sampleTrip)
    })
    let after: boolean | undefined
    act(() => {
      after = result.current.cancel()
    })
    expect(after).toBe(false)
  })

  it('画面を離れたら通信を中止する', () => {
    const verify = vi.fn<VerifyTrip>().mockReturnValue(new Promise(() => {}))
    const { result, unmount } = renderHook(() => useTripVerification(verify))
    act(() => {
      void result.current.run(sampleTrip)
    })
    unmount()
    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
})

describe('VerificationPanel のボタン', () => {
  it('確認中は押しても onVerify を呼ばず、フォーカスと名前を保つ', async () => {
    const onVerify = vi.fn()
    render(
      <VerificationPanel
        status={{ kind: 'unverified' }}
        interrupted={false}
        phase={{ phase: 'verifying' }}
        onVerify={onVerify}
      />,
    )
    const button = screen.getByRole('button', { name: '確認しています…' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await userEvent.setup().click(button)
    expect(onVerify).not.toHaveBeenCalled()
  })

  it('未確認なら押せて、onVerify を1回呼ぶ', async () => {
    const onVerify = vi.fn()
    render(
      <VerificationPanel
        status={{ kind: 'unverified' }}
        interrupted={false}
        phase={{ phase: 'idle' }}
        onVerify={onVerify}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: '根拠を確認する' }))
    expect(onVerify).toHaveBeenCalledOnce()
  })
})

describe('VerificationPanel の通知', () => {
  const summary: VerificationSummary = {
    google: {
      counts: { consistent: 2, conflicting: 1, unverifiable: 1 },
      total: 4,
      latestCheckedAt: '2026-11-08T10:01:00+09:00',
      earliestCheckedAt: '2026-11-08T10:00:00+09:00',
      bySubject: { place_identity: 2, opening_hours: 0, travel_time: 2 },
    },
    otherTotal: 0,
  }

  it('結果の通知（status）は状態の1文だけ。内訳・範囲の説明は通知の外に置く', () => {
    render(
      <VerificationPanel
        status={{ kind: 'verified', summary }}
        interrupted={false}
        phase={{ phase: 'idle' }}
        onVerify={vi.fn()}
      />,
    )
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('状態：照合結果あり（根拠 4件）')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    const panel = screen.getByRole('region', { name: '根拠の確認' }).textContent ?? ''
    expect(panel).toContain('根拠 4件の内訳')
    expect(panel).toContain('予定の数ではありません')
    expect(panel).toContain('営業時間：照合していません（未確認）')
    expect(panel).toContain('確認していないこと')
  })

  it('中止の通知は role="alert" で、結果の通知の外に出す。確認中は出さない', () => {
    const { rerender } = render(
      <VerificationPanel
        status={{ kind: 'unverified' }}
        interrupted
        phase={{ phase: 'idle' }}
        onVerify={vi.fn()}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('確認を中止しました')
    expect(alert.textContent).toContain('最新の内容で照合し直してください')
    expect(screen.getByRole('status').contains(alert)).toBe(false)

    rerender(
      <VerificationPanel
        status={{ kind: 'unverified' }}
        interrupted
        phase={{ phase: 'verifying' }}
        onVerify={vi.fn()}
      />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('失敗は role="alert" で、結果の通知（status）には載せない', () => {
    render(
      <VerificationPanel
        status={{ kind: 'unverified' }}
        interrupted={false}
        phase={{ phase: 'failed', failure: { kind: 'service_unavailable', message: '停止中' } }}
        onVerify={vi.fn()}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('停止中')
    expect(screen.getByRole('status').textContent).not.toContain('停止中')
    expect(screen.getByRole('button', { name: 'もう一度確認する' })).toBeTruthy()
  })
})
