import { expect, test } from '@playwright/test'

for (const width of [320, 390, 1440]) {
  test(`架空デモの旅程と部分修正を ${width}px で操作できる`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 })
    const apiRequests: string[] = []
    await page.route(
      (url) => url.origin !== baseURL || url.pathname.startsWith('/api/'),
      (route) => {
        apiRequests.push(route.request().url())
        return route.abort()
      },
    )
    const expectNoOverflow = async () => {
      expect(
        await page.evaluate(() => {
          const { scrollWidth, clientWidth } = document.documentElement
          return scrollWidth - clientWidth
        }),
      ).toBe(0)
    }

    await page.goto('/demo')
    const main = page.getByRole('main')
    const demoTitle = main.getByRole('heading', { name: '旅程の路線図（モック）' })
    await expect(demoTitle).toBeVisible()
    await expect(page.getByRole('banner')).toHaveCount(0)
    await expect(page.getByRole('contentinfo')).toHaveCount(0)
    await expect(main.getByRole('note')).toContainText('モックデータ（架空）')

    const overview = main.getByRole('region', { name: '旅程の根拠' })
    const routeMap = main.getByRole('list', { name: '旅程の路線図' })
    await expect(routeMap.getByText('営業時間：矛盾あり', { exact: true })).toBeVisible()
    await expect(routeMap.getByText('営業時間：確認できない', { exact: true })).toBeVisible()
    await expect(routeMap.getByText('固定予定', { exact: true })).toHaveCount(2)
    const otherStops = routeMap.getByRole('button', { name: /朝の庭園|14時の予約展示/ })
    const originalOtherStops = await otherStops.evaluateAll((stops) =>
      stops.map((stop) => stop.getAttribute('aria-label')),
    )
    expect(originalOtherStops).toHaveLength(2)
    const storage = await page.context().storageState({ indexedDB: true })
    const session = await page.evaluate(() => Object.entries(sessionStorage))
    await expectNoOverflow()

    const overviewBox = (await overview.boundingBox())!
    const mapBox = (await routeMap.boundingBox())!
    if (width >= 1024) {
      await expect(main).toHaveCSS('max-width', 'none')
      expect(mapBox.x).toBeGreaterThan(overviewBox.x + overviewBox.width)
      expect(mapBox.y).toBeCloseTo(overviewBox.y, 0)
    } else {
      expect(mapBox.y).toBeGreaterThan(overviewBox.y + overviewBox.height)
    }

    const lunch = routeMap.getByRole('button', { name: /昼食店A（架空）/ })
    await lunch.click()
    const stopDetails = page.getByRole('dialog')
    await expect(stopDetails).toBeVisible()
    await expect(stopDetails.getByText('矛盾あり', { exact: false }).first()).toBeVisible()
    await expectNoOverflow()
    await page.keyboard.press('Escape')
    await expect(stopDetails).toHaveCount(0)
    await expect(lunch).toBeFocused()

    const revise = routeMap.getByRole('button', { name: 'この予定だけ変更して比較' })
    await revise.click()
    await expect(main.getByRole('heading', { name: 'この予定だけ変更' })).toBeVisible()
    await expectNoOverflow()
    await main.getByRole('button', { name: 'こだわらない（おまかせで探す）' }).click()
    await expect(main.getByRole('note')).toContainText('架空デモ')
    await expect(main.getByText('未承認の候補（プレビュー）')).toBeVisible()
    const evidence = main.getByRole('heading', { name: '変える前に、根拠を比較' })
    await expect(evidence).toBeVisible()
    if (width >= 1024) {
      const previewBox = (await routeMap.boundingBox())!
      const evidenceBox = (await evidence.boundingBox())!
      expect(evidenceBox.x).toBeGreaterThan(previewBox.x + previewBox.width)
    }

    await main.getByRole('button', { name: /候補 B .*承認不可/ }).click()
    await expect(main.getByText('デモではこの候補の営業時間を確認できない想定です。')).toBeVisible()
    await expectNoOverflow()
    await main.getByRole('button', { name: '詳しく比較' }).click()
    await expect(main.getByRole('heading', { name: '詳しく比較' })).toBeVisible()
    await expectNoOverflow()
    await main.getByRole('button', { name: '変更内容を確認する' }).click()
    const approve = main.getByRole('button', { name: 'デモで承認して反映' })
    await expect(approve).toBeDisabled()
    await expect(approve).toHaveAccessibleDescription(
      'デモではこの候補の営業時間を確認できない想定です。',
    )
    await expectNoOverflow()
    await main.getByRole('button', { name: '候補の選択へ戻る' }).click()
    await main.getByRole('button', { name: '部分修正を閉じる' }).click()
    await expect(revise).toBeFocused()
    await expect(routeMap.getByText('昼食店A（架空）', { exact: true })).toBeVisible()

    const approveFictionalLunch = async () => {
      await revise.click()
      await main.getByRole('button', { name: 'こだわらない（おまかせで探す）' }).click()
      await main.getByRole('button', { name: /候補 A .*承認可能/ }).click()
      await expect(routeMap.getByText('昼食店A（架空）', { exact: true })).toBeVisible()
      await main.getByRole('button', { name: '変更内容を確認する' }).click()
      await expect(approve).toBeEnabled()
      await expect(main.getByText(/この画面の架空旅程にだけ反映します/)).toBeVisible()
      await approve.click()
      await expect(routeMap.getByRole('button', { name: /食堂いちょう（架空候補）/ })).toBeVisible()
    }
    await approveFictionalLunch()
    await expect(main.getByRole('status')).toContainText('この画面の架空旅程に反映しました')
    await expect(main.getByText(/このデモでは架空の旅程を操作できます/)).toBeVisible()
    await expect(routeMap.getByText('変更を反映済み')).toBeVisible()
    await expect(lunch).toHaveCount(0)
    await expect(routeMap.getByText('固定予定', { exact: true })).toHaveCount(2)
    expect(
      await otherStops.evaluateAll((stops) => stops.map((stop) => stop.getAttribute('aria-label'))),
    ).toEqual(originalOtherStops)
    await expect(revise).toBeFocused()
    await expectNoOverflow()

    await main.getByRole('button', { name: 'デモをリセット' }).click()
    await expect(lunch).toBeVisible()
    await expect(routeMap.getByText('変更を反映済み')).toHaveCount(0)

    await approveFictionalLunch()
    expect(await page.context().storageState({ indexedDB: true })).toEqual(storage)
    expect(await page.evaluate(() => Object.entries(sessionStorage))).toEqual(session)
    await page.reload()
    await expect(lunch).toBeVisible()
    await expect(routeMap.getByText('変更を反映済み')).toHaveCount(0)
    expect(apiRequests).toEqual([])
  })
}

test('デモから利用規約への画面遷移で通常のレイアウトが復帰する', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/demo')
  await page.getByRole('link', { name: '利用規約・プライバシー', exact: true }).click()
  await expect(page).toHaveURL('/terms')
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeVisible()
  await expect(page.getByRole('main')).toHaveCSS('max-width', '576px')
  await page.goBack()
  await expect(page.getByRole('main')).toHaveCSS('max-width', 'none')
  await expect(page.getByRole('banner')).toHaveCount(0)
})

test('デモ認証を利用中のタブでは終了操作を表示する', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('groundtrip-demo-session', 'demo-session-fixture')
  })
  await page.goto('/demo')
  await expect(page.getByRole('button', { name: 'デモを終了する' })).toBeVisible()
})
