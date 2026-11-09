import { expect, test } from '@playwright/test'

test('初回のWelcomeは名古屋の写真を見せ、明示操作後だけホームへ進む', async ({ page }) => {
  let generationRequests = 0
  await page.route('**/api/trips/generate', (route) => {
    generationRequests += 1
    return route.abort()
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/welcome')

  await expect(page.getByRole('heading', { name: /次の旅は、\s*名古屋から。/ })).toBeVisible()
  await expect(page.getByRole('img', { name: 'GroundTrip' })).toBeVisible()
  await expect(page.getByRole('button', { name: '旅をはじめる' })).toBeVisible()
  const castle = page.locator('img[src*="castle"]')
  await expect(castle).toBeVisible()
  await expect
    .poll(() => castle.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)

  await page.getByRole('button', { name: '旅をはじめる' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('button', { name: '旅をはじめる' })).toHaveCount(0)
  expect(generationRequests).toBe(0)
})
