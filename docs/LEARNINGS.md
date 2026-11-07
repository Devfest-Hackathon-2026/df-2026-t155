# 振り返りと承認済みの学び（Issue #12・保存に依存しない部分）

旅行後の振り返りから「学び」の候補を作り、本人が編集・承認したものだけを、次回の旅程づくりへ渡す。
学びの保存はパーソナライズであり、Gemini自体の再学習ではない。共通契約は`docs/DOMAIN_CONTRACTS.md`の`Learning`。

## 構成

| 場所                                          | 責務                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/lib/learnings/lifecycle.ts`              | 編集・承認・却下・次回に渡せる学びの選択（純粋ロジック。画面とサーバーで共用） |
| `src/server/learnings/generate-candidates.ts` | 振り返りの材料から、Geminiで学びの候補（1〜3件）を作る                         |
| `src/server/learnings/store.ts`               | 承認済みの学びの保存先（インターフェースとメモリ実装）                         |
| `src/server/learnings/handler.ts` ほか        | `POST /api/learnings/candidates`（候補の作成だけ。承認・保存はしない）         |

## 守っていること

- 候補はすべて**未承認（pending）**で返す。AIは承認状態・ID・適用地域を決めない（地域は旅程の地域をサーバーが入れる）。
- 編集した学びは、承認済みでも**必ずpendingに戻し、再承認を求める**。
- 次回に渡せるのは、**承認済みで、適用範囲（全地域／同じ地域）が合うものだけ**。各要素を契約（`ApprovedLearning`）で形式を検証し直す。
- 保存できるのは**承認済みだけ**。利用者ごとに分離する。
- 情報源との不一致（`verification`）と、個人の好み（`preference`）を区別する。
- **模擬報告（デモ用の想定）は、実際に起きた出来事として学びにしない。** AIへの指示だけに頼らず、アプリケーション側で除外する。
  材料判定とプロンプト生成は、共通の`usableRevisions`（**承認済みで、模擬報告ではない変更**）だけを使い、模擬報告はAIへ渡さない。
  感想が無く、使える変更も無ければ、AIを呼ばず情報不足とする。
- 材料（感想か、使える変更）が無ければ、AIを呼ばず情報不足とする。未承認・却下の変更も、材料にしない。
- 感想・変更理由は、指示ではなくデータとしてAIに渡す。

## API：POST /api/learnings/candidates

- リクエスト：`{ trip, revisions, feedback }`（`revisions`は同じ旅程の変更履歴、`feedback`は1000文字以内、本文は64KB以下）。
- 成功：HTTP 200、`{ status: 'proposed', learnings }`（1〜3件、すべてpending）。
- 失敗：`no_candidates`／`insufficient_information`は422、`external_service_error`は502。API層のエラーは400／413／415／500／503（旅程生成APIと同じ）。
- **機能フラグ`LEARNING_CANDIDATES_ENABLED=true`のときだけ受け付ける（既定は無効、503）。** 課金を伴うため、認証・利用制限が入るまで停止しておく。
- Geminiの呼び出しは1リクエスト1回。再試行しない。

## 承認済みデータとの接続

#10の[保存API](FIRESTORE_PERSISTENCE.md)が、本人確認、元Tripの所有権、専用操作によるLearning承認と撤回を扱う。
保存済みの学びを再編集する間は、旧版を有効なまま保持する。専用APIで新版の承認が成功した時点で置き換わる。

候補生成APIの `revisions` は現在もクライアント申告。振り返りの接続では、本人の保存済みTripと
適用履歴をサーバーで取得する。現行の確認画面はローカル状態で承認・却下を扱うため、
専用の承認APIを接続する際に、承認済みの版と編集下書きを分けて扱う。

#13は `getApplicableLearnings(store, ownerUid, region)` から本人の承認済みLearningを取得する。
