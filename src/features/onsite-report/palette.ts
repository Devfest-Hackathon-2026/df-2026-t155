// 現地報告フォームの色。グローバルのテーマ（ダークモード等）に依存せず、明色で完結させる。
// 入力枠・ラジオ・ボタンの境界（edge・ink・accent）は、地色（paper）に対して3:1以上を保つ
// （palette.test.ts で確認する）。
export const ONSITE_PALETTE = {
  paper: '#ffffff',
  ink: '#16181a',
  muted: '#5c615f',
  // 入力枠・ラジオ枠の境界
  edge: '#6b706d',
  // 選択中の行の地色
  selected: '#f1f1ea',
  // 白い文字を載せる操作ボタン
  accent: '#b93a1f',
  // 不備・失敗（文字は warn、地は warnBg）
  warn: '#a8231b',
  warnBg: '#fadbd7',
  // 模擬報告の注意（文字は caution、地は cautionBg）
  caution: '#6f5200',
  cautionBg: '#f6ecc8',
} as const
