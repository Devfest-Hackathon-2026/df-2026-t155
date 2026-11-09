// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LearningSchema, TripSchema, type Learning, type Stop, type Trip } from '@/domain'
import { sampleApprovedLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import type { ApplyRevision, GenerateRevisions } from '@/features/revision-review/api-client'
import {
  markApplyUnresolved,
  readUnresolvedApply,
} from '@/features/revision-review/unresolved-apply'
import {
  SaveRevisionBodySchema,
  SavedRevisionSchema,
  type VersionedLearning,
} from '@/server/persistence/contracts'

import { fakeAppCheck } from '../../../tests/helpers/fake-app-check'
import { fakeAuth } from '../../../tests/helpers/fake-auth-client'
import { createFakeBackend, isListLearnings } from '../../../tests/helpers/fake-persistence-backend'

import { fromTripDocument, toTripDocument } from '@/server/persistence/dto'
import { documentKey } from '@/server/persistence/paths'
import { generateTrip } from '@/server/trip-generation/generate-trip'
import { GenerateTripHttpRequestSchema } from '@/server/trip-generation/http-request'

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
    generate: (): Response | Promise<Response> => json({ status: 'proposed', trip: generatedTrip }),
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

const showDuring = (user: User) => user.click(screen.getByRole('button', { name: '旅行中' }))
const showBefore = (user: User) => user.click(screen.getByRole('button', { name: '旅行前' }))
const openReflection = (user: User) =>
  user.click(screen.getByRole('button', { name: '保存した旅行を振り返る' }))
const backToTrip = (user: User) => user.click(screen.getByRole('button', { name: '旅程へ戻る' }))
const editInput = (user: User) =>
  user.click(screen.getByRole('button', { name: '旅行条件・保存済みの旅程' }))

const goToLunch = async (user: User) => {
  await showDuring(user)
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
  await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
  await screen.findByRole('table')
}

const approve = () => screen.getByRole<HTMLButtonElement>('button', { name: '承認して適用を依頼' })

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

const renderHome = (learningPickerDelayMs = 0) =>
  render(
    <HomePlanner
      generateRevisions={generateRevisions}
      applyRevision={applyRevision}
      learningPickerDelayMs={learningPickerDelayMs}
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
  it('生成した食事をチケットで表示し、照合・固定・保存・再読込でも種別を維持する', async () => {
    const { backend, generateCalls, state } = setup()
    const generateJson = vi.fn().mockResolvedValue(
      JSON.stringify({
        failure: null,
        stops: [
          {
            fixedStopId: null,
            name: '庭園',
            kind: 'sight',
            plannedStartTime: '10:00',
            durationMinutes: 60,
          },
          {
            fixedStopId: null,
            name: '鴨川食堂',
            kind: 'meal',
            plannedStartTime: '12:00',
            durationMinutes: 75,
          },
          {
            fixedStopId: null,
            name: '喫茶室（種別未指定）',
            plannedStartTime: '14:00',
            durationMinutes: 60,
          },
        ],
        learningApplications: [],
      }),
    )
    state.generate = async () => {
      const { learningSelections, ...conditions } = GenerateTripHttpRequestSchema.parse(
        generateCalls.at(-1)?.body,
      )
      expect(learningSelections).toEqual([])
      const result = await generateTrip(
        { ...conditions, learnings: [] },
        { client: { generateJson } },
      )
      return json(result, result.status === 'proposed' ? 200 : 422)
    }
    backend.intercept(
      (call) => call.method === 'POST' && call.path === '/api/trips',
      ({ call }) => {
        const input = TripSchema.parse(call.body)
        const saved = fromTripDocument(toTripDocument({ uid: A }, input), documentKey(input.id))
        backend.account(A).trips.push(saved)
        return json({ trip: saved }, 201)
      },
    )

    const user = userEvent.setup()
    const first = renderHome()
    const card = (name: RegExp) =>
      within(screen.getByRole('list', { name: '旅程の路線図' })).getByRole('button', { name })
    const meal = () => card(/鴨川食堂/)
    await generate(user)
    expect(generateJson).toHaveBeenCalledOnce()
    expect(meal().dataset.variant).toBe('ticket')
    expect(meal().textContent).toContain('12:00〜13:15・75分')
    expect(meal().textContent).toContain('未照合')
    expect(card(/庭園/).dataset.variant).toBe('station')
    expect(card(/喫茶室/).dataset.variant).toBe('station')

    await verify(user)
    expect(meal().dataset.variant).toBe('ticket')
    await user.click(meal())
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'この予定を固定する' }),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(meal().textContent).toContain('固定予定')
    expect(meal().dataset.variant).toBe('ticket')
    await saveTripFromScreen(user)
    expect(backend.account(A).trips[0].stops.map(({ kind }) => kind)).toEqual([
      'sight',
      'meal',
      undefined,
    ])
    expect(backend.account(A).trips[0].stops[1]).toMatchObject({ isFixed: true, evidence: [] })

    first.unmount()
    renderHome()
    await user.click(screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }))
    await user.click(await screen.findByRole('button', { name: new RegExp(REGION) }))
    expect(meal().dataset.variant).toBe('ticket')
    expect(meal().textContent).toContain('固定予定')
    expect(card(/喫茶室/).dataset.variant).toBe('station')
  })

  it('未保存で固定して解除しても、保存や部分修正を解禁しない', async () => {
    const { backend } = setup()
    const user = userEvent.setup()
    renderHome()
    await generate(user)
    await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    const sheet = within(screen.getByRole('dialog'))
    await user.click(sheet.getByRole('button', { name: 'この予定を固定する' }))
    await user.click(sheet.getByRole('button', { name: '固定を解除する' }))
    expect(sheet.queryByRole('button', { name: 'この予定だけ変更' })).toBeNull()
    expect(screen.queryByRole('button', { name: '承認して適用を依頼' })).toBeNull()
    expect(backend.account(A).trips).toEqual([])
    expect(applyRevision).not.toHaveBeenCalled()
  })

  it('照合後に保存しても、固定操作なしで非固定地点を変更できる。固定の変更は保存済みと扱わない', async () => {
    const { backend } = setup()
    backend.intercept(
      (call) => call.method === 'POST' && call.path === '/api/trips',
      ({ call }) => {
        const input = TripSchema.parse(call.body)
        const saved = fromTripDocument(toTripDocument({ uid: A }, input), documentKey(input.id))
        backend.account(A).trips.push(saved)
        return json({ trip: saved }, 201)
      },
    )
    const user = userEvent.setup()
    renderHome()
    await generate(user)
    await verify(user)
    await saveTripFromScreen(user)
    await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'この予定だけ変更' }),
    ).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByRole('button', { name: new RegExp(exhibition.name) }))
    const fixedSheet = within(screen.getByRole('dialog'))
    expect(
      fixedSheet.getByRole<HTMLButtonElement>('button', { name: '固定中は変更できません' })
        .disabled,
    ).toBe(true)
    await user.click(fixedSheet.getByRole('button', { name: '固定を解除する' }))
    expect(fixedSheet.queryByRole('button', { name: 'この予定だけ変更' })).toBeNull()
    await user.click(fixedSheet.getByRole('button', { name: 'この予定を固定する' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'この予定だけ変更' }),
    ).toBeTruthy()
    expect(panelStatus()).toContain('照合結果あり')
    expect(backend.account(A).trips[0].version).toBe(0)
    expect(backend.account(A).trips[0].stops[2].isFixed).toBe(true)
  })

  it('保存済み旅程を再読込した直後は変更でき、Place IDが変わる照合の後は正本に戻るまで変更できない', async () => {
    const { backend } = setup()
    backend.account(A).trips.push(generatedTrip)
    const user = userEvent.setup()
    renderHome()
    await user.click(screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }))
    await user.click(await screen.findByRole('button', { name: new RegExp(generatedTrip.region) }))
    const openLunch = () => user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    await openLunch()
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'この予定だけ変更' }),
    ).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await verify(user)
    await openLunch()
    const sheet = within(screen.getByRole('dialog'))
    expect(sheet.queryByRole('button', { name: 'この予定だけ変更' })).toBeNull()
    expect(sheet.getByText(/画面の旅程が保存時点と異なります/)).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('button', { name: '本人の操作で旅程を保存する' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '保存済みの旅程へ戻す' }))
    await openLunch()
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'この予定だけ変更' }),
    ).toBeTruthy()
    expect(applyRevision).not.toHaveBeenCalled()
    expect(backend.account(A).trips[0]).toEqual(generatedTrip)
  })

  it('保存後は旅行前の予定を部分修正できる', async () => {
    setup()
    const user = userEvent.setup()
    renderHome()
    await generate(user)
    await saveTripFromScreen(user)
    await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    await user.click(screen.getByRole('button', { name: 'この予定だけ変更' }))
    await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    const preview = await screen.findByRole('button', { name: '変更内容を確認する' })
    expect(screen.queryByRole('button', { name: '承認して適用を依頼' })).toBeNull()
    await showDuring(user)
    expect(screen.queryByRole('button', { name: '変更内容を確認する' })).toBeNull()
    await showBefore(user)
    expect(screen.getByRole('button', { name: '変更内容を確認する' })).toBe(preview)
    expect(generateRevisions).toHaveBeenCalledOnce()
    expect(applyRevision).not.toHaveBeenCalled()
    await user.click(preview)
    await screen.findByRole('table')
    expect(generateRevisions.mock.calls[0][0].context).toEqual({ phase: 'planning' })
    await user.click(approve())
    await waitFor(() => expect(applyRevision).toHaveBeenCalledTimes(1))
    expect(
      within(await screen.findByRole('list', { name: '旅程の路線図' })).getByText(after.name),
    ).toBeTruthy()
  })
  it('旅行前の候補保存が失敗したら適用せず、ロックを残さない', async () => {
    const { backend } = setup()
    const path = `/api/trips/${generatedTrip.id}/revisions`
    backend.intercept(
      (call) => call.method === 'POST' && call.path === path,
      () => json({ message: 'unavailable' }, 503),
    )
    const user = userEvent.setup()
    render(<HomePlanner generateRevisions={generateRevisions} learningPickerDelayMs={0} />)
    await generate(user)
    await saveTripFromScreen(user)
    await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    await user.click(screen.getByRole('button', { name: 'この予定だけ変更' }))
    await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('table')
    await user.click(approve())
    await screen.findByText(/候補の保存結果を確認できません/)
    expect(readUnresolvedApply(A, generatedTrip.id)).toEqual({ status: 'clear' })
    expect(backend.calls.some((call) => call.path.endsWith('/apply'))).toBe(false)
  })
  it('同じタブで未確定の適用が生じたら旅行前と現地の両方を開始しない', async () => {
    setup()
    const user = userEvent.setup()
    renderHome()
    await generate(user)
    await saveTripFromScreen(user)
    markApplyUnresolved(A, generatedTrip.id, generatedTrip.version, sampleRevision.id)
    await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    await user.click(screen.getByRole('button', { name: 'この予定だけ変更' }))
    expect(screen.queryByLabelText('修正理由（必須）')).toBeNull()
    await user.click(screen.getByRole('button', { name: '閉じる' }))
    await showDuring(user)
    await user.click(screen.getByRole('button', { name: '次の予定へ進む' }))
    await user.click(screen.getByRole('button', { name: '予定が変わった？この予定だけ変更する' }))
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
    expect(generateRevisions).not.toHaveBeenCalled()
    window.localStorage.clear()
  })
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

    await showBefore(user)
    // 旅程が変わった：路線図は新しい昼食、照合は取り下げられて未確認に戻る。
    const route = within(screen.getAllByRole('list', { name: '旅程の路線図' })[0])
    await waitFor(() => expect(route.getByText(after.name)).toBeTruthy())
    expect(panelStatus()).not.toContain('照合結果あり')
    expect(panelStatus()).toContain('一部は未確認')
    expect(panel().textContent).toContain('根拠は取り下げ')
    // 照合を勝手にやり直さない。
    expect(state.verifyCalls).toBe(1)
  })

  it.each(['planning', 'on_site'] as const)(
    '%s: 既定の保存・適用APIで承認し、サーバー確定の旅程と振り返りを表示する',
    async (phase) => {
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
      await openReflection(user)
      await screen.findByRole('button', { name: '学びの候補を作る' })
      await backToTrip(user)
      if (phase === 'planning') {
        await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
        await user.click(screen.getByRole('button', { name: 'この予定だけ変更' }))
        await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
        await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
        await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
        await screen.findByRole('table')
        expect(generateRevisions.mock.calls[0][0].context).toEqual({ phase: 'planning' })
      } else {
        await reportAndOpenCandidates(user, 'actual')
      }
      expect(backend.calls.filter((call) => call.path === applyPath)).toHaveLength(0)
      await user.click(approve())
      await waitFor(() =>
        expect(backend.calls.filter((call) => call.path === applyPath)).toHaveLength(1),
      )
      await showBefore(user)
      await waitFor(() =>
        expect(
          within(screen.getByRole('list', { name: '旅程の路線図' })).getByText(after.name),
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
      await openReflection(user)
      await waitFor(() =>
        expect(
          backend.calls.filter((call) => call.path === revisionPath && call.method === 'GET')
            .length,
        ).toBeGreaterThan(1),
      )
    },
  )
  it('旅行前と旅行中の往復で、報告の選択と手動の進行位置を保持する', async () => {
    setup()
    const user = userEvent.setup()
    renderHome()
    await generate(user)
    await saveTripFromScreen(user)
    await goToLunch(user)
    const reason = screen.getByRole<HTMLInputElement>('radio', { name: /閉店・臨時休業だった/ })
    await user.click(reason)
    await showBefore(user)
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
    await showDuring(user)
    expect(screen.getByRole('radio', { name: /閉店・臨時休業だった/ })).toBe(reason)
    expect(reason.checked).toBe(true)
    await user.click(screen.getByRole('button', { name: '旅行中の画面に戻る' }))
    expect(
      within(screen.getByRole('region', { name: 'いまの予定' })).getByText(lunch.name),
    ).toBeTruthy()
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
    await showBefore(user)
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
    await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    expect(screen.queryByRole('button', { name: 'この予定だけ変更' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '閉じる' }))
    await showDuring(user)
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
  await openReflection(user)
  expect(await screen.findByRole('heading', { name: '振り返り', level: 1 })).toBeTruthy()
})
describe('トップ画面：保存して振り返る（同じページ内で、旅程を失わずに進む）', () => {
  it('保存後に独立した振り返り画面を開け、往復しても旅程と感想が残る', async () => {
    const { backend } = setup()
    const user = userEvent.setup()
    renderHome()

    await generate(user)
    expect(screen.queryByRole('button', { name: '保存した旅行を振り返る' })).toBeNull()
    await saveTripFromScreen(user)
    expect(screen.queryByRole('heading', { name: '振り返り', level: 1 })).toBeNull()

    await openReflection(user)
    const heading = screen.getByRole('heading', { name: '振り返り', level: 1 })
    expect(document.activeElement).toBe(heading)
    expect(screen.getAllByRole('heading', { level: 1 })).toEqual([heading])
    expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull()
    const feedback = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: /感想・変更した理由/,
    })
    await user.type(feedback, '朝は慌ただしかった')
    await backToTrip(user)
    expect(screen.getByRole('list', { name: '旅程の路線図' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /感想・変更した理由/ })).toBeNull()
    await openReflection(user)
    expect(screen.getByRole('textbox', { name: /感想・変更した理由/ })).toBe(feedback)
    expect(feedback.value).toBe('朝は慌ただしかった')
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
    expect(await screen.findByRole('heading', { name: '振り返り', level: 1 })).toBeTruthy()
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
    await openReflection(user)
    expect(await screen.findByRole('button', { name: '学びの候補を作る' })).toBeTruthy()
    await backToTrip(user)
    await goToLunch(user)
    expect(screen.getByRole('heading', { name: '現地の状況を報告する' })).toBeTruthy()

    act(() => fakeAuth.signInAs(B))

    await waitFor(() => expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull())
    expect(screen.queryByRole('region', { name: '根拠の確認' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '振り返り', level: 1 })).toBeNull()
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
    expect(screen.queryByRole('region', { name: '生成時の学びの適用記録' })).toBeNull()
  })

  it('生成時の学びと対象を表示し、未報告の学びと区別する。適用記録つき旅程の保存は送信しない', async () => {
    const unreported = saved('learning-b', '混雑時は屋外で休憩する')
    const { state, fetchFn } = setup({ [A]: { learnings: [learningA, unreported] } })
    state.generate = () =>
      json({
        status: 'proposed',
        trip: {
          ...generatedTrip,
          learningApplications: [
            {
              learningId: learningA.learning.id,
              targetStopIds: [lunch.id],
              explanation: '昼食後の休憩時間に余裕を持たせた。',
            },
          ],
        },
      })
    const user = userEvent.setup()
    renderHome()
    await user.type(screen.getByLabelText(/旅行先/), REGION)
    await chooseLearning(user)
    await user.click(screen.getByRole('checkbox', { name: /混雑時は屋外で休憩する/ }))
    await generate(user)

    const summary = within(screen.getByRole('region', { name: '生成時の学びの適用記録' }))
    const [recorded, omitted] = summary.getAllByRole('listitem')
    expect(recorded.textContent).toContain(learningA.learning.content)
    expect(recorded.textContent).toContain(`生成時の対象：${lunch.name}`)
    expect(recorded.textContent).toContain(
      'AIによる説明（未検証）：昼食後の休憩時間に余裕を持たせた。',
    )
    expect(omitted.textContent).toBe(unreported.learning.content)
    expect(summary.getByText(/AIから反映先の報告がなかった/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '本人の操作で旅程を保存する' }))
    expect((await screen.findByRole('alert')).textContent).toContain('まだ保存できません')
    expect(
      fetchFn.mock.calls.some(([url, init]) => url === '/api/trips' && init?.method === 'POST'),
    ).toBe(false)

    // 次の操作で選択を外しても、生成結果には当時の内容を表示し続ける。
    await editInput(user)
    await user.click(screen.getByRole('checkbox', { name: /昼食後は休憩を長めに取る/ }))
    await backToTrip(user)
    expect(summary.getByText(learningA.learning.content)).toBeTruthy()

    act(() => fakeAuth.signInAs(B))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '生成時の学びの適用記録' })).toBeNull(),
    )
  })

  it('地域を変えて一覧の更新前に生成しても、前の地域の選択を送らない', async () => {
    const { generateCalls } = setup({ [A]: { learnings: [learningA] } })
    const user = userEvent.setup()
    renderHome(500)

    const regionInput = screen.getByLabelText(/旅行先/)
    fireEvent.change(regionInput, { target: { value: REGION } })
    await chooseLearning(user)
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    fireEvent.change(regionInput, { target: { value: '奈良市' } })

    expect(screen.getByText(/新しい一覧が表示されてから選んでください/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /昼食後は休憩を長めに取る/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '旅程を作成する' }))
    await waitFor(() => expect(generateCalls).toHaveLength(1))
    expect(generateCalls[0].body).toMatchObject({ region: '奈良市', learningSelections: [] })
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

  it('保存した学びを次の生成で使い、元の保存済み旅程を開いて旅行前に部分修正できる', async () => {
    const { generateCalls, state } = setup({ [A]: {} }, [candidate])
    const user = userEvent.setup()
    renderHome()

    await generate(user)
    expect(screen.queryByRole('checkbox', { name: /朝の移動は短くする/ })).toBeNull()
    await saveTripFromScreen(user)
    await openReflection(user)

    await user.type(await screen.findByLabelText(/感想・変更した理由/), '朝は慌ただしかった')
    await user.click(screen.getByRole('button', { name: '学びの候補を作る' }))
    await screen.findByRole('heading', { name: /学びの候補（/ })
    await user.click(screen.getByRole('button', { name: '承認する' }))
    await user.click(screen.getByRole('button', { name: /保存する|保存しています/ }))

    await backToTrip(user)
    await editInput(user)
    // 次の旅程のための一覧に、保存した学びが現れる。選んで、もう一度生成する。
    state.generate = () => json({ status: 'proposed', trip: { ...generatedTrip, id: 'next-trip' } })
    const checkbox = await screen.findByRole('checkbox', { name: /朝の移動は短くする/ })
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    await waitFor(() => expect(generateCalls).toHaveLength(2))

    expect(generateCalls[0].body.learningSelections).toEqual([])
    expect(generateCalls[1].body.learningSelections).toEqual([{ id: 'learning-new', version: 1 }])
    expect(JSON.stringify(generateCalls[1].body)).not.toContain('朝の移動は短くする')
    const summary = within(await screen.findByRole('region', { name: '生成時の学びの適用記録' }))
    expect(summary.getByText(/AIから反映先の報告がなかった/)).toBeTruthy()
    expect(summary.getByRole('listitem').textContent).toBe(candidate.content)

    await editInput(user)
    await user.click(screen.getByRole('button', { name: '保存した旅程で旅行を続ける' }))
    await user.click(await screen.findByRole('button', { name: new RegExp(generatedTrip.region) }))
    expect(screen.queryByRole('region', { name: '生成時の学びの適用記録' })).toBeNull()
    await user.click(screen.getByRole('button', { name: new RegExp(lunch.name) }))
    await user.click(screen.getByRole('button', { name: 'この予定だけ変更' }))
    await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    await user.click(await screen.findByRole('button', { name: '変更内容を確認する' }))
    await screen.findByRole('table')
    expect(generateRevisions.mock.calls[0][0]).toMatchObject({
      context: { phase: 'planning' },
      trip: { id: generatedTrip.id },
    })
    expect(applyRevision).not.toHaveBeenCalled()
    await user.click(approve())
    const route = within(screen.getByRole('list', { name: '旅程の路線図' }))
    expect(await route.findByText(after.name)).toBeTruthy()
  })
})
