# Itinerary Overview Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the implementation and independent review.

**Goal:** 旅行前の路線図で固定・時刻・根拠の状態と詳細への入口を見つけやすくする。

**Architecture:** TripRouteViewに表示専用のItineraryOverviewを挿入し、集計は既存summarizeVerificationへ委譲する。既存StopSheetへの入口とフォーカス復帰を補い、RouteMapの滞在時間を可視化する。

**Tech Stack:** Next.js / React / TypeScript / Tailwind / Vitest / Chrome.

**Spec:** ../specs/2026-11-10-itinerary-overview-design.md

## Global Constraints

- Googleの根拠数と予定数を区別する。模擬・本人報告・公式情報をGoogleの照合数へ混ぜない。
- 320px/390pxで横はみ出しを生じさせず、固定・重大な未確認・帰属表示を保持する。
- 既存の承認/保存/認証/復旧/API契約を変更しない。本番設定と実APIは対象外。
- feat/itinerary-overview-uiからPRを作る。mainへ直接push・無断マージしない。

## Review Focus

Google根拠0、他ソースのみ、混在状態、長い名前、詳細シートのフォーカス復帰・親Trip切替、既存部分修正導線を確認する。

## Task 1: 路線図の概要とカードの情報整理

### 所有ファイル

- src/features/trip-map/itinerary-overview.tsx と対応テスト（新規）。
- src/features/trip-map/trip-route-view.tsx と必要な既存テスト。
- src/features/trip-map/route-map.tsx（滞在時間の表示のみ）。
- src/app/globals.css（gt-itinerary-overview-* に限定）。

### 手順

- [x] 共通規約、対象UI、根拠集計、既存シートとフォーカスのテストを読む。
- [x] Google根拠・他ソース・根拠なし予定を区別する概要と詳細入口を実装する。集計自体を複製しない。
- [x] 新入口からの詳細とフォーカス復帰を、親のTrip変更も考慮して既存フローへ接続する。
- [x] 通常の予定カードに予定滞在時間を表示し、既存読み上げ・固定・未承認を保持する。
- [x] 重要ケースを既存テストへ追加し、失敗と解消を確認する。関連テストを並列数2以下で実施する。
- [x] 独立レビュー、320px/390pxブラウザ確認、format/lint/typecheck/test/buildを実施する。
- [x] コミット・push・テンプレートに沿うPR作成・CI確認・レビュー依頼まで。マージしない。

## 事前整合確認

| 対象         | 確認                             | 判断                                                      |
| ------------ | -------------------------------- | --------------------------------------------------------- |
| Task 1内部   | 根拠と予定の単位・操作の意味     | 集計は既存関数、0件や模擬を照合成功にしない               |
| 親と実装担当 | docs/検証/PRとUI/関連テスト      | ファイル所有を分離。Next devとtypecheck/buildは順番に実施 |
| 関連PR       | origin/main 57ed554、open PRなし | #84へ依存する新規の短命ブランチで実施                     |

## 検証記録

- 関連Vitestは80件成功。全体は`pnpm test --maxWorkers=2`で129ファイル・2,548件成功。根拠のソース分離・Google根拠0件・概要から詳細と起点へのフォーカス復帰を2ケース追加し、通常カードの滞在時間も既存テストで確認した。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`git diff --check`成功。実装担当の直接ESLint起動では依存解決エラーが出たが、親のNode 24.22.1・正規`pnpm lint`では再現せず成功した。依存やlockfileは変更していない。
- Chromeのローカル架空デモで320px/390pxの概要・展開・詳細の6状態を確認。ページ横はみ出し0、JavaScriptエラー0。概要と路線図それぞれから詳細を開き、Esc後に元ボタンへ戻ることを両幅で確認した。
- 外部通信を遮断し、課金APIを無効にしたローカル設定を使用。実API・実Firebase・iOS実機・実スクリーンリーダー、Trip差替えを伴う実ブラウザ確認は未実施。既存のTrip同期・削除時の単体テストは関連/全体回帰に含まれる。
- 独立レビューで概要の紙面スタイル不足をP2として検出。修正ラウンド1で既存トークンへ接続し、限定再レビューでADDRESSED、残りのP1/P2指摘なし。最終ブラウザで生成り背景の実適用も確認した。
- `pnpm build`成功。実装・独立レビュー・ローカル検証を完了し、PRでのレビューへ進む。
