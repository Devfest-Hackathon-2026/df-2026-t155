# Places・Routes アダプター

Issue #7 のうち、外部APIとの接続部分。取得した事実を、共通の形で返す。名称の一致判定・営業時間の照合・
移動時間と固定予定の制約検証・根拠（`Evidence`）の組み立ては、照合処理の責務で、ここには含めない。

場所：`src/server/maps/`。サーバー側専用。認証はADC（サービスアカウント）のOAuthで、APIキーは使わない
（`GOOGLE_CLOUD_PROJECT`が必要）。接続の準備は最初の呼び出しまで遅らせ、未設定でもビルドは失敗しない。

```ts
const maps = createLazyMapsClient(process.env)
const found = await maps.searchPlaces({ query: '清水寺 京都', includeOpeningHours: true })
const route = await maps.computeRoute({ originPlaceId, destinationPlaceId, mode: 'WALK' })
```

## 戻り値と失敗の区別

「結果なし」と「呼び出しの失敗」を区別する。HTTP 200の空応答は失敗ではない。

| 状況                       | 戻り値・例外                          | 照合側での扱いの目安                            |
| -------------------------- | ------------------------------------- | ----------------------------------------------- |
| 候補あり（複数もそのまま） | `{ status: 'found', candidates }`     | 名称の一致を確認してから採用する（ゲート）      |
| 候補なし（HTTP 200・空）   | `{ status: 'no_candidates' }`         | 施設を同定できない → 「確認できない」           |
| 経路なし（HTTP 200・空）   | `{ status: 'no_route' }`              | 移動時間を確認できない（0分や到達可能にしない） |
| 呼び出しの失敗             | `MapsCallError`（`reason`、`status`） | API失敗として扱い、根拠を捏造しない             |

`reason`：`not_configured`／`invalid_request`／`unsupported_mode`／`auth_failed`／`timeout`／`network`／
`api_error`／`invalid_response`。例外にはクエリ・トークン・応答本文を含めない（`apiStatus`はGoogleの状態名のみ）。
**外部由来の例外（認証ライブラリの例外・JSON解析エラーなど）は、`cause`にも保持しない。** 認証の実装が投げた例外は、`MapsCallError`を含め、型にかかわらず、元の例外を伝播させず、`auth_failed`に変換する（アダプター自身の期限切れだけが`timeout`）。`apiStatus`は、Googleの既知のエラー名（許可リスト）だけを保持する。 メッセージや応答の断片に、
トークンや応答本文が含まれ得るため、安全な分類情報（`reason`・`status`・`apiStatus`）だけを公開する。

**外部APIの値の検証**：範囲外・不正な値は、正常な結果にせず`invalid_response`とする。緯度は-90〜90、経度は-180〜180、
距離は0〜2万km、所要時間は有限で7日分の秒数以下（桁数の多い文字列は、数値にするとInfinityになる）。

営業時間は`openingHours`で、`not_requested`（要求していない）／`unavailable`（データの欠落）／
`available`（曜日0=日曜・時・分の期間）を区別する。データの欠落を「営業」とも「休み」とも解釈しない。
**`periods`が空配列のときは、欠落（`unavailable`）にせず、`available`の空の配列として保持する**（空配列と欠落は
意味が異なる。空配列の解釈は照合側の責務で、アダプターは解釈しない）。
Placesの `displayName` はサーバー内の照合用データ `PlaceCandidate.name` として返す。
名称が取得できない施設は `name: ''` となる。照合は `Stop.name` と候補の名前を比較し、元の予定名を維持する。

## 費用・規約

- 呼び出しは1回だけで、自動再試行しない。**タイムアウト（15秒）は、認証（トークン取得）とMapsへの送受信の合計**に対する、
  1つの期限。経過時間は単調時計で測り、**認証の完了後・Mapsを呼び出す直前・本文の受信完了後**の3か所で、期限を確認する。
  イベントループの遅れで、期限のタイマーが実行されなくても、期限を過ぎていれば`timeout`とし、送信しない・成功にしない
  （認証が遅れて完了した場合も、Mapsは呼ばない）。送受信に使える時間は、認証と準備に使った時間を差し引いた残り。
- **Places Text SearchのSKU**：`id`はEssentials（IDs Only）、`displayName`・`businessStatus`・`formattedAddress`・`location`は
  **Pro**、`regularOpeningHours`は**Enterprise**。複数のSKUのフィールドを指定したときは、最も高いSKUで課金される
  （公式のUsage and Billingで原文を確認）。営業時間を要求すると、リクエスト全体がEnterpriseになる。
- Placesの営業時間（`regularOpeningHours`、Enterprise）は、`includeOpeningHours: true`のときだけ要求する。
- 公共交通（`TRANSIT`）は対象外で、呼び出さずに`unsupported_mode`とする（理由は`API_CONNECTIVITY_FINDINGS.md`）。
- **保存してよいのはPlace IDだけ。** 名称・住所・座標・営業時間・所要時間は、処理中にのみ使い、DBやキャッシュへ保存しない。
- Googleマップ以外の画面にPlaces・Routes由来のデータを表示するときは、Googleの帰属表示が必要
  （詳細は`API_CONNECTIVITY_FINDINGS.md`§5）。この帰属表示は、UI側の対応事項。
- 公開するアプリには、利用規約（3.2.2(a)(i)：Google Maps End User Additional Terms と Google Privacy Policy への言及）と、
  プライバシーポリシーが必要（原文を確認済み。詳細は`API_CONNECTIVITY_FINDINGS.md`§5）。規約ページ自体は、このアダプターの範囲外。

## 含まないもの

HTTPのRoute Handler、利用者ごとの利用制限・認証、キャッシュ、照合・制約検証のロジック。
アダプターをHTTP経由で公開する場合は、課金を伴うため、認証と利用制限（#10）を先に入れる。
