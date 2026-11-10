# Candidate Ticket UI Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 部分修正の候補比較から承認前確認までを切符・路線図の見た目に揃える。

**Architecture:** 既存React部品の表示とスコープ付きCSSを変更する。状態遷移・判定・API・保存契約は保持する。

**Tech Stack:** Next.js / React / TypeScript / Tailwind / Vitest / Playwright.

**Spec:** ../specs/2026-11-10-candidate-ticket-design.md

## Global Constraints

- 320px/390pxで主要情報が欠けず、ページ横スクロールを生じさせない。
- 元経路はグレー、未承認候補は青。選択・承認・適用を分ける。
- API・認証・Firestore・App Check・本番設定を変更しない。
- 帰属表示・固定予定・根拠・承認不能理由・結果不明の復旧を維持する。
- ブランチ feat/candidate-ticket-ui。mainへ直接pushせず、PR作成まで。

## Review Focus

長い施設名、未照合/矛盾/判断不能、候補切替、適用中/結果不明、生成失敗を確認する。

## Task 1: 候補比較・承認の紙面UI

### 所有するファイル

- src/features/revision-review/revision-review.tsx — 候補切替・各段階の紙面レイアウト。状態処理は保持。
- src/features/revision-review/candidate-comparison.tsx — 比較・根拠の紙面表示。
- src/app/globals.css — gt-revision-* に限定した表示。既存路線図への影響を避ける。
- 関連Vitest、tests/browser/journey-history.spec.ts — 既存テストを再利用し、重要操作のみ補強。

### 手順

- [x] AGENTS.md、UI仕様、対象コンポーネント、既存テスト、共有HTMLの04/06/05を読む。
- [x] 切符風候補に記号・施設名・可否・選択状態を追加し、既存選択処理を維持する。
- [x] プレビュー・比較・承認前を紙面へ揃え、青とグレーの意味、注意、承認ガードを保持する。
- [x] 関連テストを実行する。必要な回帰ケースは変更前の失敗を確認してから追加実装する。
- [x] 320px/390pxのモック画面を確認し、スクリーンショットを一時フォルダへ保存する。
- [x] format:check / lint / typecheck / test / build を実行し、実行結果と未確認を記録する。
- [ ] 独立レビュー後に修正し、コミット・push・テンプレートに沿うPRを作る。マージしない。

## 検証とレビュー

- 関連Vitest: 69件成功。全体Vitest: 129ファイル・2,546件成功（`pnpm test --maxWorkers=2`）。既存の候補選択テスト2か所を、施設名を含む読み上げ名に合わせて更新した。
- `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm build` / `git diff --check` 成功。
- Chromeの架空デモで320px/390pxそれぞれ候補・詳細比較・承認前・承認不可を確認。8状態すべてページ横はみ出し0、JavaScriptエラー0。候補切替と戻る操作を実施。
- 外部通信を遮断し、有料APIは無効にしたローカル設定で確認した。実API・実Firebase・iOS実機・実スクリーンリーダーは未確認。架空デモでは承認・保存の成功は検証していない。
- 最初の全体テストは既定並列数で関連検証と重なり、振り返り系にタイムアウトが出たため中断した。同時実行数を2に制限した再実行では全件成功。テスト本体やタイムアウト値の変更はしていない。
- 独立レビューと意匠仕上げ分の再レビューで、修正必須のP1/P2指摘なし。ブラウザ実測は親担当が実施した。
- Task 1: 実装・独立レビュー・ローカル検証を完了。PRでのレビュー待ち。

## 実行記録

- 基点: origin/main 97b1942。作業ツリーclean、競合するopen PRなし。
- 事前判断: 共有HTMLのダミー数値と確認不能でも承認できる例は採用しない。既存の安全条件を優先する。

### 事前整合確認

| 対象                | 確認内容                                                       | 結果                                                      |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Task 1 内部         | 既存部品の表示変更に対し、操作・ガードの既存テストを再利用する | 整合。API・データ契約の変更は不要                         |
| Task 1 / 親の作業   | 実装担当はUI・関連テスト、親は文書・独立検証・PR               | 所有ファイルを分離。Next devとtypecheck/buildは順番に実施 |
| デザイン / 安全条件 | 架空の値・予約成立・未確認候補の承認を表示へ追加しない         | 参考HTMLより既存の安全条件を優先                          |
