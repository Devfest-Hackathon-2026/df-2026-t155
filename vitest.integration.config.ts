import { defineConfig } from 'vitest/config'

import baseConfig from './vitest.config'

export default defineConfig({
  ...baseConfig,
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/helpers/emulator-environment.ts'],
    testTimeout: 15000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
})
