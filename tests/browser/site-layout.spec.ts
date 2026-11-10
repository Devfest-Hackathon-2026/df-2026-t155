import { expect, test, type Locator } from '@playwright/test'

const widths = [320, 375, 390, 1023, 1024, 1440]

test.beforeEach(async ({ context, page }) => {
  await context.route(/^https:\/\//, (route) => route.abort())
  await page.addInitScript(() => localStorage.setItem('groundtrip:welcome-completed:v1', 'true'))
})

for (const width of widths) {
  test(`${width}pxで共通ヘッダー・写真一覧・規約リンクを操作できる`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 850 })
    await context.route('https://{maps.google.com,policies.google.com}/**', (route) =>
      route.fulfill({ body: 'Legal link fixture' }),
    )
    await page.goto('/')

    const header = page.getByRole('banner')
    const brand = header.getByRole('link', { name: 'GroundTrip ホーム' })
    await expect(brand).toBeVisible()
    await expect(brand.locator('img')).toHaveAttribute('src', /groundtrip-logo\.png/)
    const nav = page.getByRole('navigation', { name: 'メインナビゲーション' })
    const home = nav.getByRole('button', { name: 'ホーム', exact: true })
    await expect(nav).toHaveCount(1)
    await expect(nav).toBeInViewport({ ratio: 1 })
    await expect(home).toHaveAttribute('aria-current', 'page')
    await expect(header.getByRole('navigation')).toHaveCount(width >= 1024 ? 1 : 0)

    const photos = page.getByRole('region', { name: '写真から旅のテーマを探す（任意）' })
    const cards = photos.getByRole('button')
    await expect(cards).toHaveCount(5)
    const layout = await cards
      .first()
      .locator('..')
      .evaluate((element) => {
        const first = element.firstElementChild!.getBoundingClientRect()
        const last = element.lastElementChild!.getBoundingClientRect()
        return {
          firstTop: first.top,
          thirdTop: element.children[2].getBoundingClientRect().top,
          lastTop: last.top,
          containerWidth: element.clientWidth,
          contentWidth: element.scrollWidth,
        }
      })
    if (width >= 1024) {
      expect(layout.thirdTop).toBe(layout.firstTop)
      expect(layout.lastTop).toBeGreaterThan(layout.firstTop)
      expect(layout.contentWidth).toBe(layout.containerWidth)
    } else {
      expect(layout.contentWidth).toBeGreaterThan(layout.containerWidth)
      await cards.last().scrollIntoViewIfNeeded()
      await expect(cards.last()).toBeInViewport()
    }

    await nav.getByRole('button', { name: 'しおり' }).click()
    await expect(page.getByRole('heading', { name: 'しおり' })).toBeVisible()
    await nav.getByRole('button', { name: '記録' }).click()
    await expect(page.getByRole('heading', { name: '記録' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'しおり' })).toBeVisible()
    await page.goForward()
    await expect(page.getByRole('heading', { name: '記録' })).toBeVisible()
    await brand.click()
    await expect(home).toHaveAttribute('aria-current', 'page')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)

    // 最下部にスクロールし、各リンクを実際にクリックして遷移先を確認する。
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('link', { name: /Googleプライバシーポリシー/ })).toBeInViewport({
      ratio: 1,
    })
    for (const [name, url] of [
      ['Googleプライバシーポリシー', 'https://policies.google.com/privacy'],
      ['Google利用規約', 'https://policies.google.com/terms'],
      ['Google Maps追加利用規約', 'https://maps.google.com/help/terms_maps/'],
    ] as const) {
      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        footer.getByRole('link', { name }).click(),
      ])
      await popup.waitForURL(url)
      await popup.close()
    }
    await footer.getByRole('link', { name: /利用規約・プライバシー/ }).click()
    await expect(page).toHaveURL('/terms')
    await brand.click()
    await expect(home).toHaveAttribute('aria-current', 'page')
  })
}

test('写真検索に一致しなくても行き先と希望が旅程条件に引き継がれる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 })
  await page.goto('/')
  await page.getByLabel('行き先', { exact: true }).fill('奈良市')
  await page.getByLabel('旅の希望（任意）').fill('ゆっくり歩きたい')
  await page.getByLabel('写真テーマを絞り込む').fill('奈良')
  await expect(page.getByText(/一致する写真テーマはありません/)).toBeVisible()
  await page.getByRole('button', { name: '旅の条件へ進む' }).click()
  await expect(page.getByLabel('旅行先（必須）')).toHaveValue('奈良市')
  await expect(page.getByLabel('希望条件（任意）')).toHaveValue('ゆっくり歩きたい')
})

test('写真の選択で行き先とテーマを反映し、手入力の希望も引き継ぐ', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByLabel('旅の希望（任意）').fill('途中で座って休みたい')
  await page.getByLabel('写真テーマを絞り込む').fill('熱田')
  const photo = page.getByRole('button', { name: /神社と緑/ })
  await photo.click()
  await expect
    .poll(() => photo.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0)
  const homeRegion = page.getByLabel('行き先', { exact: true })
  const proceed = page.getByRole('button', { name: '旅の条件へ進む' })
  const region = page.getByLabel('旅行先（必須）')
  const hope = page.getByLabel('希望条件（任意）')
  const preferences = '緑のある場所や歴史・文化を感じる場所をゆっくり歩きたい\n途中で座って休みたい'

  await expect(homeRegion).toHaveValue('名古屋市熱田区')
  await proceed.click()
  await expect(region).toHaveValue('名古屋市熱田区')
  await expect(hope).toHaveValue(preferences)

  await page.getByRole('button', { name: 'ホームの入力へ戻る' }).click()
  await homeRegion.fill('京都市')
  await proceed.click()
  await expect(region).toHaveValue('京都市')
  await expect(hope).toHaveValue(preferences)
})

test('詳細条件の再訪で上書きせず、ホームで変更した項目だけを反映する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/')
  await page.waitForFunction(() => Boolean(history.state?.groundTripJourney))
  const homeRegion = page.getByLabel('行き先', { exact: true })
  const homeHope = page.getByLabel('旅の希望（任意）')
  const next = page.getByRole('button', { name: '旅の条件へ進む' })
  const home = page.getByRole('button', { name: 'ホームの入力へ戻る' })
  const region = page.getByLabel('旅行先（必須）')
  const hope = page.getByLabel('希望条件（任意）')
  const date = page.getByLabel('日付（必須）')
  const stop = page.getByLabel('予定の名前')
  const time = page.getByLabel('開始時刻')
  const duration = page.getByLabel('滞在時間（分）')

  await homeRegion.fill('奈良市')
  await homeHope.fill('ゆっくり歩く')
  await next.click()
  await region.fill('京都市')
  await hope.fill('昼は精進料理')
  await date.fill('2026-11-14')
  await page.getByRole('button', { name: '固定予定を追加' }).click()
  await stop.fill('展示')
  await time.fill('14:00')
  await duration.fill('45')

  await home.click()
  await expect(homeRegion).toHaveValue('京都市')
  await expect(homeHope).toHaveValue('昼は精進料理')
  await next.click()
  await expect(region).toHaveValue('京都市')
  await expect(hope).toHaveValue('昼は精進料理')

  await home.click()
  await homeRegion.fill('宇治市')
  await next.click()
  await expect(region).toHaveValue('宇治市')
  await expect(hope).toHaveValue('昼は精進料理')

  await region.fill('京都市東山区')
  await home.click()
  await homeHope.fill('') // 空欄への変更も反映する。
  await next.click()
  await expect(region).toHaveValue('京都市東山区')
  await expect(hope).toHaveValue('')
  await expect(date).toHaveValue('2026-11-14')
  await expect(stop).toHaveValue('展示')
  await expect(time).toHaveValue('14:00')
  await expect(duration).toHaveValue('45')
})

test('写真の選択・解除・再選択と行き先の明示採用を分ける', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/')
  const region = page.getByLabel('行き先', { exact: true })
  const castle = page.getByRole('button', { name: /城と歴史/ })
  const atsuta = page.getByRole('button', { name: /神社と緑/ })
  const clear = page.getByRole('button', { name: 'テーマを外す' })
  const next = page.getByRole('button', { name: '旅の条件へ進む' })
  const home = page.getByRole('button', { name: 'ホームの入力へ戻る' })
  const detailRegion = page.getByLabel('旅行先（必須）')
  const detailHope = page.getByLabel('希望条件（任意）')

  await region.fill('京都市')
  await page.getByLabel('旅の希望（任意）').fill('昼は精進料理')
  await castle.click()
  await expect(region).toHaveValue('京都市')
  await next.click()
  await expect(detailRegion).toHaveValue('京都市')
  await expect(detailHope).toHaveValue('歴史的な建築や街並みを楽しみたい\n昼は精進料理')
  await home.click()

  await page.getByRole('button', { name: '名古屋市を行き先に使う' }).click()
  await expect(region).toHaveValue('名古屋市')
  await atsuta.click()
  await expect(region).toHaveValue('名古屋市')
  await page.getByRole('button', { name: '写真の行き先を解除' }).click()
  await expect(region).toHaveValue('京都市')
  await expect(atsuta).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '名古屋市熱田区を行き先に使う' }).click()
  await clear.click()
  await expect(region).toHaveValue('名古屋市熱田区')
  await next.click()
  await expect(detailRegion).toHaveValue('名古屋市熱田区')
  await expect(detailHope).toHaveValue('昼は精進料理')
  await home.click()
  await next.click()
  await expect(detailRegion).toHaveValue('名古屋市熱田区')
  await expect(detailHope).toHaveValue('昼は精進料理')
})

test('詳細条件で先に入力した行き先と希望を、写真の選択でも保持する', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/')
  const next = page.getByRole('button', { name: '旅の条件へ進む' })
  await next.click()
  const region = page.getByLabel('旅行先（必須）')
  const hope = page.getByLabel('希望条件（任意）')
  await region.fill('奈良市')
  await hope.fill('昼は精進料理')
  await page.getByRole('button', { name: 'ホームの入力へ戻る' }).click()
  await page.getByRole('button', { name: /城と歴史/ }).click()
  await expect(page.getByLabel('行き先', { exact: true })).toHaveValue('奈良市')
  await next.click()
  await expect(region).toHaveValue('奈良市')
  await expect(hope).toHaveValue('歴史的な建築や街並みを楽しみたい\n昼は精進料理')
})

test('キーボードで遷移先の見出しへ移り、1023／1024pxで同じナビ項目にフォーカスを引き継ぐ', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1023, height: 900 })
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' })
  const bookmarks = nav.getByRole('button', { name: 'しおり' })
  const records = nav.getByRole('button', { name: '記録' })
  const header = page.getByRole('banner')

  await bookmarks.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'しおり' })).toBeFocused()
  await records.focus()
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(header.getByRole('navigation')).toHaveCount(1)
  await expect(records).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByRole('heading', { name: '記録' })).toBeFocused()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'しおり' })).toBeFocused()
  await page.goForward()
  await expect(page.getByRole('heading', { name: '記録' })).toBeFocused()

  await bookmarks.focus()
  await page.setViewportSize({ width: 1023, height: 900 })
  await expect(header.getByRole('navigation')).toHaveCount(0)
  await expect(bookmarks).toBeFocused()
  if (testInfo.project.use.hasTouch) await bookmarks.tap()
  else await bookmarks.click()
  await expect(page.getByRole('heading', { name: 'しおり' })).not.toBeFocused()
  await header.getByRole('link', { name: 'GroundTrip ホーム' }).press('Enter')
  await expect(page.getByRole('heading', { name: '今日は、どこへ行こう。' })).toBeFocused()
})

test('詳細条件で希望を編集しても写真の行き先を解除して手入力に戻せる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/')
  const region = page.getByLabel('行き先', { exact: true })
  const proceed = page.getByRole('button', { name: '旅の条件へ進む' })
  const returnHome = page.getByRole('button', { name: 'ホームの入力へ戻る' })
  const detailRegion = page.getByLabel('旅行先（必須）')
  const detailHope = page.getByLabel('希望条件（任意）')
  await region.fill('奈良市')
  await page.getByRole('button', { name: /城と歴史/ }).click()
  await page.getByRole('button', { name: '名古屋市を行き先に使う' }).click()
  await proceed.click()
  await detailHope.fill('昼は精進料理')
  await returnHome.click()
  await expect(region).toHaveValue('名古屋市')
  await page.getByRole('button', { name: '写真の行き先を解除' }).click()
  await expect(region).toHaveValue('奈良市')
  await proceed.click()
  await expect(detailRegion).toHaveValue('奈良市')
  await expect(detailHope).toHaveValue('昼は精進料理')

  await returnHome.click()
  await page.getByRole('button', { name: /城と歴史/ }).click()
  await page.getByRole('button', { name: '名古屋市を行き先に使う' }).click()
  await proceed.click()
  await detailRegion.fill('京都市')
  await detailHope.fill('庭園を訪ねる')
  await returnHome.click()
  await expect(region).toHaveValue('京都市')
  await expect(page.getByRole('button', { name: '写真の行き先を解除' })).toHaveCount(0)
})

test('短い画面で詳細条件の先頭を表示し、Back／Forwardとホームへの復帰位置を分ける', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 550 })
  await page.goto('/')
  const heading = page.getByRole('heading', { name: '今日は、どこへ行こう。' })
  const detailHeading = page.getByRole('heading', { name: '日帰り旅程を作る' })
  const proceed = page.getByRole('button', { name: '旅の条件へ進む' })
  const generate = page.getByRole('button', { name: '旅程を作成する' })
  const returnHome = page.getByRole('button', { name: 'ホームの入力へ戻る' })
  const homeTab = page
    .getByRole('navigation', { name: 'メインナビゲーション' })
    .getByRole('button', { name: 'ホーム' })
  const scrollY = () => page.evaluate(() => window.scrollY)

  const castle = page.getByRole('button', { name: /城と歴史/ })
  await castle.scrollIntoViewIfNeeded()
  expect(await scrollY()).toBeGreaterThan(200)
  await castle.click()
  expect(await scrollY()).toBeGreaterThan(200)

  await proceed.evaluate((element) =>
    window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - 240 }),
  )
  await expect(proceed).toBeInViewport({ ratio: 1 })
  const homeTop = await scrollY()
  expect(homeTop).toBeGreaterThan(200)
  await proceed.click()
  await expect(detailHeading).toBeFocused()
  await expect(detailHeading).toBeInViewport({ ratio: 1 })
  await expect.poll(scrollY).toBe(0)
  await generate.scrollIntoViewIfNeeded()
  const detailTop = await scrollY()
  expect(detailTop).toBeGreaterThan(300)

  await page.goBack()
  await expect(heading).toBeVisible()
  await expect.poll(scrollY).toBe(homeTop)
  await page.goForward()
  await expect(generate).toBeInViewport()
  await expect.poll(scrollY).toBe(detailTop)
  if (testInfo.project.use.hasTouch) await homeTab.tap()
  else await homeTab.click()
  await expect(heading).toBeVisible()
  await expect(heading).not.toBeFocused()
  await expect.poll(scrollY).toBe(homeTop)

  await proceed.click()
  await returnHome.press('Enter')
  await expect(heading).toBeFocused()
  await expect(heading).toBeInViewport({ ratio: 1 })
})

test.describe('PCナビのコントラスト', () => {
  test.use({ isMobile: false, hasTouch: false })

  test('通常項目と現在項目の文字はhoverとキーボードフォーカスでも4.5対1以上', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    const header = page.getByRole('banner')
    const nav = header.getByRole('navigation', { name: 'メインナビゲーション' })
    const current = nav.getByRole('button', { name: 'ホーム' })
    const other = nav.getByRole('button', { name: 'しおり' })
    await expect(current).toHaveAttribute('aria-current', 'page')
    await expect(other).not.toHaveAttribute('aria-current')
    const background = await header.evaluate((element) => getComputedStyle(element).backgroundColor)
    const contrast = (button: Locator) =>
      button.evaluate((element, headerBackground) => {
        const style = getComputedStyle(element)
        const luminance = (color: string) => {
          const [r, g, b] = [...color.matchAll(/\d+/g)].map(([channel]) => {
            const value = Number(channel) / 255
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const colors = [
          luminance(style.color),
          luminance(
            style.backgroundColor === 'rgba(0, 0, 0, 0)' ? headerBackground : style.backgroundColor,
          ),
        ]
        return (Math.max(...colors) + 0.05) / (Math.min(...colors) + 0.05)
      }, background)

    for (const button of [current, other]) {
      await page.mouse.move(0, 0)
      expect(await contrast(button)).toBeGreaterThanOrEqual(4.5)
      await button.hover()
      await expect(button).toHaveCSS('background-color', 'rgb(243, 243, 238)')
      expect(await contrast(button)).toBeGreaterThanOrEqual(4.5)
      await page.mouse.move(0, 0)
      await page.keyboard.press('Tab')
      await button.focus()
      await expect(button).toBeFocused()
      await expect(button).toHaveCSS('outline-color', 'rgb(29, 85, 160)')
      await expect(button).toHaveCSS('outline-width', '2px')
      expect(await contrast(button)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
