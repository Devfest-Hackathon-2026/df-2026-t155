# 旅程生成API（POST /api/trips/generate）

Issue #6の実装。共通データモデルとAPI契約（`docs/DOMAIN_CONTRACTS.md`）に従い、
Geminiで日帰り旅行（1日・1地域・3〜4地点）の旅程を**提案**として生成する。

## 入出力

- **機能フラグ**。既定は無効。本番の招待制デモは `TRIP_GENERATION_ENABLED` と共通デモフラグが必要。停止中は認証・本文読み取り・Gemini呼び出し前に503を返す。
- **認証**。有効時はFirebase IDトークン、招待UID、Web App Check、共有利用枠が必要。[認証エラーとクライアント契約](API_ABUSE_PROTECTION.md#クライアント契約)を参照。
- リクエスト: 旅行条件（日付・地域・タイムゾーン・希望・固定Stop）と、選んだ学びの `learningSelections: { id, version }[]`
  （`GenerateTripHttpRequestSchema`。`Content-Type: application/json`、本文32KB以下）。本文はストリームで読み、
  上限を超えた時点で読み取りを中止する。**承認済みの学びの本文（`learnings`）は受け付けない**（付いていれば400）。
  学びは、サーバーが認証済みUIDの保存済みデータと `{ id, version }` を照合して解決する（`docs/LEARNINGS.md`）。
  選択が空なら学びなしで生成し、保存先は読まない。
  保存契約と同じ地域120文字・希望条件16件かつ各200文字・固定予定名200文字・固定Stop ID256文字を適用する。
  超過はGemini呼び出し前に400を返し、`issues` に該当項目のパスを含める。
- 成功はHTTP 200の `{ status: 'proposed', trip }`。適用記録がある旅程には照合済みの `learningVersion` を記録する。
  新形式は `X-GroundTrip-Learning-Trip: 1` を宣言したクライアントが受け取る。書き込みフラグと署名鍵が有効なら
  `learningSaveProof` を返す。停止中や署名不可の場合は `learningSaveUnavailable` を返し、プレビューを保持する。
  生成結果は保存スキーマと64 KiB上限を検査し、保存可能な形式を組み立てられない場合は候補なしとする。
- 失敗: 共通契約の`ProposalFailure`（`status`と`message`）。更新後の旅程は含まない。

| HTTP | `status`                                     | 意味                                                                                                    |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 200  | `proposed`                                   | 旅程の提案。承認・保存・確定ではない                                                                    |
| 422  | `no_candidates` / `insufficient_information` | 条件を満たす旅程を作れない／入力が足りない（AIの申告または検証不合格）                                  |
| 502  | `external_service_error`                     | Geminiの呼び出し失敗（接続・権限・拒否・途中終了・空応答・未設定）                                      |
| 409  | `selection_changed`                          | 選んだ学びが変更・撤回・地域不一致（Geminiは呼ばない。選び直しを案内する）                              |
| 503  | `learnings_unavailable`                      | 保存済みの学びを確認できない（機能停止の `service_unavailable` とは別。学びを使わずに作る道を案内する） |
| 400  | `invalid_request`                            | 入力が契約に違反、または本文を読み取れない（`issues`に項目ごとの理由）                                  |
| 503  | `service_unavailable`                        | 機能停止中。Geminiは呼ばない                                                                            |
| 413  | `payload_too_large`                          | 本文が32KBを超える                                                                                      |
| 415  | `unsupported_media_type`                     | `Content-Type`がJSONではない                                                                            |
| 500  | `internal_error`                             | 想定外の失敗、または応答が共通契約に違反                                                                |

400／409／413／415／500／503は共通契約の`GenerateTripResponse`ではなく、API層だけのエラー（`status`と`message`）。
クライアントの通信中断・生成中は、完了応答とは別の操作状態として扱う。

## 生成結果について守っていること

- Geminiの出力は信用せず、Zodで検証してから`Trip`に変換する。形式不正・契約違反は`no_candidates`。
- 固定予定は、AIが名前や時刻を変えても**入力どおり**（ID・名前・時刻・滞在・固定状態）に置き換え、過不足なく1回ずつ含める。
  入力の`placeId`と`evidence`はクライアントの自己申告なので引き継がず、`placeId: null`・`evidence: []`（未照合）に戻す。
- 地点の時刻が重なる・時刻順でない旅程は採用しない（移動時間・営業時間の照合ではない）。
- AIが作った地点は未同定・未照合として返す（`placeId: null`、`evidence: []`）。
  Geminiの提案は、施設情報や移動時間の検証結果ではない。照合はPlaces・Routes連携（Issue #7）で行う。
- 新規地点の任意の `kind` は、Geminiが旅程上の目的を分類した値。食事・カフェは `meal`、観光は `sight`。
  分類できない場合は省略する。固定予定には入力時の種別を使い、未指定の場合もそのままにする。
- 学びの反映は、入力にある承認済みの学びだけを、存在する地点に対して記録する。
  反映の説明文が実際の内容と一致するかは検証できない（AIの記述のまま）。
- ID・版（`version: 0`）はサーバーが付与する。承認・保存はしない。
- 課金対象のGemini呼び出しは1リクエストにつき1回。SDKの自動再試行と自動継続（`automaticContinuation`）は無効にする。
- 出力は最大8192トークン・16,000文字まで。超えた出力は使わず外部サービス失敗として扱う。
  通常の旅程生成が上限内に収まることは、実Geminiで確認でき次第見直す。

## 設定

サーバー側の環境変数（`.env.example`参照）。認証はADCで、APIキーやトークンはクライアントへ渡さない。

| 変数                      | 既定               | 内容                            |
| ------------------------- | ------------------ | ------------------------------- |
| `GOOGLE_CLOUD_PROJECT`    | なし（必須）       | Vertex AIを利用するプロジェクト |
| `GOOGLE_CLOUD_LOCATION`   | `global`           | Vertex AIのロケーション         |
| `GEMINI_MODEL`            | `gemini-3.5-flash` | モデル名（切り替え可能）        |
| `TRIP_GENERATION_ENABLED` | なし（無効）       | 生成を受け付ける個別フラグ      |

## 未実装・要判断

- 共有利用制限とApp Checkの実環境確認・画面接続が必要。[公開条件](API_ABUSE_PROTECTION.md#初回公開の判定)を満たすまで一般公開を保留する。
- Places・Routesによる照合は未実装（Issue #7）。
