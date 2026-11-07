import type { CSSProperties, ReactNode } from 'react'

// Google Maps Platform由来の内容を、地図を使わずに表示するときの帰属表示（テキスト版）。
// 書式はGoogleの帰属表示の要件に従う：文字は「Google Maps」から変えない（翻訳・折り返し・大小文字の変更をしない）、
// Roboto（なければsans-serif）、通常体、太さ400、文字サイズ12〜16px、letter-spacingはnormal、
// 色は白・#1F1F1F・#5E5E5E のいずれかで、背景に対して4.5:1以上。
// ロゴが望ましいが、公式の素材の入手までは、テキストで表示する（docs/GOOGLE_MAPS_COMPLIANCE.md）。

export const GOOGLE_MAPS_ATTRIBUTION_TEXT = 'Google Maps'

// 許可された3色。white は暗い背景（#1F1F1F など）の上でだけ使う。
export const attributionTones = {
  gray: '#5E5E5E',
  black: '#1F1F1F',
  /** 暗い背景専用。明るい背景に置かないこと */
  white: '#FFFFFF',
} as const

export type AttributionTone = keyof typeof attributionTones

// 文字サイズ（px）。許可範囲は12〜16。
export const ATTRIBUTION_FONT_SIZE_PX = 14

export function GoogleMapsAttribution({
  tone = 'gray',
}: {
  /** 文字色。white は暗い背景専用。明るい背景に置かないこと */
  tone?: AttributionTone
}) {
  const style: CSSProperties = {
    fontFamily: 'Roboto, sans-serif',
    fontStyle: 'normal',
    fontWeight: 400,
    fontSize: `${ATTRIBUTION_FONT_SIZE_PX}px`,
    lineHeight: 1.4,
    letterSpacing: 'normal',
    whiteSpace: 'nowrap',
    color: attributionTones[tone],
  }
  // 固有名詞なので翻訳させない（translate="no"）。読み上げが英語になるよう lang も指定する。
  return (
    <span translate="no" lang="en" style={style}>
      {GOOGLE_MAPS_ATTRIBUTION_TEXT}
    </span>
  )
}

// Google由来の内容を囲む枠。枠線と白い背景で他の内容と区別し、帰属を内容の下（同じ枠の中）に置く。
// 白背景の明色を前提に、色はこのコンポーネントの中で完結させる（グローバルのテーマに依存しない）。
// 非Google由来の内容（AIの提案・利用者の入力など）は、この枠に入れない。
export function GoogleMapsSourceBox({
  caption,
  children,
}: {
  // 枠の見出し（例：「確認に使った情報源」）。任意。
  caption?: string
  children: ReactNode
}) {
  return (
    <div
      role="group"
      aria-label={caption ?? 'Google Maps Platform由来の情報'}
      className="min-w-0 max-w-full rounded-md border-[1.5px] border-[#5E5E5E] bg-white p-3 text-sm leading-relaxed text-[#1F1F1F]"
    >
      {caption && <p className="mb-1.5 text-xs font-bold text-[#1F1F1F]">{caption}</p>}
      <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
      <p className="mt-2 flex justify-end border-t border-[#C8C8C8] pt-1.5">
        <GoogleMapsAttribution />
      </p>
    </div>
  )
}
