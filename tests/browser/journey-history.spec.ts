import { expect, test, type BrowserContext } from '@playwright/test'

import { sampleTrip } from '../../src/domain/samples'

const trip = {
  ...sampleTrip,
  learningApplications: [],
  stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
}
const listInfo = { returned: 0, skippedInvalid: 0, truncated: false }

async function mockJourney(context: BrowserContext, initialSavedTrips: (typeof trip)[] = []) {
  const uid = 'journey-history-fixture'
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const idToken = [
    encode({ alg: 'none' }),
    encode({ sub: uid, iat: now, exp: now + 3600, firebase: { sign_in_provider: 'custom' } }),
    'fixture',
  ].join('.')

  // SDKのHTTP境界だけを差し替えて、アプリの認証状態とルーターを実際に動かす。
  await context.addInitScript(() => {
    let completed: () => void
    const enterprise = {
      ready: (start: () => void) => start(),
      render: (_container: unknown, options: { callback: () => void }) => {
        completed = options.callback
        return 0
      },
      execute: async () => {
        completed()
        return 'fixture-recaptcha'
      },
    }
    Object.assign(window, { grecaptcha: { enterprise } })
  })
  await context.route('https://www.google.com/recaptcha/**', (route) => route.fulfill({ body: '' }))
  await context.route('https://content-firebaseappcheck.googleapis.com/**', (route) =>
    route.fulfill({ json: { token: 'fixture-app-check', ttl: '3600s' } }),
  )
  await context.route('**/accounts:signInWithCustomToken?*', (route) =>
    route.fulfill({
      json: { idToken, refreshToken: 'fixture-refresh', expiresIn: '3600', localId: uid },
    }),
  )
  await context.route('**/accounts:lookup?*', (route) =>
    route.fulfill({
      json: {
        users: [
          {
            localId: uid,
            providerUserInfo: [],
            createdAt: String(now * 1000),
            lastLoginAt: String(now * 1000),
          },
        ],
      },
    }),
  )

  let saveAttempts = 0
  await context.route('**/api/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/access/exchange')
      return route.fulfill({ json: { customToken: 'fixture.custom.token' } })
    if (path === '/api/trips/generate') return route.fulfill({ json: { status: 'proposed', trip } })
    if (path === '/api/learnings') return route.fulfill({ json: { learnings: [], listInfo } })
    if (path === '/api/trips' && request.method() === 'POST') {
      saveAttempts += 1
      return route.fulfill({ status: 500, json: {} })
    }
    if (path === '/api/trips') {
      return route.fulfill({
        json: {
          trips: initialSavedTrips,
          listInfo: { ...listInfo, returned: initialSavedTrips.length },
        },
      })
    }
    if (path === `/api/trips/${trip.id}`) return route.fulfill({ json: { trip } })
    if (path === `/api/trips/${trip.id}/revisions`)
      return route.fulfill({ json: { revisions: [], listInfo } })
    return route.abort()
  })

  return () => saveAttempts
}

test.use({ viewport: { width: 390, height: 900 } })

test('利用規約からホームへ進み、生成後のロゴ操作をBack／Forwardでたどる', async ({
  context,
  page,
}) => {
  const saveAttempts = await mockJourney(context)
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/')
  await page.getByRole('link', { name: /利用規約・プライバシー/ }).click()
  await page.waitForURL('/terms')

  const logo = page.getByRole('link', { name: 'GroundTrip ホーム' })
  await logo.click()
  await page.waitForURL('/')
  const input = page.getByLabel('旅行先（必須）')
  await input.fill('京都市')
  await page.getByLabel('日付（必須）').fill(trip.date)
  await page.getByRole('button', { name: '旅程を作成する' }).click()
  const journey = page.getByRole('heading', { name: '旅程の提案', exact: true })
  await expect(journey).toBeVisible()
  const historyMarker = await page.evaluate(() => JSON.stringify(history.state.groundTripJourney))
  expect(historyMarker).not.toContain(trip.id)
  expect(historyMarker).not.toContain('京都市')
  await logo.click()
  await expect(input).toHaveValue('京都市')

  await page.goBack()
  await expect(journey).toBeVisible()
  await page.goForward()
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('京都市')
  await page.getByRole('button', { name: '旅程へ戻る', exact: true }).click()
  await expect(journey).toBeVisible()
  await page.goForward()
  await expect(input).toBeVisible()
  expect(saveAttempts()).toBe(0)
})

test('保存済み旅程の最終予定と振り返りを往復し、入力と進行位置を保持する', async ({
  context,
  page,
}) => {
  const saveAttempts = await mockJourney(context, [trip])
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/')
  await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
  await page.getByRole('button').filter({ hasText: trip.region }).click()

  const during = page.getByRole('button', { name: '旅行中', exact: true })
  const before = page.getByRole('button', { name: '旅行前', exact: true })
  await during.click()
  await page.goBack()
  await expect(before).toHaveAttribute('aria-pressed', 'true')
  await page.goForward()
  await expect(during).toHaveAttribute('aria-pressed', 'true')
  const next = page.getByRole('button', { name: '次の予定へ進む' })
  await next.click()
  await next.click()
  const finish = page.getByRole('button', { name: '旅行を終えて振り返る' })
  await finish.click()
  const feedback = page.getByRole('textbox', { name: /感想・変更した理由/ })
  await feedback.fill('展示が印象に残った')

  await page.goBack()
  await expect(finish).toBeFocused()
  await expect(page.getByRole('region', { name: 'いまの予定' })).toContainText(trip.stops[2].name)
  await page.goForward()
  await expect(feedback).toHaveValue('展示が印象に残った')
  await page.getByRole('button', { name: '旅程へ戻る', exact: true }).click()
  await expect(finish).toBeFocused()
  await page.goForward()
  await expect(feedback).toHaveValue('展示が印象に残った')
  expect(saveAttempts()).toBe(0)
  await expect(page).toHaveURL('/')
})
