# Gemini・Places・Routes 疎通確認の結果（Issue #3）

実施日：2026-11-05 ／ 対象プロジェクト：`project-a3d3ded4-c376-43a6-8b4` ／ 認証：ADC（OAuth）のみ。APIキーは作成していない。

> **追記（2026-11-07）**：上記プロジェクトは削除要求済み（課金無効）となり、以降は `groundtrip` プロジェクトを使う。同プロジェクトで`aiplatform`・`places`・`routes`を有効化し、Gemini（旅程生成API）とPlaces・Routes（アダプター）が、ADCのOAuthのみで動くことを再確認した（Placesの営業時間取得、存在しない名称の空応答、Routesの徒歩・車）。

> 本書は**疎通確認の実測記録**であり、設計の確定ではない。取得できた情報と、そこから保証できることを区別して書く。

## 1. 結論

**Gemini → Places → Routes の順に呼び、AI生成の旅程を「情報源と整合／矛盾あり／確認できない」に分類する流れは、実際のAPI応答で成立した。** ただし、次の制約を設計に織り込む必要がある。

| 検証対象            | 実測結果                                                                       | 保証できること                           | 保証できないこと                           |
| ------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------ |
| Gemini（Vertex AI） | 検証用の項目を持つJSONを `responseSchema` で生成できた                         | 出力が指定スキーマに従う形式であること   | 内容の正しさ。施設の実在・営業・価格       |
| Places（New）       | Place ID・名称・住所・座標・営業状態・曜日別の通常営業時間・価格帯を取得できた | 取得時点のGoogle上のデータとの突き合わせ | 臨時休業・特別営業・当日の混雑・予約可否   |
| Routes              | 徒歩・車は取得できた                                                           | 取得時点の推定移動時間・距離             | 渋滞や遅延。公共交通は**取得できなかった** |

## 2. 呼び出したAPIと結果

| API・メソッド                        | 主な指定                                                  | HTTP | 結果                                                                      |
| ------------------------------------ | --------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| Vertex AI `generateContent`          | `gemini-3.5-flash`、location=`global`、`responseSchema`   | 200  | スキーマ通りのJSON。2回とも成功                                           |
| 同上                                 | `gemini-2.5-flash`、location=`global`                     | 404  | `NOT_FOUND`。モデル一覧には載っているが、このプロジェクトでは使えなかった |
| Places `places:searchText`           | 日本語クエリ、`locationBias` または `locationRestriction` | 200  | 正常。UTF-8で送った場合は期待した施設が返った                             |
| Routes `directions/v2:computeRoutes` | `DRIVE` / `WALK`（座標またはPlace ID）                    | 200  | 距離・所要時間を取得                                                      |
| 同上                                 | `TRANSIT`（座標・Place ID、出発時刻あり／なし）           | 200  | **4回すべて空（`{}`）。** 原因は未特定                                    |

## 3. 取得できた・できなかったフィールド

- **Places**：`id`、`displayName`、`formattedAddress`、`location`、`types`、`businessStatus`、`regularOpeningHours`（`periods` と `weekdayDescriptions`）、`priceLevel`、`priceRange`（店により有無あり）、`rating`。`regularOpeningHours` が無い店があり、その場合は「確認できない」にする。
- **Routes**：`distanceMeters`、`duration`、`staticDuration`、`legs.localizedValues`、`warnings`。公共交通の乗換情報（`transitDetails`）は、経路が返らないため確認できなかった。
- **Gemini**：`stopId`、`name`、`placeSearchQuery`、`category`、`areaHint`、`startTime`、`stayMinutes`、`isFixed`、`reason`。Placesで照合できる構造を持たせれば、後段で検証できた。

## 4. GroundTrip設計への示唆

1. **名称一致を判定のゲートにする。** 昼食の代替候補で、生成された店名が別の施設（飲食店→別の飲食店、飲食店→医院）に紐付いた。名称が一致しない場合は、営業時間の結果が「矛盾あり」に見えても**「確認できない」**とする。
2. **正規化して名称を比較する。** 「奥丹清水」と「奥丹 清水」のように、空白や表記ゆれで一致しないことがある。空白・記号を除いて比較し、候補が複数あるときは座標と住所も使う。
3. **「候補なし」「同名複数」「API失敗」を区別する。** 空応答は HTTP 200 で返る。HTTPステータスだけでは失敗を検出できない。
4. **営業時間は曜日で判定できる。** `periods` の `day` は 0=日曜。対象日の曜日で突き合わせる。これは**通常営業時間**の照合であり、臨時休業は判定できない。
5. **固定予定への到達性は、徒歩・車で判定できる。** Routes の所要時間と、前後の予定の余裕を比べる。
6. **公共交通は当面「確認できない」として扱う。** 徒歩・車のみで判定し、公共交通を使う案は「移動時間を確認できない」と表示する。Geminiの推定時間を根拠として埋めない。公式FAQの記述と実測の関係は§6を参照。
7. **Geminiのモデル名は設定で差し替え可能にする。** 一覧にあっても404になるモデルがあった。起動時または初回呼び出しで可用性を確認する。
8. **日本語クエリは UTF-8 で送る。** Windows の Git Bash の `curl -d` で日本語を直接渡すと UTF-8 にならず、無関係な結果が返る。HTTPクライアントを使う実装では問題にならないが、手元の検証では注意する。

## 5. 費用・規約の注意

- **Places API (New) のフィールドのSKU区分**（公式のデータフィールド一覧による。2026-11-07 確認）：
  - `regularOpeningHours` と `priceRange` は、いずれも **Enterprise**（Text Searchでも Enterprise）。
  - `displayName`・`businessStatus`・`formattedAddress`・`location` は、いずれも **Pro**（Text Search）。`id` は Essentials（IDs Only）。
    （以前の版は、`formattedAddress` と `location` を Essentials としていたが、誤り。公式のデータフィールド一覧の表で、Text Search Pro と確認した。2026-11-07）
  - 実際の単価・請求額は、本書では確定していない。実運用前に、公式の料金表とCloud Billingの請求内訳で確認する。
- **複数のSKUのフィールドを指定したときは、最も高いSKUで課金される**（公式の[Usage and Billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)。2026-11-07 に原文を確認）。原文：`You are then billed at the highest SKU applicable to your request. That means if you select fields in both the Essentials and the Pro SKUs, you are billed based on the Pro SKU.`（Place Details・Nearby Search・Text Search の FieldMask）。したがって、Text Search の既定（営業時間なし）は **Pro** で課金され、`regularOpeningHours`（Enterprise）を加えると、リクエスト全体が **Enterprise** になる。必要最小限のFieldMaskとし、営業時間は、必要なときだけ要求する（アダプターの既定は要求しない）。
- **保存・表示の条件**（Google Maps Platformの条件。設計書の不変条件 7 に従う）：
  - Place ID は、キャッシュ制限の例外で、**無期限に保存してよい**（Places・Routesのポリシーページ。確認済み）。
  - Place ID 以外のキャッシュ・保存は、**利用規約の原文を確認した**（2026-11-07。[Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms) と [Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)）：
    - 規約 3.2.3(a)(iii)：business names・addresses・user reviews を、コピーして保存しない。3.2.3(b)：Service Specific Terms で明示的に許可されたものを除き、Google Maps Content をキャッシュしない。
    - Service Specific Terms の Google ID Caching：`place_id` は、Places API・Routes API 等から、キャッシュしてよい。
    - Service Specific Terms 14.3（Places）・19.3（Routes）：**緯度経度だけ**を、連続30日まで一時的にキャッシュでき、その後は削除する。名称・営業時間・所要時間などは、キャッシュの許可が無い。
    - 規約 3.2.3(c)(vii)：Google Maps Content を、機械学習・AIモデルの改善（学習・テスト・検証・ファインチューニング）に使わない。
    - **運用方針：Place ID だけを保存し、それ以外は処理中にのみ使う**（上記と整合）。
  - Googleマップを使わずにPlaces・Routesのデータを画面に表示するときは、**Googleの帰属表示が必要**（Googleマップのロゴが望ましく、スペースが足りない場合のみテキスト「Google Maps」。コンテンツの上端または下端の近く、同じ視覚的なまとまりの中に置く。ポリシーページ。確認済み）。Googleマップ上に表示し、帰属がすでに見える場合は不要。旅程の路線図（Googleマップではない画面）に、Places由来の名称・営業時間等を出す場合は、この帰属表示が必要になる。
  - **非Googleの地図との併用の禁止**：規約 3.2.3(e) と、Service Specific Terms 14.2（Places）・19.2（Routes）は、Places・Routesの内容を、**非Googleの地図と併用しない**ことを求める。GroundTripの路線図は、実際の地図ではない順番の図（路線図型）で、地図ではない、という整理で設計している。ただし、**この解釈でよいかは、人が確認する**（地図と見なされる表現にしない。例：実際の位置関係・縮尺・地図タイルを描かない）。
  - 請求先がEEAの場合は、別の規約が適用される。
  - **アプリ側の利用規約・プライバシーポリシー（公開するアプリに求められる要件）**。利用規約の原文を確認した（2026-11-07。[Terms of Service](https://cloud.google.com/maps-platform/terms)）：
    - **3.2.2(a)(i)**：アプリの利用規約は、(A) アプリがGoogleマップの機能・コンテンツを含むことを利用者に通知し、(B) その利用が、**Google Maps End User Additional Terms of Service**（https://maps.google.com/help/terms_maps/）と、**Google Privacy Policy**（https://policies.google.com/privacy）の、その時点の最新版に従うことを、記載する。
    - **3.2.2(b)**：Googleが提供する帰属表示（ブランド・ロゴ・著作権表示）と、Service Specific Terms が定める帰属表示を表示し、変更・隠蔽・削除しない。
    - **4.4(c)(i)**：利用が、適用されるプライバシー法（端末のCookie等を含む）に従うこと。該当する場合は、Googleの[User Consent Policy](https://www.google.com/about/company/user-consent-policy/)に従う。
    - **4.4(c)(ii)**：利用者の個人を特定できる情報、欧州（EEA・スイス・英国）の利用者の個人データを、**Googleへ提供しない**。
    - **4.4(c)(iii)**：利用者の位置情報について、収集する前に、収集するデータの種類と、位置情報と他のデータの組み合わせ・利用を**通知**し、**事前の明示的で、取り消せる同意**なしに、位置情報を取得・キャッシュしない（現地での再計画で現在地を使う場合に該当する）。
    - **4.4(a)**：Googleが、検索語・IPアドレス・緯度経度を受け取り、Googleのプライバシーポリシーに従って使うことに、同意する。
    - **GroundTripの方針**：公開するアプリの利用規約に、3.2.2(a)(i)の通知と記載（上の2つの規約へのリンクを含む）を入れる。プライバシーポリシーには、取得する情報、Google Maps Platformを利用すること、Googleのプライバシーポリシーへの案内、保存するのはPlace IDだけであること、位置情報を使う場合の通知と同意を書く。現地での再計画で現在地を使う場合は、4.4(c)(iii)の同意の取得を、実装時の必須事項とする。今回のPRでは、規約ページ自体は実装しない。

## 6. 未解決事項

- Routes の `TRANSIT` が空になる原因。公式FAQ（Google Maps Platform FAQ「In which countries are transit directions available?」）に、「Routes APIは、Indian Railway Catering and Tourism Corporation と日本のものを除く、Google Transitパートナーに対応する」旨の記載がある（原文：`The Routes API supports all Google Transit partners, except the Indian Railway Catering and Tourism Corporation and those in Japan.`）。実測した`TRANSIT`の4回の空応答と整合する説明だが、**個々の空応答の原因や、日本国内のすべての公共交通経路の可否までは断定しない**（FAQは「サポート外」という語や`TRANSIT`への言及はしておらず、「日本のもの」が指す事業者の範囲も書かれていない）。方針は§4-6のとおり、当面「確認できない」とし、アダプターは`TRANSIT`を呼び出さない。
- 将来日時の営業時間（`regularOpeningHours` と `currentOpeningHours` の使い分け）。
- 交通状況を考慮した所要時間（`TRAFFIC_AWARE`）。
- 費用上限（予算アラート、クォータ）の設定。
- 本番で APIキー を使うか、サービスアカウント／ワークロードのOAuthを使うか。キー作成には `apikeys.googleapis.com` の有効化が必要で、本確認では実施していない。
