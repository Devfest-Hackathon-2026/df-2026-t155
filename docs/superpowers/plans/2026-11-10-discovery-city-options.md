# Discovery City Options Implementation Plan

**Goal:** 愛知・名古屋を中心に保ち、大阪・東京も写真テーマから選べるようにする。

**Design:** 既存の名古屋3テーマを先頭に維持し、大阪・東京を末尾に追加する。Welcomeは名古屋のまま。ホームの説明を愛知・名古屋中心と明示しつつ都市追加と整合させる。別の都市選択画面や新しいAPIは作らない。

**Architecture:** 既存DiscoveryDestination配列を拡張する。#85の入力・写真絞り込み・手入力優先・差分下書きの契約を維持する。写真選択はテーマと下書きの変更であり、旅程の確定・生成・照合・保存を行わない。

**Assets:** 親がCC0の個別ファイル情報を確認した大阪城・東京タワー写真を同梱し、出典をdocs/DISCOVERY_ASSETS.mdへ記録する。新しい依存や実行時の外部画像APIは不要。

## Task 1

所有: src/features/discovery/destinations.ts、discovery-home.tsx、discovery-home.test.tsx、必要なhome-planner.discovery.test.tsxのみ。親は画像・出典・計画・全体検証・PRを担当する。

- [x] 既存の名古屋3件の順序と選択処理を維持し、末尾へ大阪・東京を追加。
- [x] 大阪はregion「大阪市」、東京はregion「東京都」。画像は/images/cities/osaka.webpと/images/cities/tokyo.webp。写真は都市のテーマ例であり訪問確定を示さない。
- [x] 大阪テーマは「大阪の城と街歩き」、東京テーマは「東京の名所めぐり」。名古屋の既存「城と歴史」と混同する選択名を避ける。
- [x] ホームの写真テーマの説明・絞り込みplaceholderを全5テーマと整合させ、愛知・名古屋中心と明記する。Welcomeや共通レイアウトは変更しない。
- [x] 各都市を選んで地域・希望が下書きへ渡ること、選択だけではonCreateが呼ばれないこと、手入力した地域を勝手に変更しないことを重要な操作テストで確認する。
- [x] 関連VitestをmaxWorkers=2で実行。親が320px/390px・format/lint/typecheck/test/build・独立レビューを確認。

## Constraints

API、認証、App Check、保存、固定・本人承認、本番設定を変更しない。既存ブランチや未コミット変更を壊さない。変更はfeat/discovery-city-options上で行う。

## 事前確認

- 基点b5ff433。#86承認・CI成功・未解決コメントなしを確認しSquashで統合済み。mainには#85/#87も統合されているため最新の入力契約を優先する。
- UIと画像の担当ファイルを分離。Next devとtypecheck/buildは順番に実施する。

## 検証記録

- 新規4ケースのREDを確認後、関連2ファイル10件成功。都市別の下書き反映、写真選択だけではonCreateしないこと、手入力地域の保持を確認。
- `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm build` / `git diff --check`成功。
- 全体テストは`pnpm test --maxWorkers=2`の単独再実行で129ファイル・2,562件成功。初回はビルドとの並行実行時に、Firebase Adminのモックテストの動的importが5秒を超え、1件タイムアウトした。実装・テストの制限時間は変更していない。
- Chromeの320px/390pxで名古屋3件の先頭表示、大阪選択、手入力を保持した東京選択、本人操作で東京を採用して条件画面へ進む操作を確認。写真読込成功、ページ横はみ出し0、JavaScriptエラー0、生成/照合/修正API呼出し0。
- 追加2枚はCommonsの個別imageinfo/extmetadataでCC0を確認。原画像のSHA1一致、1200px以下のWebP、EXIF不在、内容を確認し、出典と確認記録を同梱。
- 独立レビューはP1/P2指摘なし。実API・実Firebase・iOS実機・実スクリーンリーダーは未確認。

PR作成・CI・外部レビューの最新状態はGitHubで確認する。マージはしない。
