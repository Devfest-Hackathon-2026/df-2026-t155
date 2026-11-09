import { defineConfig } from '@playwright/test'

const port = 3185
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL, locale: 'ja-JP' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', isMobile: true, hasTouch: true } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit', isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${port}`,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
    url: baseURL,
    env: {
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-groundtrip',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'fixture-api-key',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-groundtrip.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_APP_ID: '1:123:web:fixture',
      NEXT_PUBLIC_FIREBASE_USE_EMULATORS: 'false',
      NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY: 'fixture-site-key',
    },
  },
})
