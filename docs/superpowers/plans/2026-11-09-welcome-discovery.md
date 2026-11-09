# Welcome and Discovery Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 名古屋の写真から旅づくりへ進めるWelcomeとホームを、既存MVPに段階導入する。

**Architecture:** 新しい表示コンポーネントを既存認証とHomePlannerへ接続する。#77の履歴・入力保持を再利用し、API契約を変更しない。Welcomeとホームは別ブランチ・別PRとする。

**Tech Stack:** Next.js 15 / React 19 / TypeScript / Tailwind CSS 4 / Vitest / Playwright。依存追加なし。

**Spec:** `docs/superpowers/specs/2026-11-09-welcome-discovery-design.md`

## Global Constraints

- Solが設計と完了条件を管理、Lunaが実装。不要な追加エージェントは起動しない。
- 320px・390pxのスマホ幅、白・アイボリーとオレンジ、名古屋の実景、添付SVGを使う。
- mainへの直接push禁止。PR作成まで、マージしない。本番設定・Secret・課金APIを変更しない。
- 既存の認証・App Check・セッション境界・固定予定・本人承認・保存と復旧を維持する。
- 実装済みの状態とデータだけを見せ、写真選択や希望入力ではAPIを呼ばない。

## Review Focus

- localStorageが使えない場合もWelcomeをループさせない。
- /accessの認証完了後もセッションを保ち、機密URLをリンクやログへ流さない。
- 戻ると再訪で入力・選択済み旅程を失わない。
- UID変更時に保存旅程・選択・表示を以前の利用者から引き継がない。
- 写真未読込・reduced motion・320px・キーボードでも主要操作を使える。

### Task 1: Welcome（PR1）

**Files:**

- Create: `src/app/welcome/page.tsx`, `src/features/welcome/welcome-screen.tsx`, `src/features/welcome/welcome-entry.tsx`, 関連Vitestテスト。
- Modify: `src/app/layout.tsx`と最小の共通chrome（Welcomeの全画面表示）、`src/app/page.tsx`の入口、必要なCSS。
- Parent-owned assets/docs: `public/brand/`, `public/images/nagoya/`, `docs/DISCOVERY_ASSETS.md`, 本設計・計画書。

**Interfaces:**

- Produces: `WelcomeScreen()`、既存childrenを受ける`WelcomeEntry({ children }: { children: ReactNode })`。Welcome通過判定は公開の表示フラグのみ。
- Consumes: 名古屋写真と添付SVGのローカルパス。既存認証APIは変更しない。

- [ ] 初回、通過後、storage失敗、reduced motion、二重操作・戻るを意味ある回帰テストとして先に記述して失敗を確認する。
- [ ] Welcomeを実装し、画面上の1つの主要CTAからホームへreplace遷移する。通過済みなら通常入口へ戻さない。
- [ ] 既存保護APIが無条件に呼ばれないことを既存テストとブラウザで確認する。
- [ ] format、lint、typecheck、関連テスト、buildと320px/390px画面を確認する。
- [ ] Conventional Commitの日本語概要でcommit・pushし、テンプレートに沿う日本語PRをmain向けに作成する。

### Task 2: 写真ホーム（PR2）

**Files:**

- Create: `src/features/discovery/discovery-home.tsx`, `src/features/discovery/destinations.ts`, 関連テスト。
- Modify: `src/features/home/home-planner.tsx`, 必要な旅行条件初期入力の受渡し、既存画面履歴の小さな拡張、スコープ限定CSS。

**Interfaces:**

- `DiscoveryHome({ onCreate, onOpenTrips, onOpenRecords, ... })`は表示とユーザー意図の通知だけを担当する。
- `onCreate`は旅行先と希望の下書きを既存フォームへ渡す。Trip生成・照合・保存のAPIは本人の既存操作からのみ呼ぶ。
- `destinations`は地域・テーマ・写真パス・写真の代替説明を持つ静的な編集コンテンツであり、Places照合結果ではない。
- 保存旅程は現在のSessionScopeで既存読取経路から取得し、地域のイメージを本人の撮影写真と表現しない。

- [ ] 写真/検索/希望が下書きへ渡る、APIを自動実行しない、戻ると入力保持、UID切替で前ユーザーの旅を除去するテストを追加して失敗を確認する。
- [ ] 視覚的に主従のある写真ホームを実装。保存データのない進行/完了状態を作らない。
- [ ] 既存履歴hookへ接続し、ホーム／しおり／記録を動く導線にする。空状態も案内する。
- [ ] 関連テスト→format/lint/typecheck→単体全件（必要ならmaxWorkers=4）→buildを確認する。認証/保存契約を変えない限りEmulatorの不要な再実行はしない。
- [ ] 320px/390px実ブラウザ、reduced motion、エラー、キーボードを確認しスクリーンショットを残す。
- [ ] PR1から新ブランチを作成し、PR1ブランチをbaseとしたPR2を作る。依存を本文へ明記し、mainへは直接push/mergeしない。
