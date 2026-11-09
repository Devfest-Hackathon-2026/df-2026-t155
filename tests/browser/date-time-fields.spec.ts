import assert from 'node:assert/strict'

import { expect, test } from '@playwright/test'

for (const width of [320, 375, 390]) {
  test(`${width}pxで日付・時刻の枠の左右端から入力できる`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.getByLabel('旅行先（必須）').fill('京都市')
    await page.getByRole('button', { name: '固定予定を追加' }).click()
    await page.getByLabel('予定の名前').fill('架空の展示')
    const date = page.getByLabel('日付（必須）')
    const time = page.getByLabel('開始時刻')
    const duration = page.getByLabel('滞在時間（分）')
    const submit = page.getByRole('button', { name: '旅程を作成する' })

    for (const [field, type, error, firstValue, secondValue] of [
      [date, 'date', '日付を選んでください', '2026-11-08', '2026-11-09'],
      [time, 'time', '開始時刻を入力してください', '14:00', '15:00'],
    ] as const) {
      await expect(field).toHaveAttribute('type', type)
      await submit.click()
      // WebKitのnative dateはプログラムからのfocus()を受け取らない場合がある。
      // ここでは検証結果を確認し、実際の枠クリック・タップによるフォーカスを検証する。
      await expect(field).toHaveAttribute('aria-invalid', 'true')
      await expect(field).toHaveAccessibleDescription(`入力エラー：${error}`)
      const frame = field.locator('..')
      await expect(frame).toHaveCSS('border-top-width', '2px')
      const size = await frame.evaluate((element) => ({
        width: element.clientWidth,
        height: element.clientHeight,
      }))

      for (const [x, value] of [
        [3, firstValue],
        [size.width - 3, secondValue],
      ] as const) {
        // 先に別の欄へ移り、入力本体の外側にある枠内の余白を操作する。
        await duration.focus()
        const position = { x, y: Math.floor(size.height / 2) }
        await expect(field).not.toBeFocused()
        if (testInfo.project.use.hasTouch && value === secondValue) {
          await frame.tap({ position })
        } else {
          await frame.click({ position })
        }
        await expect(field).toBeFocused()
        await field.fill(value)
        await expect(field).toHaveValue(value)
      }
      await expect(field).toHaveAttribute('aria-invalid', 'false')
    }

    const timeBox = await time.boundingBox()
    const durationBox = await duration.boundingBox()
    assert(timeBox && durationBox)
    expect(timeBox.y + timeBox.height).toBeLessThan(durationBox.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
  })
}
