import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// アプリ本体（tsconfigのpaths）と同じ `@/` を使えるようにし、TSXを自動JSX変換でテストする。
// DOMが必要なテストは、ファイル先頭に `// @vitest-environment jsdom` を書いて切り替える。
export default defineConfig({
  // .tsxのテストも対象にする。拡張子が.tsの設定だけが読まれるため、設定は1本にまとめる。
  test: { include: ['src/**/*.test.{ts,tsx}'] },
  // tsconfigは`jsx: preserve`（Next.jsが変換する）のため、テストでは別に変換方式を指定する。
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only.ts', import.meta.url)),
    },
  },
})
