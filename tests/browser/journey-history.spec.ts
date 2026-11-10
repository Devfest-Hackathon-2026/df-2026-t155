import { expect, test, type BrowserContext } from '@playwright/test'

import { manualOperationId } from '../../src/domain/manual-revision'
import { sampleRevision, sampleTrip } from '../../src/domain/samples'
import { unresolvedApplyStorageKey } from '../../src/features/revision-review/unresolved-apply'

const trip = {
  ...sampleTrip,
  learningApplications: [],
  stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
}
const demoUid = 'journey-history-fixture'
const normalUid = 'normal-journey-fixture'
const listInfo = { returned: 0, skippedInvalid: 0, truncated: false }

async function mockJourney(
  context: BrowserContext,
  initialSavedTrips: (typeof sampleTrip)[] = [],
  onGenerate: () => void = () => {},
  activateDemoMarker = false,
) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const makeToken = (uid: string, provider: string) =>
    [
      encode({ alg: 'none' }),
      encode({ sub: uid, iat: now, exp: now + 3600, firebase: { sign_in_provider: provider } }),
      'fixture',
    ].join('.')
  const idToken = makeToken(demoUid, 'custom')
  const normalToken = makeToken(normalUid, 'anonymous')

  // 明示したフィクスチャ以外の外部通信は止める。Playwrightは後から登録したルートを先に使う。
  await context.route(/^https:\/\//, (route) => route.abort())
  // SDKのHTTP境界だけを差し替えて、アプリの認証状態とルーターを実際に動かす。
  await context.addInitScript((isDemo) => {
    if (isDemo) sessionStorage.setItem('groundtrip-demo-session', 'fixture-demo')
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
  }, activateDemoMarker)
  await context.route('https://www.google.com/recaptcha/**', (route) => route.fulfill({ body: '' }))
  await context.route('https://content-firebaseappcheck.googleapis.com/**', (route) =>
    route.fulfill({ json: { token: 'fixture-app-check', ttl: '3600s' } }),
  )
  await context.route('**/accounts:signInWithCustomToken?*', (route) =>
    route.fulfill({
      json: { idToken, refreshToken: 'fixture-refresh', expiresIn: '3600', localId: demoUid },
    }),
  )
  await context.route('**/accounts:signUp?*', (route) =>
    route.fulfill({
      json: {
        idToken: normalToken,
        refreshToken: 'normal-fixture-refresh',
        expiresIn: '3600',
        localId: normalUid,
      },
    }),
  )
  await context.route('**/accounts:lookup?*', (route) =>
    route.fulfill({
      json: {
        users: [
          {
            localId: route.request().postDataJSON().idToken === normalToken ? normalUid : demoUid,
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
    if (path === '/api/trips/generate') {
      onGenerate()
      return route.fulfill({ json: { status: 'proposed', trip } })
    }
    if (path === '/api/learnings') return route.fulfill({ json: { learnings: [], listInfo } })
    if (path === '/api/trips' && request.method() === 'POST') {
      saveAttempts += 1
      return route.fulfill({ status: 500, json: {} })
    }
    if (path === '/api/trips') {
      const trips = request.headers().authorization === `Bearer ${idToken}` ? initialSavedTrips : []
      return route.fulfill({ json: { trips, listInfo: { ...listInfo, returned: trips.length } } })
    }
    const savedTrip = initialSavedTrips.find((saved) => path === `/api/trips/${saved.id}`)
    if (savedTrip || path === `/api/trips/${trip.id}`)
      return route.fulfill({ json: { trip: savedTrip ?? trip } })
    if (path === `/api/trips/${trip.id}/revisions`)
      return route.fulfill({ json: { revisions: [], listInfo } })
    return route.abort()
  })

  return () => saveAttempts
}

test.use({ viewport: { width: 390, height: 900 } })

test('写真テーマから下書きを続け、Back／Forwardと3つのホーム導線で入力を保つ', async ({
  context,
  page,
}) => {
  let generationRequests = 0
  await mockJourney(context, [], () => generationRequests++)
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/welcome')
  await page.getByRole('button', { name: '旅をはじめる' }).click()
  await page.waitForURL('/')

  const hero = page.getByRole('button', { name: '名古屋城の写真をテーマに選ぶ' })
  await hero.click()
  await expect(hero).toHaveAttribute('aria-pressed', 'true')
  const hope = page.getByLabel('旅の希望（任意）')
  await hope.fill('ゆっくり歩きたい')
  await page.getByRole('button', { name: '旅の条件へ進む' }).click()
  const region = page.getByLabel('旅行先（必須）')
  await expect(region).toHaveValue('名古屋市')
  await page.getByLabel('日付（必須）').fill('2026-11-14')

  await page.goBack()
  await expect(hope).toHaveValue('ゆっくり歩きたい')
  await page.goForward()
  await expect(region).toHaveValue('名古屋市')
  await expect(page.getByLabel('日付（必須）')).toHaveValue('2026-11-14')

  await page.getByRole('button', { name: 'ホーム', exact: true }).click()
  await page.getByRole('button', { name: 'しおり' }).click()
  await expect(page.getByRole('heading', { name: 'しおり' })).toBeVisible()
  await page.goBack()
  await expect(hope).toHaveValue('ゆっくり歩きたい')
  await page.getByRole('button', { name: '記録' }).click()
  await expect(page.getByRole('heading', { name: '記録' })).toBeVisible()
  await page.getByRole('button', { name: 'ホーム', exact: true }).click()
  await expect(hope).toHaveValue('ゆっくり歩きたい')
  expect(generationRequests).toBe(0)
})

test('利用規約からホームへ進み、旅程とホームをBack／Forwardで往復して再開できる', async ({
  context,
  page,
}, testInfo) => {
  const saveAttempts = await mockJourney(context, [], undefined, true)
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/welcome')
  await page.getByRole('button', { name: '旅をはじめる' }).click()
  await page.waitForURL('/')
  await page.getByRole('link', { name: /利用規約・プライバシー/ }).click()
  await page.waitForURL('/terms')

  const logo = page.getByRole('link', { name: 'GroundTrip ホーム' })
  await logo.click()
  await page.waitForURL('/')
  const sessionStatus = page.locator('[data-session-status]')
  await expect(sessionStatus).toBeVisible()
  await expect(sessionStatus).toHaveCount(1)
  await expect(sessionStatus.getByRole('note')).toContainText(
    'デモの旅程・学び・利用枠は共有されます',
  )
  const input = page.getByLabel('旅行先（必須）')
  await page.getByRole('button', { name: /城と歴史/ }).click()
  await page.getByRole('button', { name: '旅の条件へ進む' }).click()
  await input.fill('京都市')
  await page.getByLabel('日付（必須）').fill(trip.date)
  await page.setViewportSize({ width: 390, height: 550 })
  const generate = page.getByRole('button', { name: '旅程を作成する' })
  await generate.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300)
  await generate.click()
  const journey = page.getByRole('heading', { name: '旅程の提案', exact: true })
  await expect(journey).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page.getByText(`${trip.region}の旅程`)).toBeInViewport({ ratio: 1 })
  await expect(sessionStatus).toBeVisible()
  await expect(sessionStatus).toHaveCount(1)
  await expect(sessionStatus.getByRole('note')).toContainText(
    'デモの旅程・学び・利用枠は共有されます',
  )
  await page.screenshot({ path: testInfo.outputPath('itinerary.png'), fullPage: true })
  const historyMarker = await page.evaluate(() => JSON.stringify(history.state.groundTripJourney))
  expect(historyMarker).not.toContain(trip.id)
  expect(historyMarker).not.toContain('京都市')
  await logo.click()
  const resumeTrip = page.getByRole('button', { name: /現在の旅程を開く/ })
  await expect(resumeTrip).toContainText('京都市')

  await page.goBack()
  await expect(journey).toBeVisible()
  await page.goForward()
  await expect(resumeTrip).toBeVisible()
  await expect(input).toHaveValue('京都市')
  const proceed = page.getByRole('button', { name: '旅の条件へ進む' })
  await expect(page.getByRole('heading', { name: '今日は、どこへ行こう。' })).toBeInViewport()
  await proceed.evaluate((element) =>
    window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - 240 }),
  )
  await expect(proceed).toBeInViewport({ ratio: 1 })
  const homeTop = await page.evaluate(() => window.scrollY)
  expect(homeTop).toBeGreaterThan(100)
  await proceed.click()
  await expect(input).toBeVisible()
  await page.getByRole('button', { name: 'ホームの入力へ戻る' }).click()
  await expect(proceed).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(homeTop)
  await resumeTrip.click()
  await expect(journey).toBeVisible()
  expect(saveAttempts()).toBe(0)
})

test('共通ヘッダーから戻っても部分修正と適用確認を保持し、デモ終了後は通常利用へ切り替える', async ({
  context,
  page,
}) => {
  await mockJourney(context, [trip])
  await page.addInitScript(() => localStorage.setItem('groundtrip:welcome-completed:v1', 'true'))
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/')
  const header = page.getByRole('banner')
  const brand = header.getByRole('link', { name: 'GroundTrip ホーム' })
  const exit = header.getByRole('button', { name: 'デモを終了する' })
  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' })
  const resume = page.getByRole('button', { name: /現在の旅程を開く/ })
  const openSaved = page.getByRole('button', { name: '保存した旅程で旅行を続ける' })
  await expect(exit).toBeVisible()
  await nav.getByRole('button', { name: 'しおり' }).click()
  await openSaved.click()
  await page.getByRole('button').filter({ hasText: trip.region }).click()

  await page.getByRole('button', { name: trip.stops[1].name }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'この予定だけ変更' }).click()
  const reason = page.getByLabel('修正理由（必須）')
  await reason.fill('別の店にしたい')
  await expect(header).toHaveCount(1)
  await expect(exit).toBeVisible()
  await brand.click()
  await resume.click()
  await expect(reason).toHaveValue('別の店にしたい')
  await page.getByRole('button', { name: '部分修正を閉じる' }).click()

  // 適用応答が不明になっている、同じUID・旅程の保存済み記録を再現する。
  const key = unresolvedApplyStorageKey(demoUid, trip.id)
  await page.evaluate(
    ({ key, baseVersion }) => {
      localStorage.setItem(key, JSON.stringify({ baseVersion, revisionId: 'fixture-pending' }))
      window.dispatchEvent(new CustomEvent('groundtrip:apply-lock-changed', { detail: key }))
    },
    { key, baseVersion: trip.version },
  )
  const recover = page.getByRole('button', { name: '最新の旅程を取得して確認する' })
  await expect(recover).toBeVisible()
  await brand.click()
  await resume.click()
  await recover.click()
  await expect(page.getByText(/対象の適用を確定できませんでした/)).toBeVisible()
  await expect(page.getByRole('button', { name: '変更する予定を探す' })).toHaveCount(0)

  await exit.click()
  await expect(page.getByRole('heading', { name: 'デモを終了しました' })).toBeVisible()
  await page.getByRole('link', { name: '通常の利用へ' }).click()
  await page.getByRole('button', { name: '新しい利用を始める' }).click()
  await expect(exit).toHaveCount(0)
  await expect(resume).toHaveCount(0)
  await expect(page.getByText(/デモの旅程・学び・利用枠は共有されます/)).toHaveCount(0)
  await nav.getByRole('button', { name: 'しおり' }).click()
  await openSaved.click()
  await expect(page.getByText('保存した旅程はありません。')).toBeVisible()
})

test('保存済み旅程の最終予定と振り返りを往復し、入力と進行位置を保持する', async ({
  context,
  page,
}) => {
  const saveAttempts = await mockJourney(context, [trip])
  await page.setViewportSize({ width: 390, height: 550 })
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/welcome')
  await page.getByRole('button', { name: '旅をはじめる' }).click()
  await page.waitForURL('/')
  await page.getByRole('button', { name: 'しおり' }).click()
  await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
  await page.getByRole('button').filter({ hasText: trip.region }).click()

  const during = page.getByRole('button', { name: '旅行中', exact: true })
  const before = page.getByRole('button', { name: '旅行前', exact: true })
  const start = page.getByRole('button', { name: '旅行中の画面へ' })
  const scrollY = () => page.evaluate(() => window.scrollY)
  await start.scrollIntoViewIfNeeded()
  const beforeTop = await scrollY()
  expect(beforeTop).toBeGreaterThan(300)
  await start.click()
  await expect(during).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(scrollY).toBe(0)
  await expect(page.getByText(`${trip.region}の旅程`)).toBeInViewport({ ratio: 1 })
  await page.goBack()
  await expect(before).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(scrollY).toBe(beforeTop)
  await page.goForward()
  await expect(during).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(scrollY).toBe(0)
  const next = page.getByRole('button', { name: '次の予定へ進む' })
  await next.click()
  await next.click()
  const finish = page.getByRole('button', { name: '旅行を終えて振り返る' })
  await finish.scrollIntoViewIfNeeded()
  const originTop = await scrollY()
  expect(originTop).toBeGreaterThan(100)
  await finish.click()
  const reflection = page.getByRole('heading', { name: '振り返り', exact: true })
  await expect(reflection).toBeFocused()
  await expect(reflection).toBeInViewport({ ratio: 1 })
  await expect.poll(scrollY).toBe(0)
  const feedback = page.getByRole('textbox', { name: /感想・変更した理由/ })
  await feedback.fill('展示が印象に残った')

  await page.goBack()
  await expect(finish).toBeFocused()
  await expect.poll(scrollY).toBe(originTop)
  await expect(page.getByRole('region', { name: 'いまの予定' })).toContainText(trip.stops[2].name)
  await page.goForward()
  await expect(feedback).toHaveValue('展示が印象に残った')
  await page.getByRole('button', { name: '旅程へ戻る', exact: true }).click()
  await expect(finish).toBeFocused()
  await expect.poll(scrollY).toBe(originTop)
  await page.goForward()
  await expect(feedback).toHaveValue('展示が印象に残った')
  expect(saveAttempts()).toBe(0)
  await expect(page).toHaveURL('/')
})

test('候補API失敗後も元の予定カードを紙面表示し、適用しない', async ({ context, page }) => {
  const saveAttempts = await mockJourney(context, [trip])
  let revisionRequests = 0
  let applyRequests = 0
  await context.route('**/api/trips/revise', (route) => {
    revisionRequests += 1
    return route.fulfill({ status: 503, json: {} })
  })
  await context.route('**/api/trips/*/revisions/*/apply', (route) => {
    applyRequests += 1
    return route.fulfill({ status: 500, json: {} })
  })

  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/welcome')
  await page.getByRole('button', { name: '旅をはじめる' }).click()
  await page.waitForURL('/')
  await page.getByRole('button', { name: 'しおり' }).click()
  await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
  await page.getByRole('button').filter({ hasText: trip.region }).click()

  const target = trip.stops[1]
  await page
    .getByRole('button', {
      name: new RegExp(`${target.plannedStartTime}から${target.durationMinutes}分 ${target.name}`),
    })
    .click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('button', { name: 'この予定だけ変更' }).click()
  await page.getByRole('button', { name: 'こだわらない（おまかせで探す）' }).click()

  const alert = page.getByRole('alert').filter({ hasText: '元の旅程を表示しています。' })
  await expect(alert).toContainText('元の旅程を表示しています。')
  expect(revisionRequests).toBe(1)
  expect(applyRequests).toBe(0)
  expect(saveAttempts()).toBe(0)

  const route = page.locator('ol[aria-label="旅程の路線図"]:visible')
  await expect(route).toHaveCount(1)
  const cards = route.locator('.gt-itinerary-stop-card')
  await expect(cards).toHaveCount(trip.stops.length)
  await expect(cards.nth(0)).toContainText(trip.stops[0].name)
  await expect(cards.nth(0)).toContainText('固定予定')
  await expect(cards.nth(1)).toContainText(target.name)
  const visualStyle = await cards.nth(0).evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      display: style.display,
      borderStyle: style.borderStyle,
      backgroundColor: style.backgroundColor,
    }
  })
  expect(visualStyle.display).toBe('flex')
  expect(visualStyle.borderStyle).not.toBe('none')
  expect(visualStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
})

test('予定詳細をEsc・背景・ボタン・Backで閉じ、再訪しても操作できる', async ({
  context,
  page,
}, testInfo) => {
  await mockJourney(context, [trip])
  await page.addInitScript(() => localStorage.setItem('groundtrip:welcome-completed:v1', 'true'))
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/')
  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' })
  const bookmarks = nav.getByRole('button', { name: 'しおり' })
  await bookmarks.click()
  await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
  await page.getByRole('button').filter({ hasText: trip.region }).click()

  const stop = page.getByRole('button', { name: trip.stops[1].name })
  const sheet = page.getByRole('dialog')
  const noModal = page.locator('dialog[open]')
  const backdrop = sheet.locator('[data-sheet-backdrop]')
  const position = { x: 15, y: 15 }
  for (const close of [
    () => page.keyboard.press('Escape'),
    () =>
      testInfo.project.use.hasTouch ? backdrop.tap({ position }) : backdrop.click({ position }),
    () => sheet.getByRole('button', { name: '閉じる', exact: true }).click(),
  ]) {
    await stop.click()
    await expect(sheet).toBeVisible()
    await close()
    await expect(noModal).toHaveCount(0)
    await expect(stop).toBeFocused()
  }

  await stop.click()
  await expect(sheet).toBeVisible()
  await page.goBack()
  await expect(noModal).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'しおり' })).toBeFocused()
  await page.goForward()
  await expect(stop).toBeVisible()
  await expect(noModal).toHaveCount(0)
  await stop.click()
  await expect(sheet).toBeVisible()
  await page.goBack()
  await nav.getByRole('button', { name: '記録' }).click()
  await expect(page.getByRole('heading', { name: '記録' })).toBeVisible()
})

for (const width of [320, 390]) {
  test(`${width}pxの予定詳細で長い施設名、根拠、固定操作を扱える`, async ({
    browserName,
    context,
    page,
  }) => {
    await page.setViewportSize({ width, height: 550 })
    const target = {
      ...sampleTrip.stops[1],
      name: '京都の歴史と文化を紹介する展示と街並みの資料を見られる小さな資料館（架空）',
    }
    const saved = { ...trip, stops: [trip.stops[0], target, trip.stops[2]] }
    await mockJourney(context, [saved])
    await page.addInitScript(() => localStorage.setItem('groundtrip:welcome-completed:v1', 'true'))
    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 24 } })
    }
    await page.goto('/access#ticket=' + 'a'.repeat(43))
    await page.waitForURL('/')
    await page.getByRole('button', { name: 'しおり' }).click()
    await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
    await page.getByRole('button').filter({ hasText: trip.region }).click()
    const stop = page.getByRole('button', { name: target.name })
    const card = page.locator('.gt-itinerary-stop-card').filter({ hasText: target.name })
    await expect(card).toHaveCSS('background-image', /repeating-linear-gradient/)
    await stop.scrollIntoViewIfNeeded()
    const scrollY = () => page.evaluate(() => window.scrollY)
    const routeTop = await scrollY()
    expect(routeTop).toBeGreaterThan(100)
    await stop.click()

    const dialog = page.getByRole('dialog')
    const sheet = dialog.locator('.gt-sheet')
    const heading = sheet.getByRole('heading', { name: target.name })
    const scroll = sheet.locator('[data-sheet-scroll]')
    const actions = sheet.locator('[data-sheet-actions]')
    await expect(heading).toBeFocused()
    await expect(heading).toBeInViewport({ ratio: 1 })
    await expect(sheet).toHaveCSS('background-image', 'none')
    await expect(actions).toHaveCSS(
      'background-color',
      await sheet.evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    await expect(actions).toHaveCSS('position', 'sticky')
    await expect(actions).toHaveCSS('padding-bottom', browserName === 'chromium' ? '24px' : '12px')
    expect(await scroll.evaluate((element) => element.scrollWidth)).toBe(
      await scroll.evaluate((element) => element.clientWidth),
    )
    await expect(sheet.getByText('未確認', { exact: true })).toBeVisible()
    await sheet.getByText('根拠を見る', { exact: true }).click()
    await expect(sheet.getByText(/臨時休業の模擬報告/)).toBeVisible()
    await scroll.evaluate((element) => (element.scrollTop = element.scrollHeight))
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const fixed = sheet.getByRole('button', { name: 'この予定を固定する' })
    await expect(fixed).toBeInViewport({ ratio: 1 })
    await fixed.click()
    await expect(sheet.getByRole('button', { name: '固定を解除する' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect.poll(scrollY).toBe(routeTop)
    await page.keyboard.press('Escape')
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(stop).toBeFocused()
    await expect.poll(scrollY).toBe(routeTop)

    await stop.click()
    const handle = sheet.locator('[data-sheet-handle]')
    await expect(handle).toBeVisible()
    const bounds = (await handle.boundingBox())!
    const x = bounds.x + bounds.width / 2
    const y = bounds.y + bounds.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + 110, { steps: 8 })
    await page.mouse.up()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(stop).toBeFocused()
    await expect.poll(scrollY).toBe(routeTop)
  })
}

test('旅程内の候補切替でページ先頭へ戻らない', async ({ context, page }) => {
  await page.setViewportSize({ width: 390, height: 550 })
  await mockJourney(context, [trip])
  await context.route('**/api/trips/revise', (route) => {
    const target = trip.stops[1]
    const first = {
      ...sampleRevision,
      reason: route.request().postDataJSON().reason,
      context: { phase: 'planning' },
      diff: { ...sampleRevision.diff, before: target },
    }
    return route.fulfill({
      json: {
        status: 'proposed',
        revisions: [
          first,
          {
            ...first,
            id: 'fixture-candidate-two',
            diff: { before: target, after: { ...first.diff.after, name: '昼食店C（架空候補）' } },
          },
        ],
      },
    })
  })
  await page.addInitScript(() => localStorage.setItem('groundtrip:welcome-completed:v1', 'true'))
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/')
  await page.getByRole('button', { name: 'しおり' }).click()
  await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
  await page.getByRole('button', { name: trip.region }).click()
  await page.getByRole('button', { name: trip.stops[1].name }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'この予定だけ変更' }).click()
  await page.getByRole('button', { name: 'こだわらない（おまかせで探す）' }).click()
  const candidate = page.getByRole('button', { name: /候補 B/ })
  await expect(candidate).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 120))
  await expect(candidate).toBeInViewport({ ratio: 1 })
  await candidate.click()
  await expect(candidate).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(120)
})

for (const width of [390, 1440]) {
  test.describe(`${width}pxの旅程画面`, () => {
    if (width === 1440) test.use({ isMobile: false, hasTouch: false })
    test(`${width}pxで旅行前・旅行中の切替と共通ブランドの配色が読み取れる`, async ({
      context,
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await mockJourney(context, [trip])
      await page.addInitScript(() =>
        localStorage.setItem('groundtrip:welcome-completed:v1', 'true'),
      )
      await page.goto('/access#ticket=' + 'a'.repeat(43))
      await page.waitForURL('/')
      const header = page.getByRole('banner')
      const brand = header.getByRole('link', { name: 'GroundTrip ホーム' })
      const logo = brand.locator('img')
      const headerBackground = await header.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      )
      await page.getByRole('button', { name: 'しおり' }).click()
      await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
      await page.getByRole('button').filter({ hasText: trip.region }).click()

      const before = page.getByRole('button', { name: '旅行前', exact: true })
      const during = page.getByRole('button', { name: '旅行中', exact: true })
      await expect(before).toHaveAttribute('aria-pressed', 'true')
      await expect(before.locator('span')).toHaveCSS('color', 'rgb(255, 255, 255)')
      await expect(before.locator('span')).toHaveCSS('background-color', 'rgb(25, 29, 32)')
      await expect(during.locator('span')).toHaveCSS('color', 'rgb(25, 29, 32)')
      await expect(during.locator('span')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(header).toHaveCSS('background-color', headerBackground)
      await expect(logo).toBeVisible()
      await expect(brand).toHaveCSS('background-color', 'rgb(255, 255, 255)')
      if (width === 1440) {
        await brand.hover()
        await expect(brand).toHaveCSS('background-color', 'rgb(243, 243, 238)')
        await page.mouse.move(0, 0)
      }
      await page.keyboard.press('Tab')
      await brand.focus()
      await expect(brand).toBeFocused()
      await expect(brand).toHaveCSS('outline-color', 'rgb(29, 85, 160)')
      await expect(logo).toBeVisible()

      await during.click()
      await expect(during).toHaveAttribute('aria-pressed', 'true')
      await expect(during.locator('span')).toHaveCSS('color', 'rgb(255, 255, 255)')
      await expect(during.locator('span')).toHaveCSS('background-color', 'rgb(25, 29, 32)')
      await expect(before.locator('span')).toHaveCSS('color', 'rgb(25, 29, 32)')
      await expect(header).toHaveCSS('background-color', headerBackground)
      await expect(logo).toBeVisible()
    })
  })
}

test('WebKitでNext.jsが同じURLの履歴を更新しても、Back／Forwardで旅程を再表示する', async ({
  browserName,
  context,
  page,
}) => {
  test.skip(browserName !== 'webkit', 'WebKitで報告された履歴の回帰')
  await mockJourney(context, [trip])
  await page.addInitScript(() => {
    localStorage.setItem('groundtrip:welcome-completed:v1', 'true')
    const replace = history.replaceState
    history.replaceState = function (...args) {
      replace.apply(this, args)
      window.dispatchEvent(new Event('test:history-replaced'))
    }
  })
  await page.goto('/access#ticket=' + 'a'.repeat(43))
  await page.waitForURL('/')
  await page.getByRole('button', { name: 'しおり' }).click()
  await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
  await page.getByRole('button').filter({ hasText: trip.region }).click()
  const stop = page.getByRole('button', { name: trip.stops[1].name })
  const marker = await page.evaluate(() => history.state.groundTripJourney)

  await stop.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  // 同一URLの再描画でNext.js自身のreplaceStateを発生させる。
  await page.evaluate(async () => {
    const replaced = new Promise<void>((resolve) =>
      window.addEventListener('test:history-replaced', () => resolve(), { once: true }),
    )
    const next = Reflect.get(window, 'next') as { router: { refresh: () => void } }
    next.router.refresh()
    await replaced
  })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'しおり' })).toBeFocused()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await page.goForward()
    await expect(stop).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    expect(await page.evaluate(() => history.state)).toMatchObject({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: expect.any(Array),
      groundTripJourney: marker,
    })
  }
})

for (const lostResponse of [false, true]) {
  test(
    lostResponse
      ? '通信断で再読み込みした後も同じ手動承認を再送して復旧できる'
      : 'モバイル幅で未確認候補を自分で確認し、本人の判断で適用できる',
    async ({ context, page }) => {
      await mockJourney(context, [trip])
      const target = trip.stops[1]
      const grantId = `manual-${sampleRevision.id}`
      const token = `m2.e30.${'A'.repeat(43)}`
      const candidate = {
        ...sampleRevision,
        reason: '訪問先を見直す',
        context: { phase: 'planning' },
        diff: {
          before: target,
          after: {
            ...target,
            name: '本人が確認した候補',
            placeId: 'fixture-candidate',
            evidence: [],
          },
        },
        constraintCheck: {
          status: 'unknown',
          explanation: '訪問日の営業時間を確認できませんでした。',
        },
      }
      const confirmation = {
        source: 'https://example.com/hours',
        checked: '訪問日の営業時間',
        remaining: '臨時休業',
      }
      const id = await manualOperationId({ id: grantId, token }, confirmation)
      const changedStop = { ...candidate.diff.after, manualRevisionId: id }
      const updated = {
        ...trip,
        version: trip.version + 1,
        stops: trip.stops.map((stop, index) => (index === 1 ? changedStop : stop)),
      }
      await context.route('**/api/trips/revise', (route) =>
        route.fulfill({
          json: {
            status: 'proposed',
            revisions: [candidate],
            manualGrants: { [candidate.id]: { id: grantId, token } },
          },
        }),
      )
      let approvals = 0
      await context.route(`**/api/trips/${trip.id}/revisions/${id}/manual-apply`, (route) => {
        approvals += 1
        expect(route.request().postDataJSON()).toEqual({
          expectedVersion: trip.version,
          token,
          confirmation,
          confirm: true,
        })
        if (lostResponse && approvals === 1) return route.abort()
        return route.fulfill({
          json: {
            status: lostResponse ? 'already_applied' : 'applied',
            appliedTripVersion: updated.version,
            trip: updated,
            revision: {
              ...candidate,
              id,
              method: 'manual',
              confirmation,
              approval: { status: 'approved', decidedAt: new Date().toISOString() },
              diff: { before: target, after: changedStop },
            },
          },
        })
      })

      await page.setViewportSize({ width: 320, height: 740 })
      await page.addInitScript(() =>
        localStorage.setItem('groundtrip:welcome-completed:v1', 'true'),
      )
      await page.goto('/access#ticket=' + 'a'.repeat(43))
      await page.waitForURL('/')
      const openSavedTrip = async () => {
        await page.getByRole('button', { name: 'しおり' }).click()
        await page.getByRole('button', { name: '保存した旅程で旅行を続ける' }).click()
        await page.getByRole('button').filter({ hasText: trip.region }).click()
      }
      await openSavedTrip()
      await page
        .getByRole('button', {
          name: new RegExp(`${target.plannedStartTime}から${target.durationMinutes}分`),
        })
        .click()
      await page.getByRole('dialog').getByRole('button', { name: 'この予定だけ変更' }).click()
      await page.getByLabel('修正理由（必須）').fill(candidate.reason)
      await page.getByRole('button', { name: '変更候補を探す' }).click()
      await page.getByRole('button', { name: '自分で確認する' }).click()
      await expect(page.getByText('システムの判定：未確認')).toBeVisible()
      await page.getByLabel(/確認した情報源/).fill(confirmation.source)
      await page.getByLabel('自分で確認した内容').fill(confirmation.checked)
      await page.getByLabel('確認できなかった事項（任意）').fill(confirmation.remaining)
      await page.getByRole('button', { name: '本人の確認記録を確認する' }).click()
      await expect(page.getByText(confirmation.source)).toBeVisible()
      await expect(page.getByText(confirmation.remaining)).toBeVisible()
      expect(approvals).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
      await page.getByRole('button', { name: '本人の判断で承認して適用' }).click()
      if (lostResponse) {
        await expect(
          page.getByRole('alert').filter({ hasText: '適用結果を確認できませんでした' }),
        ).toBeVisible()
        await page.reload()
        await openSavedTrip()
        await page.getByRole('button', { name: '同じ承認内容で再送する' }).click()
      }

      const route = page.locator('ol[aria-label="旅程の路線図"]:visible')
      await expect(route).toContainText('本人の確認で採用')
      await expect(route).toContainText(changedStop.name)
      await expect(route).toContainText(trip.stops[0].name)
      await expect(route).toContainText(trip.stops[2].name)
      await expect(route).not.toContainText(target.name)
      expect(approvals).toBe(lostResponse ? 2 : 1)
    },
  )
}
