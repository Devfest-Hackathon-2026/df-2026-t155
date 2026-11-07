import type { CSSProperties } from 'react'

// 進行状況の表示が使う色。グローバルのテーマに依存せず、明色のまま完結させる。
// 境界（edge・accent）は隣接する色に対して3:1以上、文字は4.5:1以上（palette.test.tsで固定）。
export const palette = {
  // 文字
  ink: '#16181a',
  muted: '#5c615f',
  // 面
  page: '#f3f3ee',
  card: '#ffffff',
  visited: '#e9e9e4',
  accentTint: '#fff1ea',
  // 境界線（カード・ボタンの縁、補助線）
  edge: '#6b706d',
  // 進行中に注目する色（オレンジ）。白い文字を載せても読める濃さにする。
  accent: '#b93a1f',
  // 根拠の状態（色に加えて、記号と文字でも区別する）
  ok: '#17694a',
  warn: '#a8231b',
  unknown: '#6f5200',
} as const

type PaletteVariables = Record<`--tp-${string}`, string>

// ルート要素に付けるCSS変数。各部品は `text-(color:--tp-ink)` のように参照する。
export const paletteStyle: CSSProperties & PaletteVariables = {
  '--tp-ink': palette.ink,
  '--tp-muted': palette.muted,
  '--tp-page': palette.page,
  '--tp-card': palette.card,
  '--tp-visited': palette.visited,
  '--tp-tint': palette.accentTint,
  '--tp-edge': palette.edge,
  '--tp-accent': palette.accent,
  '--tp-ok': palette.ok,
  '--tp-warn': palette.warn,
  '--tp-unk': palette.unknown,
}
