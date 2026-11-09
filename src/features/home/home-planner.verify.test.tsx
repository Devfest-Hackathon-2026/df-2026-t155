// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TripSchema, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'
import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'
import type { VerificationResult } from '@/features/trip-verification/api-client'
import type { VerifyTrip } from '@/features/trip-verification/use-trip-verification'

import { noSavedLearnings } from '../../../tests/helpers/home-session'

import { HomePlanner } from './home-planner'

// 認証済みの利用者として扱う（認証SDKは使わない）。
vi.mock(
  '@/lib/auth/use-session-scope',
  async () => (await import('../../../tests/helpers/home-session')).sessionScopeModule,
)

// 保護APIのヘッダー（Bearer＋App Check）はモックし、送信までの経路は実物を通す。
const protectedApi = vi.hoisted(() => ({ getProtectedApiHeaders: vi.fn() }))
vi.mock('@/lib/auth/protected-api', () => ({
  getProtectedApiHeaders: protectedApi.getProtectedApiHeaders,
}))

beforeEach(() => {
  protectedApi.getProtectedApiHeaders.mockReset()
  protectedApi.getProtectedApiHeaders.mockImplementation(
    async () =>
      new Headers({
        Authorization: 'Bearer test.id.token',
        'X-Firebase-AppCheck': 'test.app.check',
      }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// 生成直後の旅程：AIの提案であり、未照合（根拠は空）。朝と14時の予定は固定、昼食は固定でない。
const generatedTrip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
})
const secondTrip = TripSchema.parse({ ...generatedTrip, id: 'trip-second', version: 0 })

// 照合APIが返す旅程の模擬：送られた旅程に、根拠とPlace IDだけを付ける。
function verifiedFrom(trip: Trip): Trip {
  return TripSchema.parse({
    ...trip,
    stops: trip.stops.map((stop, index) => ({
      ...stop,
      placeId: `place-${stop.id}`,
      evidence:
        index === 0
          ? []
          : [
              {
                id: `evidence-${stop.id}-identity`,
                subject: 'place_identity',
                claim: `${stop.name}は、旅行先の地域に実在する施設として確認できる`,
                applicability: '名称の完全一致と地域の住所で確認',
                source: { kind: 'places', label: 'Google Places' },
                checkedAt: '2026-11-08T10:00:00+09:00',
                status: 'consistent',
                explanation: '名称と所在地が候補と一致した',
              },
              {
                id: `evidence-${stop.id}-travel`,
                subject: 'travel_time',
                claim: '前の予定から徒歩で移動できる',
                applicability: '徒歩のみ。公共交通は確認していない',
                source: { kind: 'routes', label: 'Google Routes' },
                checkedAt: '2026-11-08T10:01:00+09:00',
                status: index === 1 ? 'conflicting' : 'unverifiable',
                explanation: index === 1 ? '余裕が足りない' : '施設を特定できないため確認できない',
              },
            ],
    })),
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// 送られた旅程をそのまま返し、根拠だけを付ける模擬サーバー。
const echoServer = () =>
  vi.fn(async (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)).trip as Trip
    return json({ status: 'verified', trip: verifiedFrom(TripSchema.parse(sent)) })
  })

async function showGeneratedTrip(
  user: ReturnType<typeof userEvent.setup>,
  verify?: VerifyTrip,
  generate: GenerateTrip = vi
    .fn<GenerateTrip>()
    .mockResolvedValue({ ok: true, trip: generatedTrip }),
) {
  render(<HomePlanner generate={generate} verify={verify} loadLearnings={noSavedLearnings} />)
  await user.type(screen.getByLabelText(/旅行先/), '京都市東山エリア')
  fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
  await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
  await screen.findByRole('list', { name: '旅程の路線図' })
}

const panel = () => within(screen.getByRole('region', { name: '根拠の確認' }))
const panelText = () => screen.getByRole('region', { name: '根拠の確認' }).textContent ?? ''
// 結果の通知（読み上げの対象）。状態の1文だけを載せる。
const statusText = () => panel().getByRole('status').textContent ?? ''
const route = () => within(screen.getByRole('list', { name: '旅程の路線図' }))
const verifyButton = (name: string | RegExp = '根拠を確認する') =>
  screen.getByRole<HTMLButtonElement>('button', { name })

describe('HomePlanner: 根拠の確認（照合）', () => {
  it('照合前は「未確認」と表示し、自動では照合APIを呼ばない', async () => {
    const fetchFn = vi.fn()
    vi.stubGlobal('fetch', fetchFn)
    const user = userEvent.setup()
    await showGeneratedTrip(user)

    expect(panel().getByRole('status').textContent).toContain('未確認')
    expect(panel().getByRole('status').textContent).not.toContain('照合結果あり')
    expect(verifyButton()).toBeTruthy()
    expect(route().getAllByText('未照合')).toHaveLength(3)
    // 照合前はGoogle由来の内容がないので、帰属表示も出さない。
    expect(document.querySelector('[translate="no"]')).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('押すと照合APIを1回呼び、路線図に根拠を出す。「整合」を正しさの保証と言わず、範囲を示す', async () => {
    const fetchFn = echoServer()
    vi.stubGlobal('fetch', fetchFn)
    const user = userEvent.setup()
    await showGeneratedTrip(user)

    await user.click(verifyButton())

    await waitFor(() => expect(panel().getByRole('status').textContent).toContain('照合結果あり'))
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/trips/verify')
    expect(JSON.parse(String(init?.body)).trip.id).toBe(generatedTrip.id)

    // 件数の単位は根拠の数（予定の数ではない）。内訳・範囲の説明は、読み上げる通知の外に置く。
    const text = panelText()
    expect(text).toContain('根拠 4件の内訳')
    expect(text).toContain('情報源と整合 2件')
    expect(text).toContain('矛盾あり 1件')
    expect(text).toContain('確認できない 1件')
    expect(text).toContain('2026/11/08 10:01時点')
    expect(text).toContain('予定の数ではありません')
    // 照合した項目と、照合していない項目（この模擬の結果には営業時間が無い）を区別する。
    expect(text).toContain('施設の存在（名称と地域）：2件')
    expect(text).toContain('通常の営業時間：照合していません（未確認）')
    expect(text).toContain('徒歩での移動：2件')
    expect(text).toContain('確認していないこと：臨時休業・混雑・公共交通')
    expect(text).toContain('保証するものではありません')
    expect(text).not.toContain('正しい')
    expect(statusText()).toBe('状態：照合結果あり（根拠 4件）')
    // 路線図の予定ごとに、根拠の状態が出る。照合前の「未照合」は、根拠のある予定から消える。
    expect(route().getByRole('button', { name: /昼食店A.*矛盾あり/ })).toBeTruthy()
    expect(route().getAllByText('未照合')).toHaveLength(1)
    expect(verifyButton('もう一度確認する')).toBeTruthy()
  })

  it('既定の照合は、Authorization と X-Firebase-AppCheck の両方を付けて送る', async () => {
    const fetchFn = echoServer()
    vi.stubGlobal('fetch', fetchFn)
    const user = userEvent.setup()
    await showGeneratedTrip(user)
    await user.click(verifyButton())
    await panel().findByText(/照合結果あり/)

    const headers = new Headers(fetchFn.mock.calls[0][1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer test.id.token')
    expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
  })

  it('App Checkを用意できなければ照合APIを呼ばず、区別した案内を出し、旅程はそのまま。自動では再送しない', async () => {
    const fetchFn = echoServer()
    vi.stubGlobal('fetch', fetchFn)
    protectedApi.getProtectedApiHeaders.mockRejectedValue(
      Object.assign(new Error('secret-detail'), { name: 'AppCheckUnavailableError' }),
    )
    const user = userEvent.setup()
    await showGeneratedTrip(user)
    await user.click(verifyButton())

    const alert = await panel().findByRole('alert')
    expect(alert.textContent).toContain('アプリの検証（App Check）を用意できず')
    expect(alert.textContent).toContain('旅程はそのまま')
    expect(alert.textContent).not.toContain('secret-detail')
    expect(route().getAllByText('未照合')).toHaveLength(3)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetchFn).not.toHaveBeenCalled()
    expect(protectedApi.getProtectedApiHeaders).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, '認証、招待、またはアプリの検証が通らず'],
    [403, '認証、招待、またはアプリの検証が通らず'],
    [429, '利用の回数が上限に達したため'],
    [503, '根拠の確認は現在利用できません'],
  ] as const)(
    'HTTP %i は区別した案内を出し、旅程は変わらず、自動では再送しない',
    async (status, text) => {
      const body =
        status === 503
          ? { status: 'service_unavailable', message: '停止中' }
          : { message: 'サーバー内部の詳細' }
      const fetchFn = vi.fn(async () => json(body, status))
      vi.stubGlobal('fetch', fetchFn)
      const user = userEvent.setup()
      await showGeneratedTrip(user)
      await user.click(verifyButton())

      const alert = await panel().findByRole('alert')
      expect(alert.textContent).toContain(text)
      expect(alert.textContent).not.toContain('サーバー内部の詳細')
      expect(route().getAllByText('未照合')).toHaveLength(3)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fetchFn).toHaveBeenCalledOnce()
    },
  )

  it('Google由来の内容には、枠と「Google Maps」の帰属を付ける（概要・詳細シートの両方）', async () => {
    vi.stubGlobal('fetch', echoServer())
    const user = userEvent.setup()
    await showGeneratedTrip(user)
    await user.click(verifyButton())

    const summaryBox = await panel().findByRole('group', { name: '確認に使った情報源' })
    const attribution = within(summaryBox).getByRole('img', { name: 'Google Maps' })
    expect(attribution.getAttribute('alt')).toBe('Google Maps')
    // 帰属は枠の中の最後（内容の下）にある。
    expect(summaryBox.lastElementChild?.contains(attribution)).toBe(true)

    await user.click(route().getByRole('button', { name: /昼食店A/ }))
    const dialog = screen.getByRole('dialog')
    const sheetBox = within(dialog).getByRole('group', {
      name: 'Google Maps Platformで確認した内容',
    })
    const sheetAttribution = within(sheetBox).getByRole('img', { name: 'Google Maps' })
    expect(sheetAttribution.getAttribute('alt')).toBe('Google Maps')
    // 根拠の内容（出典・照合日時・理由）が、枠の中で確認できる。
    expect(sheetBox.textContent).toContain('施設の存在')
    expect(sheetBox.textContent).toContain('移動時間')
    expect(sheetBox.textContent).toContain('Google Places')
    expect(sheetBox.textContent).toContain('Google Routes')
    expect(sheetBox.textContent).toContain('照合日時')
    // 移動の数値は取得していない。根拠があるときは、根拠を参照させる。
    expect(dialog.textContent).toContain('所要時間の数値は取得していません')
  })

  it('照合の結果でも、固定予定の名称・時刻・固定は変わらない', async () => {
    vi.stubGlobal('fetch', echoServer())
    const user = userEvent.setup()
    await showGeneratedTrip(user)
    await user.click(verifyButton())
    await panel().findByText(/照合結果あり/)

    for (const fixedId of ['stop-morning', 'stop-exhibition']) {
      const before = generatedTrip.stops.find((stop) => stop.id === fixedId)!
      const button = route().getByRole('button', {
        name: new RegExp(
          `${before.plannedStartTime}から${before.durationMinutes}分 ${before.name}（固定予定）`,
        ),
      })
      expect(button).toBeTruthy()
    }
  })

  it('照合結果で固定予定の名称が書き換えられていたら、採用せず、元の旅程を保持する', async () => {
    const tamperedServer = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = TripSchema.parse(JSON.parse(String(init?.body)).trip)
      const verified = verifiedFrom(sent)
      return json({
        status: 'verified',
        trip: {
          ...verified,
          stops: verified.stops.map((stop) =>
            stop.isFixed ? { ...stop, name: '勝手に変わった名称' } : stop,
          ),
        },
      })
    })
    vi.stubGlobal('fetch', tamperedServer)
    const user = userEvent.setup()
    await showGeneratedTrip(user)
    await user.click(verifyButton())

    const alert = await panel().findByRole('alert')
    expect(alert.textContent).toContain('予期しない応答')
    expect(alert.textContent).toContain('旅程はそのままです')
    expect(route().queryByText('勝手に変わった名称')).toBeNull()
    expect(route().getByText('朝の庭園（架空）')).toBeTruthy()
    expect(route().getAllByText('未照合')).toHaveLength(3)
    expect(panel().getByRole('status').textContent).not.toContain('照合結果あり')
  })

  describe('失敗の区別と再試行', () => {
    const cases = [
      ['external_service_error', 502, '外部の情報源に接続できず'],
      ['invalid_request', 400, 'この旅程の内容では'],
      ['payload_too_large', 413, '大きすぎて'],
      ['service_unavailable', 503, '根拠の確認は現在利用できません'],
    ] as const

    it.each(cases)(
      '%s（HTTP %i）は専用の文言で案内し、旅程は保持して再試行できる',
      async (status, httpStatus, title) => {
        const fetchFn = vi
          .fn()
          .mockResolvedValueOnce(json({ status, message: 'サーバーからの説明' }, httpStatus))
          .mockImplementationOnce(echoServer())
        vi.stubGlobal('fetch', fetchFn)
        const user = userEvent.setup()
        await showGeneratedTrip(user)

        await user.click(verifyButton())
        // 失敗は role="alert" で伝え、結果の通知（role="status"）の外に置く。
        const alert = await panel().findByRole('alert')
        expect(alert.textContent).toMatch(new RegExp(title))
        expect(alert.textContent).toContain('エラー：')
        expect(alert.textContent).toContain('サーバーからの説明')
        expect(alert.textContent).toContain('旅程')
        const statusRegion = panel().getByRole('status')
        expect(statusRegion.contains(alert)).toBe(false)
        expect(statusRegion.textContent).not.toContain('エラー')
        // 失敗しても、旅程と未照合の表示はそのまま。結果は「照合結果あり」にならない。
        expect(route().getAllByText('未照合')).toHaveLength(3)
        expect(statusRegion.textContent).not.toContain('照合結果あり')
        expect(statusRegion.textContent).toContain('未確認')

        // 再試行できる。成功すれば、失敗の通知は消える。
        await user.click(verifyButton('もう一度確認する'))
        await panel().findByText(/照合結果あり/)
        expect(fetchFn).toHaveBeenCalledTimes(2)
        expect(panel().queryByRole('alert')).toBeNull()
      },
    )

    it('通信の失敗は、旅程が保持されることを案内して再試行できる', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockImplementationOnce(echoServer())
      vi.stubGlobal('fetch', fetchFn)
      const user = userEvent.setup()
      await showGeneratedTrip(user)

      await user.click(verifyButton())
      await panel().findAllByText(/通信が中断されました/)
      expect(route().getAllByText('未照合')).toHaveLength(3)

      await user.click(verifyButton('もう一度確認する'))
      await panel().findByText(/照合結果あり/)
    })

    it('想定外の応答（本文が壊れている）は、結果を採用しない', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })))
      const user = userEvent.setup()
      await showGeneratedTrip(user)
      await user.click(verifyButton())
      await panel().findByText(/予期しない応答/)
      expect(route().getAllByText('未照合')).toHaveLength(3)
    })

    it('照合関数が例外を投げても、操作不能にならず再試行できる', async () => {
      const verify = vi
        .fn<VerifyTrip>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementationOnce(async (trip) => ({ ok: true, trip: verifiedFrom(trip) }))
      const user = userEvent.setup()
      await showGeneratedTrip(user, verify)
      await user.click(verifyButton())
      await panel().findByText(/予期しない応答/)
      await user.click(verifyButton('もう一度確認する'))
      await panel().findByText(/照合結果あり/)
    })
  })

  it('確認中は二重に送信せず、ボタンは名前を保ったまま押下を受け付けない', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const user = userEvent.setup()
    await showGeneratedTrip(user, verify)

    await user.click(verifyButton())
    const busy = verifyButton('確認しています…')
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    // フォーカスは操作したボタンに残る（無効化で失わない）。
    expect(document.activeElement).toBe(busy)
    await user.click(busy)
    await user.keyboard('{Enter}')
    expect(verify).toHaveBeenCalledOnce()
    expect(panel().getByRole('status').textContent).toContain('根拠を確認しています')

    await act(async () => pending.resolve({ ok: true, trip: verifiedFrom(generatedTrip) }))
    await panel().findByText(/照合結果あり/)
    expect(verify).toHaveBeenCalledOnce()
  })

  describe('固定の切り替え（根拠には影響しない）', () => {
    // 詳細シートを閉じて、閉じ終わる（次の操作を受け付ける）まで待つ。
    async function closeSheet(user: ReturnType<typeof userEvent.setup>) {
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }

    it('固定を切り替えても、照合結果は取り下げない。根拠も帰属も残り、固定の通知も出る', async () => {
      const fetchFn = echoServer()
      vi.stubGlobal('fetch', fetchFn)
      const user = userEvent.setup()
      await showGeneratedTrip(user)
      await user.click(verifyButton())
      await panel().findByText(/照合結果あり/)
      expect(route().getAllByText('未照合')).toHaveLength(1)

      await user.click(route().getByRole('button', { name: /昼食店A/ }))
      const dialog = screen.getByRole('dialog')
      await user.click(within(dialog).getByRole('button', { name: 'この予定を固定する' }))

      // 通知は詳細シートに残り、固定の状態が反映される。
      expect(within(dialog).getByRole('status').textContent).toContain('固定しました')
      expect(within(dialog).getByRole('button', { name: '固定を解除する' })).toBeTruthy()
      // 根拠はそのまま：詳細シートにも、Google由来の根拠の枠が残る。
      expect(within(dialog).queryByText('施設情報や移動時間と照合していません。')).toBeNull()
      expect(
        within(dialog).getByRole('group', { name: 'Google Maps Platformで確認した内容' }),
      ).toBeTruthy()
      await closeSheet(user)

      // 取り下げない：照合結果あり・件数・帰属がそのまま。
      expect(statusText()).toBe('状態：照合結果あり（根拠 4件）')
      expect(panelText()).not.toContain('変更後は未確認')
      expect(panel().queryByRole('alert')).toBeNull()
      expect(route().getAllByText('未照合')).toHaveLength(1)
      expect(panel().getByRole('img', { name: 'Google Maps' })).toBeTruthy()
      expect(route().getByRole('button', { name: /昼食店A.*（固定予定）.*矛盾あり/ })).toBeTruthy()
      expect(fetchFn).toHaveBeenCalledOnce()

      // 再確認すると、送るのは固定を反映した旅程。照合結果は新しい結果で置き換わる。
      await user.click(verifyButton('もう一度確認する'))
      await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2))
      const second = JSON.parse(String(fetchFn.mock.calls[1][1]?.body)).trip as Trip
      expect(second.stops.find((stop) => stop.id === 'stop-lunch')?.isFixed).toBe(true)
      await waitFor(() => expect(statusText()).toBe('状態：照合結果あり（根拠 4件）'))
    })

    it('確認中に切り替えた固定は、確認を中止せず、結果の到着後も残る（根拠だけが加わる）', async () => {
      const pending = Promise.withResolvers<VerificationResult>()
      const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
      const user = userEvent.setup()
      await showGeneratedTrip(user, verify)
      await user.click(verifyButton())

      // 確認中に、昼食を固定し、朝の固定を解除する。
      await user.click(route().getByRole('button', { name: /昼食店A/ }))
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'この予定を固定する' }),
      )
      await closeSheet(user)
      await user.click(route().getByRole('button', { name: /朝の庭園/ }))
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: '固定を解除する' }),
      )
      await closeSheet(user)

      // 通信は中止しない。確認中の表示も続く。
      expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(false)
      expect(statusText()).toContain('根拠を確認しています')
      expect(panel().queryByRole('alert')).toBeNull()

      // サーバーは固定の切り替えを知らない（送った旅程の固定のまま返す）。結果で、切り替えを巻き戻さない。
      await act(async () => pending.resolve({ ok: true, trip: verifiedFrom(generatedTrip) }))
      await panel().findByText(/照合結果あり/)
      expect(route().getByRole('button', { name: /昼食店A.*（固定予定）.*矛盾あり/ })).toBeTruthy()
      expect(route().getByRole('button', { name: /朝の庭園（架空）、未照合/ })).toBeTruthy()
      expect(route().getAllByText('固定予定')).toHaveLength(2)
      expect(verify).toHaveBeenCalledOnce()
      expect(panel().queryByRole('alert')).toBeNull()
    })

    it('新しい旅程を生成すると、前の旅程の照合結果は引き継がず、未確認に戻る', async () => {
      vi.stubGlobal('fetch', echoServer())
      const generate = vi
        .fn<GenerateTrip>()
        .mockResolvedValueOnce({ ok: true, trip: generatedTrip })
        .mockResolvedValueOnce({ ok: true, trip: secondTrip })
      const user = userEvent.setup()
      await showGeneratedTrip(user, undefined, generate)
      await user.click(verifyButton())
      await panel().findByText(/照合結果あり/)

      await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(panel().getByRole('status').textContent).toContain('未確認'))
      expect(panel().getByRole('status').textContent).not.toContain('照合結果あり')
      expect(route().getAllByText('未照合')).toHaveLength(3)
    })
  })

  it('/demo と同じ路線図の模擬データ（simulation）には、Googleの帰属を付けない', async () => {
    const { RevisionRouteView } = await import('@/features/revision-review/revision-route-view')
    const { sampleRouteMeta } = await import('@/features/trip-map/sample')
    render(<RevisionRouteView trip={sampleTrip} meta={sampleRouteMeta} mock />)
    await userEvent.setup().click(screen.getByRole('button', { name: /昼食店A/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('臨時休業の模擬報告')
    expect(within(dialog).queryByRole('group', { name: /Google/ })).toBeNull()
    expect(document.querySelector('[translate="no"]')).toBeNull()
  })
})
