// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LearningSchema, TripSchema, type Learning, type Stop, type Trip } from '@/domain'
import { sampleApprovedLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import type { ApplyRevision, GenerateRevisions } from '@/features/revision-review/api-client'
import {
  SaveRevisionBodySchema,
  SavedRevisionSchema,
  type VersionedLearning,
} from '@/server/persistence/contracts'

import { fakeAppCheck } from '../../../tests/helpers/fake-app-check'
import { fakeAuth } from '../../../tests/helpers/fake-auth-client'
import { createFakeBackend, isListLearnings } from '../../../tests/helpers/fake-persistence-backend'

import { HomePlanner } from './home-planner'

// 通し導線の結合テスト。認証SDK・App Check・外部API（生成・照合）・保存先だけを差し替え、
// セッションスコープ・各画面・APIクライアント・保存ポートは本物をつないで確かめる。
vi.mock(
  'firebase/app-check',
  async () => (await import('../../../tests/helpers/fake-app-check')).appCheckModule,
)
vi.mock('@/lib/firebase/client', () => ({ getClientAuth: () => ({ app: {} }) }))
vi.mock('@/lib/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/client')>()
  const { fakeAuth: fake } = await import('../../../tests/helpers/fake-auth-client')
  fake.useErrorClass(actual.ClientAuthError)
  return { ...actual, ...fake.client }
})

const A = 'user-a'
const B = 'user-b'
const REGION = '京都市東山エリア'

// ---- 旅程 ----

// 生成直後の旅程：未照合。学びは使っていない。朝と14時の展示は固定、昼食は固定でない。
const generatedTrip = TripSchema.parse({
  ...sampleTrip,
  learningApplications: [],
  stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
})
const [morning, lunch, exhibition] = generatedTrip.stops

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
                status: 'consistent',
                explanation: '徒歩で間に合う',
              },
            ],
    })),
  })
}

// 現地報告で出る、成立する候補（昼食だけを差し替える）。
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

// 依頼の旅程の昼食を、成立する候補に差し替える提案。
const generateRevisions = vi.fn<GenerateRevisions>(async (request) => {
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
        diff: { before, after },
        constraintCheck: { status: 'satisfied', explanation: '固定展示に間に合う' },
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
    // 署名済み候補の形式を模したテスト値（署名検証そのものはサーバー側テストで行う）。
    proposalTokens: { [sampleRevision.id]: `v2.1794132000000.e30.${'A'.repeat(43)}` },
  }
})

// 適用に成功した扱い。承認された依頼の旅程の昼食を候補に差し替え、版を進める。
const applyRevision = vi.fn<ApplyRevision>(async ({ request, revision }) => ({
  status: 'applied',
  trip: TripSchema.parse({
    ...request.trip,
    version: request.trip.version + 1,
    stops: request.trip.stops.map((stop) =>
      stop.id === revision.targetStopId ? revision.diff.after : stop,
    ),
  }),
}))

// ---- 疑似サーバー ----

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

interface GenerateCall {
  body: Record<string, unknown>
  headers: Headers
}

const saved = (id: string, content: string, version = 1): VersionedLearning => ({
  version,
  learning: {
    ...sampleApprovedLearning,
    id,
    content,
  },
})

function setup(
  accounts: Parameters<typeof createFakeBackend>[0] = { [A]: {} },
  candidates: Learning[] = [],
) {
  const backend = createFakeBackend(accounts, { candidates })
  const generateCalls: GenerateCall[] = []
  const state = {
    generate: (): Response => json({ status: 'proposed', trip: generatedTrip }),
    verifyCalls: 0,
  }
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/trips/generate') {
      generateCalls.push({
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      })
      return state.generate()
    }
    if (path === '/api/trips/verify') {
      state.verifyCalls += 1
      const sent = JSON.parse(String(init?.body)).trip as Trip
      return json({ status: 'verified', trip: verifiedFrom(TripSchema.parse(sent)) })
    }
    return backend.fetchFn(input, init)
  })
  vi.stubGlobal('fetch', fetchFn)
  return { backend, generateCalls, state, fetchFn }
}

type User = ReturnType<typeof userEvent.setup>

async function generate(user: User, region = REGION) {
  const input = screen.getByLabelText(/旅行先/) as HTMLInputElement
  if (input.value !== region) {
    await user.clear(input)
    await user.type(input, region)
  }
  fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
  await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
  await screen.findByRole('list', { name: '旅程の路線図' })
}

const panel = () => screen.getByRole('region', { name: '根拠の確認' })
const panelStatus = () => within(panel()).getByRole('status').textContent ?? ''

async function verify(user: User) {
  await user.click(screen.getByRole('button', { name: '根拠を確認する' }))
  await waitFor(() => expect(panelStatus()).toContain('照合結果あり'))
}

async function saveTripFromScreen(user: User) {
  await user.click(screen.getByRole('button', { name: '本人の操作で旅程を保存する' }))
  await screen.findByText(/保存を確認しました/)
}

const goToLunch = async (user: User) => {
  await user.click(screen.getByRole('button', { name: '次の予定へ進む' }))
  await user.click(screen.getByRole('button', { name: '予定が変わった？この予定だけ変更する' }))
}

async function reportAndOpenCandidates(user: User, kind: 'actual' | 'simulated') {
  await goToLunch(user)
  await user.click(screen.getByRole('radio', { name: /閉店・臨時休業だった/ }))
  await user.click(
    screen.getByRole('radio', {
      name: kind === 'actual' ? /いまの現地の状況（実際の報告）/ : /デモ用の模擬報告/,
    }),
  )
  await user.click(
    screen.getByRole('button', {
      name: kind === 'actual' ? '実際の報告として送る' : '模擬報告として送る',
    }),
  )
  await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
  await screen.findByRole('table')
}

const approve = () => screen.getByRole<HTMLButtonElement>('button', { name: '承認して適用を依頼' })

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

const renderHome = () =>
  render(
    <HomePlanner
      generateRevisions={generateRevisions}
      applyRevision={applyRevision}
      learningPickerDelayMs={0}
    />,
  )

beforeEach(() => {
  fakeAppCheck.reset()
  fakeAuth.reset()
  fakeAuth.state.restoredUid = A
  fakeAuth.signInAs(A)
  generateRevisions.mockClear()
  applyRevision.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('トップ画面の通し導線：生成→照合→保存→現地報告→修正の採用', () => {
  it('採用した部分修正は旅程を変え、前回の照合結果を取り下げて「変更後は未確認」に戻す', async () => {
    const { backend, state } = setup()
    const user = userEvent.setup()
    renderHome()

    await generate(user)
    await verify(user)
    expect(state.verifyCalls).toBe(1)

    // 保存：本人が押したときだけ、本人のトークンで保存先へ送る。
    expect(backend.calls.some((call) => call.method === 'POST' && call.path === '/api/trips')).toBe(
      false,
    )
    await saveTripFromScreen(user)
    const posts = backend.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/trips',
    )
    expect(posts).toHaveLength(1)
    expect(posts[0].uid).toBe(A)
    expect(backend.account(A).trips[0].id).toBe(generatedTrip.id)

    // 現地報告 → 候補 → 承認（実際の報告だけが、旅程へ届く）。
    await reportAndOpenCandidates(user, 'actual')
    expect(generateRevisions.mock.calls[0][0].context).toEqual({
      phase: 'on_site',
      report: {
        kind: 'actual',
        description: '閉店・臨時休業だった',
        category: 'closed',
        targetStopId: 'stop-lunch',
      },
    })
    await user.click(approve())
    await waitFor(() => expect(applyRevision).toHaveBeenCalledTimes(1))

    // 旅程が変わった：路線図は新しい昼食、照合は取り下げられて未確認に戻る。
    const route = within(screen.getAllByRole('list', { name: '旅程の路線図' })[0])
    await waitFor(() => expect(route.getByText(after.name)).toBeTruthy())
    expect(panelStatus()).not.toContain('照合結果あり')
    expect(panelStatus()).toContain('一部は未確認')
    expect(panel().textContent).toContain('根拠は取り下げ')
    // 照合を勝手にやり直さない。
    expect(state.verifyCalls).toBe(1)
  })

  it('既定の保存・適用APIで承認し、サーバー確定の旅程と振り返りを表示する', async () => {
    const { backend, fetchFn } = setup()
    const revisionPath = `/api/trips/${generatedTrip.id}/revisions`
    const applyPath = `${revisionPath}/${sampleRevision.id}/apply`
    backend.intercept(
      (call) => call.method === 'POST' && call.path === revisionPath,
      ({ call }) => {
        const candidate = SaveRevisionBodySchema.parse(call.body)
        delete candidate.travelModes
        delete candidate.proposalToken
        return json(
          {
            revision: {
              ...candidate,
              impactSummary: '保存した候補です。現在の影響は再確認が必要です。',
              constraintCheck: { status: 'not_checked', explanation: '制約は再確認が必要です。' },
              diff: {
                before: { ...candidate.diff.before, evidence: [] },
                after: { ...candidate.diff.after, evidence: [] },
              },
            },
          },
          201,
        )
      },
    )
    backend.intercept(
      (call) => call.method === 'POST' && call.path === applyPath,
      ({ call }) => {
        expect(call.body).toEqual({ expectedVersion: 0, confirm: true })
        const proposal = generateRevisions.mock.results.at(-1)?.value
        return Promise.resolve(proposal).then((result) => {
          if (!result || result.status !== 'proposed') throw new Error('missing candidate')
          const candidate = result.revisions[0]
          const original = backend.account(A).trips[0]
          const next = {
            ...original,
            version: 1,
            stops: original.stops.map((stop) =>
              stop.id === candidate.targetStopId ? candidate.diff.after : stop,
            ),
          }
          const approved = {
            ...candidate,
            impactSummary: '適用済みの変更です。現在の影響は再確認が必要です。',
            constraintCheck: { status: 'not_checked', explanation: '制約は再確認が必要です。' },
            approval: { status: 'approved', decidedAt: '2026-11-08T12:00:00+09:00' },
            diff: {
              before: { ...candidate.diff.before, evidence: [] },
              after: { ...candidate.diff.after, evidence: [] },
            },
          }
          backend.account(A).trips[0] = {
            ...next,
            stops: next.stops.map((stop) => ({ ...stop, evidence: [] })),
          }
          backend.account(A).revisions.push(SavedRevisionSchema.parse(approved))
          return json({
            status: 'applied',
            appliedTripVersion: 1,
            trip: next,
            revision: approved,
            verification: 'fresh',
          })
        })
      },
    )
    const user = userEvent.setup()
    render(<HomePlanner generateRevisions={generateRevisions} learningPickerDelayMs={0} />)
    await generate(user)
    await verify(user)
    await saveTripFromScreen(user)
    await reportAndOpenCandidates(user, 'actual')
    expect(backend.calls.filter((call) => call.path === applyPath)).toHaveLength(0)
    await user.click(approve())
    await waitFor(() =>
      expect(backend.calls.filter((call) => call.path === applyPath)).toHaveLength(1),
    )
    await waitFor(() =>
      expect(
        within(screen.getAllByRole('list', { name: '旅程の路線図' })[0]).getByText(after.name),
      ).toBeTruthy(),
    )
    const candidateCall = backend.calls.find(
      (call) => call.path === revisionPath && call.method === 'POST',
    )!
    expect(SaveRevisionBodySchema.parse(candidateCall.body)).toMatchObject({
      travelModes: ['walk'],
      proposalToken: expect.any(String),
    })
    expect(candidateCall.uid).toBe(A)
    expect(backend.calls.find((call) => call.path === applyPath)?.uid).toBe(A)
    for (const path of [revisionPath, applyPath]) {
      const call = fetchFn.mock.calls.find(
        ([url, init]) => String(url) === path && init?.method === 'POST',
      )!
      const headers = new Headers(call[1]?.headers)
      expect(headers.get('Authorization')).toContain(A)
      expect(headers.get('X-Firebase-AppCheck')).toBeTruthy()
    }
    expect(backend.account(A).trips[0].stops[0]).toEqual(
      expect.objectContaining({ id: morning.id, isFixed: true }),
    )
    expect(backend.account(A).trips[0].stops[2]).toEqual(
      expect.objectContaining({ id: exhibition.id, isFixed: true }),
    )
    await waitFor(() =>
      expect(
        backend.calls.filter((call) => call.path === revisionPath && call.method === 'GET').length,
      ).toBeGreaterThan(1),
    )
  })
  it('デモ用の模擬報告は、候補を比べられても旅程に適用せず、照合も取り下げない', async () => {
    setup()
    const user = userEvent.setup()
    renderHome()

    await generate(user)
    await verify(user)
    await saveTripFromScreen(user)
    await reportAndOpenCandidates(user, 'simulated')

    expect(screen.getByText(/デモ用の想定です。現地で実際に起きたことではありません/)).toBeTruthy()
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    await user.click(approve())
    await flush()

    expect(applyRevision).not.toHaveBeenCalled()
    expect(panelStatus()).toContain('照合結果あり')
    expect(
      within(screen.getAllByRole('list', { name: '旅程の路線図' })[0]).getByText(lunch.name),
    ).toBeTruthy()
  })

  it('保存前には現地の候補を生成しない', async () => {
    setup()
    const user = userEvent.setup()
    render(<HomePlanner generateRevisions={generateRevisions} learningPickerDelayMs={0} />)
    await generate(user)
    await verify(user)
    await user.click(screen.getByRole('button', { name: '次の予定へ進む' }))
    expect(
      screen.queryByRole('button', { name: '予定が変わった？この予定だけ変更する' }),
    ).toBeNull()
    expect(generateRevisions).not.toHaveBeenCalled()
  })
})

it('保存済み旅程を開くと振り返りにも進める', async () => {
  const { backend } = setup()
  backend.account(A).trips.push(generatedTrip)
  const user = userEvent.setup()
  renderHome()
  await user.click(screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }))
  await user.click(await screen.findByRole('button', { name: new RegExp(generatedTrip.region) }))
  expect(await screen.findByRole('heading', { name: '保存した旅行を振り返る' })).toBeTruthy()
})
describe('トップ画面：保存して振り返る（同じページ内で、旅程を失わずに進む）', () => {
  it('保存すると、同じページに振り返りが現れ、保存した旅程が選ばれる。生成結果は残る', async () => {
    const { backend } = setup()
    const user = userEvent.setup()
    renderHome()

    await generate(user)
    // 保存前は振り返りを出さない。
    expect(screen.queryByRole('heading', { name: '保存した旅行を振り返る' })).toBeNull()
    await saveTripFromScreen(user)

    // 振り返りは同じページの節（h3）。ページの見出し（h1）を増やさない。
    const heading = await screen.findByRole('heading', { name: '保存した旅行を振り返る' })
    expect(heading.tagName).toBe('H3')
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(await screen.findByRole('button', { name: '学びの候補を作る' })).toBeTruthy()
    // 画面上の旅程は残っている。
    expect(screen.getByRole('list', { name: '旅程の路線図' })).toBeTruthy()
    expect(
      backend.calls.filter((call) => call.method === 'POST' && call.path === '/api/trips'),
    ).toHaveLength(1)
  })

  it('保存に失敗しても旅程は残り、押し直せる。結果が不明なら「保存済みか確認」を案内し、自動で再送しない', async () => {
    const { backend } = setup()
    backend.intercept(
      (call) => call.method === 'POST' && call.path === '/api/trips',
      ({ proceed }) => {
        proceed()
        throw new TypeError('offline')
      },
    )
    const user = userEvent.setup()
    renderHome()

    await generate(user)
    await user.click(screen.getByRole('button', { name: '本人の操作で旅程を保存する' }))
    const alert = await screen.findByText(/保存できたかどうか、確認できませんでした/)

    expect(alert).toBeTruthy()
    expect(screen.getByRole('list', { name: '旅程の路線図' })).toBeTruthy()
    // 勝手に再送しない。
    await flush()
    expect(
      backend.calls.filter((call) => call.method === 'POST' && call.path === '/api/trips'),
    ).toHaveLength(1)
    // 一覧で確かめる導線を出す。
    await user.click(screen.getByRole('button', { name: '保存済みの旅行を確認する' }))
    expect(await screen.findByRole('heading', { name: '保存した旅行を振り返る' })).toBeTruthy()
    expect(
      await screen.findByText(new RegExp(sampleTrip.stops.length + '地点・保存済み')),
    ).toBeTruthy()
  })

  it('保存ボタンは常に押せる。認証を確認できないときは、送らずに理由を示す', async () => {
    const { backend } = setup()
    const user = userEvent.setup()
    renderHome()
    await generate(user)

    act(() => fakeAuth.restoring())
    const button = screen.getByRole('button', { name: '本人の操作で旅程を保存する' })
    expect(button.getAttribute('disabled')).toBeNull()
    await user.click(button)

    expect((await screen.findAllByRole('alert')).map((node) => node.textContent).join()).toContain(
      '認証の状態を確認できないため、保存を始めませんでした',
    )
    expect(
      backend.calls.filter((call) => call.method === 'POST' && call.path === '/api/trips'),
    ).toHaveLength(0)
  })
})

describe('トップ画面：認証セッションが変わったら、前のセッションの結果をすべて捨てる', () => {
  it('UIDが変わると、旅程・照合・保存・現地報告・振り返りが消え、入力欄の値だけが残る', async () => {
    setup({ [A]: {}, [B]: {} })
    const user = userEvent.setup()
    renderHome()

    await generate(user)
    await verify(user)
    await saveTripFromScreen(user)
    await goToLunch(user)
    expect(await screen.findByRole('heading', { name: '保存した旅行を振り返る' })).toBeTruthy()

    act(() => fakeAuth.signInAs(B))

    await waitFor(() => expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull())
    expect(screen.queryByRole('region', { name: '根拠の確認' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '保存した旅行を振り返る' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
    expect(screen.queryByRole('button', { name: '本人の操作で旅程を保存する' })).toBeNull()
    // 本人が入れた旅行条件は残る。
    expect((screen.getByLabelText(/旅行先/) as HTMLInputElement).value).toBe(REGION)
  })

  it('認証世代が変わった（同じUIDでセッションが置き換わった）ときも捨てる', async () => {
    setup()
    const user = userEvent.setup()
    renderHome()
    await generate(user)

    act(() => {
      fakeAuth.endSession()
      fakeAuth.signInAs(A)
    })

    await waitFor(() => expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull())
  })

  it('生成中にUIDが変わったら、その結果は表示しない', async () => {
    const { state } = setup({ [A]: {}, [B]: {} })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = state.generate
    state.generate = () => original()
    const fetchFn = vi.mocked(fetch)
    const route = fetchFn.getMockImplementation()!
    fetchFn.mockImplementation(async (input, init) => {
      if (String(input) === '/api/trips/generate') await gate
      return route(input, init)
    })
    const user = userEvent.setup()
    renderHome()

    await user.type(screen.getByLabelText(/旅行先/), REGION)
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    act(() => fakeAuth.signInAs(B))
    release()
    await flush()

    expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull()
  })
})

describe('トップ画面：前の旅の学びを選んで、次の旅程の生成に使う', () => {
  const learningA = saved('learning-a', '昼食後は休憩を長めに取る', 3)

  async function chooseLearning(user: User) {
    const checkbox = await screen.findByRole('checkbox', {
      name: new RegExp(learningA.learning.content),
    })
    await user.click(checkbox)
  }

  it('生成の要求には、選んだ学びの { id, version } だけが載る。本文は送らず、本人のトークンで送る', async () => {
    const { generateCalls } = setup({ [A]: { learnings: [learningA] } })
    const user = userEvent.setup()
    renderHome()

    await user.type(screen.getByLabelText(/旅行先/), REGION)
    await chooseLearning(user)
    await generate(user)

    expect(generateCalls).toHaveLength(1)
    const { body, headers } = generateCalls[0]
    expect(body.learningSelections).toEqual([{ id: 'learning-a', version: 3 }])
    expect(body).not.toHaveProperty('learnings')
    expect(JSON.stringify(body)).not.toContain(learningA.learning.content)
    expect(headers.get('Authorization')).toBe('Bearer token-of-' + A)
    expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
  })

  it('学びを選ばなければ、選択は空で送る', async () => {
    const { generateCalls } = setup({ [A]: { learnings: [learningA] } })
    const user = userEvent.setup()
    renderHome()

    await generate(user)

    expect(generateCalls[0].body.learningSelections).toEqual([])
  })

  it('選んだあとにUIDが変わったら、選択は解除され、前のセッションの学びは送られない', async () => {
    const learningB = saved('learning-a', 'Bの学び（同じIDで内容が違う）', 3)
    const { generateCalls } = setup({
      [A]: { learnings: [learningA] },
      [B]: { learnings: [learningB] },
    })
    const user = userEvent.setup()
    renderHome()

    await user.type(screen.getByLabelText(/旅行先/), REGION)
    await chooseLearning(user)
    act(() => fakeAuth.signInAs(B))
    await screen.findByRole('checkbox', { name: new RegExp(learningB.learning.content) })

    // Bの一覧に切り替わり、選択は外れている。そのまま生成しても、Aの選択は送られない。
    expect(
      (
        screen.getByRole('checkbox', {
          name: new RegExp(learningB.learning.content),
        }) as HTMLInputElement
      ).checked,
    ).toBe(false)
    await generate(user)
    expect(generateCalls[0].body.learningSelections).toEqual([])
    expect(generateCalls[0].headers.get('Authorization')).toBe('Bearer token-of-' + B)
  })

  it('サーバーが409 selection_changed を返したら、旅程は作らず、一覧を読み込み直して選び直しを案内する', async () => {
    const { backend, state, generateCalls } = setup({ [A]: { learnings: [learningA] } })
    state.generate = () =>
      json({ status: 'selection_changed', message: '選んだ学びが変更されました' }, 409)
    const user = userEvent.setup()
    renderHome()

    await user.type(screen.getByLabelText(/旅行先/), REGION)
    await chooseLearning(user)
    const listCalls = () => backend.calls.filter(isListLearnings).length
    const before = listCalls()
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('選んだ学びが変更または撤回されていました')
    expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull()
    expect(generateCalls).toHaveLength(1)
    // 最新の一覧を取り直し、選択は外れて選び直しになる。入力欄は残る。
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before))
    await waitFor(() =>
      expect(
        (
          screen.getByRole('checkbox', {
            name: new RegExp(learningA.learning.content),
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    )
    expect((screen.getByLabelText(/旅行先/) as HTMLInputElement).value).toBe(REGION)
  })

  it('503（機能停止）は平易な文言で案内し、入力欄と学びの選択を失わない', async () => {
    const { state } = setup({ [A]: { learnings: [learningA] } })
    state.generate = () =>
      json({ status: 'service_unavailable', message: '旅程の生成は現在利用できません。' }, 503)
    const user = userEvent.setup()
    renderHome()

    await user.type(screen.getByLabelText(/旅行先/), REGION)
    await chooseLearning(user)
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      '旅程の生成は現在利用できません',
    )
    expect((screen.getByLabelText(/旅行先/) as HTMLInputElement).value).toBe(REGION)
    expect(
      (
        screen.getByRole('checkbox', {
          name: new RegExp(learningA.learning.content),
        }) as HTMLInputElement
      ).checked,
    ).toBe(true)
  })

  it('保存済みの学びを確認できない（503 learnings_unavailable）ときは、学びを使わずに作る道を案内する', async () => {
    const { state } = setup({ [A]: { learnings: [learningA] } })
    state.generate = () =>
      json({ status: 'learnings_unavailable', message: '保存済みの学びを確認できません。' }, 503)
    const user = userEvent.setup()
    renderHome()

    await user.type(screen.getByLabelText(/旅行先/), REGION)
    await chooseLearning(user)
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))

    const failure = await screen.findByRole('alert')
    expect(failure.textContent).toContain('保存済みの学びを確認できませんでした')
    expect(failure.textContent).toContain('学びの選択を外して')
    expect((screen.getByLabelText(/旅行先/) as HTMLInputElement).value).toBe(REGION)
  })
})

describe('トップ画面：振り返りで保存した学びが、次の旅程の選択肢に現れる', () => {
  const candidate = LearningSchema.parse({
    id: 'learning-new',
    sourceTripId: generatedTrip.id,
    category: 'preference',
    content: '朝の移動は短くする',
    scope: { kind: 'all_trips' },
    approval: { status: 'pending' },
  })

  it('学びを承認して保存すると、次の生成で選べる一覧に反映される（その版で選べる）', async () => {
    const { generateCalls } = setup({ [A]: {} }, [candidate])
    const user = userEvent.setup()
    renderHome()

    await generate(user)
    expect(screen.queryByRole('checkbox', { name: /朝の移動は短くする/ })).toBeNull()
    await saveTripFromScreen(user)

    await user.type(await screen.findByLabelText(/感想・変更した理由/), '朝は慌ただしかった')
    await user.click(screen.getByRole('button', { name: '学びの候補を作る' }))
    await screen.findByRole('heading', { name: /学びの候補（/ })
    await user.click(screen.getByRole('button', { name: '承認する' }))
    await user.click(screen.getByRole('button', { name: /保存する|保存しています/ }))

    // 次の旅程のための一覧に、保存した学びが現れる。選んで、もう一度生成する。
    const checkbox = await screen.findByRole('checkbox', { name: /朝の移動は短くする/ })
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    await waitFor(() => expect(generateCalls).toHaveLength(2))

    expect(generateCalls[0].body.learningSelections).toEqual([])
    expect(generateCalls[1].body.learningSelections).toEqual([{ id: 'learning-new', version: 1 }])
    expect(JSON.stringify(generateCalls[1].body)).not.toContain('朝の移動は短くする')
  })
})
