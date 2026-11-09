# Itinerary Ticket UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HTMLの切符意匠を実際に動くしおり・予定詳細へ移し、最初の確認用PRを完成させる。

**Architecture:** 既存RouteMap/StopSheetの表示を小さく変更する。既存のイベントとデータ契約を維持し、共有の見出し変更は旅程向けの明示的なvariant等へ限定する。

**Tech Stack:** Next.js / React / TypeScript / Tailwind / Vitest / Playwright。依存追加なし。

**Spec:** `docs/superpowers/specs/2026-11-10-itinerary-ticket-design.md`

## Global Constraints

- 最新mainの#80統合後から`feat/itinerary-ticket-ui`で作業。main直接push・自動マージ禁止。
- Solが方針とブラウザ確認、Lunaが実装。追加エージェントや不要な再調査を行わない。
- 認証・復旧の共通表示とデモ終了操作、固定・根拠・本人承認を維持する。
- 外部API・本番設定・新フォントを使わず、HTMLの架空データや未実装機能は移植しない。

## Review Focus

- 長い日本語の予定名でも320pxで番号・固定・操作を押し出さない。
- 食事以外を食事券と誤表示せず、固定を予約・発券と表現しない。
- 紙目・切り欠きで文字の可読性、フォーカス枠、タップ領域を損なわない。
- 詳細シートを開閉しても背景操作・スクロール・フォーカスが破綻しない。
- 非表示の旅程がホームの背景やブランド、認証案内へ影響しない。

### Task 1: 路線図と紙面

**Files:** `src/features/trip-map/route-map.tsx`, `trip-route-view.tsx`, `src/app/globals.css`。真に共有する必要がある場合だけ小さな表示部品を追加。

**Interfaces:** 現在のprops、Stop ID、イベントを保つ。番号は実際の訪問順から表示し、架空の予約情報を生成しない。

- [ ] 既存テストで保護される情報・操作を確認し、不足する長い名前/固定/未確認の意味ある回帰ケースだけ追加。
- [ ] 既存行と紙面へスコープ限定CSSを適用し、必要な表示部品だけ抽出。
- [ ] 関連Vitestを実行し、表示と操作の互換性を確認。

### Task 2: ヘッダーと予定詳細

**Files:** `src/features/trip-map/stop-sheet.tsx`, 必要なら`src/features/home/trip-journey.tsx`, `src/features/screen-chrome/screen-header.tsx`。既存のシート/路線図テストを再利用。

**Interfaces:** ヘッダーは既存propsを保ち、必要なvariantのみ追加。シートのmodal/close/focus/drag処理は再実装しない。

- [ ] 旅程向けヘッダーとシートを紙面へ統一。共通の認証帯・終了操作はそのまま表示。
- [ ] 既存の固定切替、変更入口、モーダルのキーボードとドラッグ関連テストを確認。
- [ ] Solへ画面表示可能な段階を通知し、320px・390pxと長い予定/固定/根拠の状態をローカルMockで確認。

### Task 3: 検証とPR

- [ ] format/lint/typecheck、関連および全unit、buildを適切に実行。既に通った未変更の検証を繰り返さない。
- [ ] 実ブラウザ検証とbuildの.next使用を同時に行わない。
- [ ] UI仕様書を採用範囲だけ更新し、テンプレートに沿って実績と未確認事項を書く。
- [ ] 日本語Conventional Commitでpush・PR作成。命名・署名のユーザー指定を守る。
