# Firestore保存と本人データの保護（Issue #10）

ブラウザはFirebase匿名認証で取得したIDトークンを送る。各Route Handlerは既存の
`requireActor`でトークンと失効を検証する。Firestore Admin SDKは認証と同じAdmin Appを
サーバーで初期化する。Rulesはクライアントからの読み書きを全件拒否する。

## データ構造

| パス                                                | 保存用DTO                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}/trips/{tripId}`                        | `{ ownerUid, trip }`。共通TripのID・版・日付・地域・タイムゾーン・希望・Stop・学びの適用情報を保存する。Stopは下記の保存対象に限定する。                                                          |
| `users/{uid}/trips/{tripId}/revisions/{revisionId}` | `{ ownerUid, revision }`。対象Trip・版・Stop ID、理由、文脈、前後の保存用Stop、移動手段、判定に必要な本人報告、検証した候補の有効期限、承認状態を保存する。適用時はサーバーが決定日時を記録する。 |
| `users/{uid}/learnings/{learningId}`                | 有効時は `{ ownerUid, state: 'approved', version, learning }`。撤回時は `{ ownerUid, state: 'revoked', id }`。撤回後は本文を消し、古い初回承認リクエストによる復活を防ぐためIDを残す。            |

UIDは検証済みActorから決める。関連Tripも本人のパスで参照し、取得したデータの
`ownerUid`を `requireOwner` で照合する。IDと文書キーも照合する。通常のIDはそのまま使い、
Unicodeやパスの区切り文字・予約名を含むIDは衝突しないキーに変換する。文書内とAPI上のIDは元の値を保つ。
APIで文書を指定するIDは256文字までとし、パスパラメーターではURLエンコードする。
新規作成では、URLが正規化する `.` と `..`、静的ルートと重なるTrip IDの `generate`、`verify`、`revise`、
Learning IDの `candidates` を拒否する。

共通Zodスキーマの項目を基に保存DTOを定義し、書き込み前に検証する。読み出し時は
DTOと復元後のドメインモデルを検証し、IDの重複・不正な時刻・不正な承認状態などを拒否する。
JSONエスケープで渡された孤立サロゲートは、ネストした文字列を含めてDB操作前に400で拒否する。

### Maps由来データ

- 旅程生成が本人入力またはGemini提案から作る `Stop.name` は、アプリの予定名兼検索名とする。
  Firestoreでは `planName` に保存し、読み出し時は `Stop.name` に戻す。照合失敗時も予定名と地域で再検索できる。
- サーバーのPlacesアダプターは取得した `displayName` を照合用の `PlaceCandidate.name` として返す。
  予定名とは別の一時データとして扱い、
  `Stop.name` や予定時刻・滞在時間に、取得名・営業時間・Routesの所要時間を転記しない。
  Google Maps由来の保存対象は再照会用のPlace IDのみ。HTTPで受け取るPlace IDは照合の証明に使わない。
  根拠の有無や出典も予定名の由来の判定に使わない。
- Maps等の照合根拠、住所・座標・営業時間・移動時間、Revisionの影響説明・制約判定は保存対象から外す。
  Tripの再取得時は `evidence: []` を返す。Revisionの再取得時は `not_checked` と判定に関わる本人報告の矛盾だけを返す。
  本人報告は対象の前後を区別して保存する。出典URLは除き、分類・対象・申告内容は再検証時に成立を止める側にだけ使う。
- Places表示名が必要になったときは、保存済みPlace IDをサーバーでPlace Details (New)へ渡し、
  `displayName` を取得して帰属を付けた一時表示に使う。IDが無効・不一致の場合は、元の予定名と地域で再検索する。
  候補保存と取得はMaps照会を行わない。適用時の再照合では、予定名と地域で検索し、保存済みの候補Place IDとの一致を確認する。
- 利用者の自由記述（予定名、Revisionの理由・報告、Learningの本文など）は保存する。手動転記や任意のHTTP入力の
  出所は文字列から証明できない。照合結果やMapsを使った生成処理を接続する際は、元の予定名を維持し、
  外部サービスの値をこれらの欄や生成の永続化対象に転記しない。
- 先行版の `name` 形式の文書は読み出せる。既にプレースホルダーに置換された元の名前は復元できない。

[Places APIのPlace ID保存条件](https://developers.google.com/maps/documentation/places/web-service/place-id) ·
[Google Maps Platformサービス別規約](https://cloud.google.com/maps-platform/terms/maps-service-terms) ·
[Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)

## API

保存APIは既定で無効。本番の招待制デモは `PERSISTENCE_ENABLED` と `COSTLY_API_DEMO_ENABLED` の両方が必要。
停止中は認証・本文・DBに進まず503 `persistence_disabled` を返す。有効時はBearer、招待UID、App Check、共有利用枠を検証する。
[設定とエラーの契約](API_ABUSE_PROTECTION.md)を参照。書き込みには
`Content-Type: application/json` を指定する。本文上限は64 KiB。レスポンスは `Cache-Control: private, no-store`。
DTOの所有者・撤回マーカーはレスポンスに含めない。

| 操作                                                           | 入力                                                                                                                                                                    | 成功                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /api/trips`                                              | 本人が保存を選んだ `Trip`。初版は `version: 0`、`learningApplications: []`。                                                                                            | 201 `{ trip }`                                                     |
| `GET /api/trips`                                               | なし                                                                                                                                                                    | 200 `{ trips, listInfo }`                                          |
| `GET /api/trips/{tripId}`                                      | なし                                                                                                                                                                    | 200 `{ trip }`                                                     |
| `PATCH /api/trips/{tripId}`                                    | `{ expectedVersion, preferences }`。希望条件のみ変更する。                                                                                                              | 200 `{ trip }`。版はサーバーで+1。                                 |
| `POST /api/trips/{tripId}/revisions`                           | 同じTrip・現行版・現行Stopを参照する未承認 `Revision` 、生成時と同じ `travelModes`、候補ごとの `proposalToken`。トークンなしは履歴用。                                  | 201 `{ revision }`                                                 |
| `GET /api/trips/{tripId}/revisions`                            | なし                                                                                                                                                                    | 200 `{ revisions, listInfo }`                                      |
| `GET /api/trips/{tripId}/revisions/{revisionId}`               | なし                                                                                                                                                                    | 200 `{ revision }`                                                 |
| `POST /api/trips/{tripId}/revisions/{revisionId}/apply`        | `{ expectedVersion, confirm: true }`。期待版は承認時に確認したTrip版。                                                                                                  | 200 `{ status, appliedTripVersion, trip, revision, verification }` |
| `POST /api/learnings/{learningId}/approve`                     | `{ expectedVersion, sourceTripId, category, content, scope }`。本人が確認した内容（120文字以内）。初回の期待版は0、再承認は取得した版。地域限定時は元Tripの地域を使う。 | 200 `{ version, learning }`。承認状態・決定時刻はサーバーが設定。  |
| `GET /api/learnings`                                           | なし                                                                                                                                                                    | 200 `{ learnings: [{ version, learning }, ...], listInfo }`        |
| `GET /api/learnings/{learningId}`                              | なし                                                                                                                                                                    | 200 `{ version, learning }`                                        |
| `DELETE /api/learnings/{learningId}?expectedVersion={version}` | 取得した版                                                                                                                                                              | 204                                                                |

失敗は `{ error: { code, message } }`。未認証・不正・期限切れ・失効は401。
所有者不一致・対象なしは同じ404 `not_found`。入力不正は400、本文超過は413、
Content-Type不正は415。期待版の不一致は409 `version_conflict`、IDの重複は409
`already_exists`、Revisionと現行Stopの不一致は409 `revision_mismatch`、件数上限は409 `storage_limit_reached`、
撤回済みIDの再承認は409 `learning_revoked`。
保存内容の破損は500 `invalid_stored_data`、想定外の処理エラーは500 `internal_error`、
既知のFirestore障害は503 `storage_unavailable`、認証基盤の障害は503 `auth_unavailable`。
内部エラーの詳細はレスポンスに含めない。診断ログは固定コードに限定し、同一コードは1プロセスで毎分1件まで記録する。

## 件数と入力の上限

| 対象     | 保存枠                               | 一覧の返却上限 |
| -------- | ------------------------------------ | -------------- |
| Trip     | UIDごとに20件                        | 20件           |
| Revision | Tripごとに12件（UIDごとに最大240件） | 12件           |
| Learning | UIDごとに40件。撤回済みIDも枠を使う  | 40件           |

新規作成と枠カウンターの更新は同じFirestoreトランザクションで確定する。カウンターが存在しないときは
既存文書を上限まで数える。Learningの再承認は新しい枠を消費しない。撤回マーカーも再送防止のため枠に含める。

書き込みは本文64 KiB以内とし、地域120文字、予定名200文字、Place ID 1024文字、希望条件16件・各200文字、
Stopごとの根拠16件、変更理由・現地報告各1000文字、Learning本文120文字を上限とする。
先行文書の読み取りは書き込み上限と独立に検証する。旧DTOは引き続き読み取れる。
将来の非互換な変更は、その時点で読み取り互換と明示的な形式バージョンを検討する。

一覧は上限に判定用の1件を加えた範囲だけを読み、`listInfo.returned` に返した件数、`skippedInvalid` に
対象範囲内の破損による除外件数、`truncated` に上限超過の有無を返す。除外・打ち切りがある場合は不完全な一覧として扱う。
個別取得は破損文書に500を返す。次回の旅程生成用の学びを取り出すサーバー経路も、不完全な一覧の利用を拒否する。

### 有効化条件

ローカル検証はEmulatorに限定する。一般公開は、対象DB・ADC/IAM・全拒否Rulesを確認し、匿名UIDを増やしても回避できない
全体の回数・同時実行制限、App Checkまたは代替策、GCPのクォータ・予算通知・停止手順を用意してから判断する。
保存枠はUID内の蓄積量を抑える。繰り返し取得・更新や匿名UIDの量産による全体の利用量には、[Issue #29の公開前保護](API_ABUSE_PROTECTION.md)を適用する。
Revision適用はさらに `TRIP_REVISION_APPLY_ENABLED=true` が必要で、本番は共通デモフラグも要る。未設定時は認証・利用枠の予約・本文読取・DB・Mapsアクセスより前に
`503 revision_apply_disabled` を返す。適用・本人報告の更新・候補の保存は、課金・保存の共通の利用枠と書き込み権（fencing）を通す。
署名鍵はサーバー専用の `REVISION_PROPOSAL_SIGNING_KEY` に32バイトの乱数をbase64urlで設定し、全インスタンスで共有する。
鍵の更新で未保存の旧署名は無効になる。保存時に検証済みの候補は記録した期限を使う。

## 書き込みの結果が不明な場合

書き込みのコミットと同じ取引で、共有制御文書の版を照合する。期限後に再開した処理は、
書き込み権の失効・回収や期間切替が先に永続化されていれば、古い版のまま確定できない。
コミットの応答を失った場合は503 `write_result_unknown`。HTTPタイムアウトも結果確認のきっかけとし、
再送前に現在の版・ID・承認状態を取得する。旧版や同一IDでの再送は重複書き込みを防ぐ既存の制約を通る。
Revision適用は、結果不明のとき同じ操作の読取枠内で版と承認状態を一度だけ照会する。承認済みなら `already_applied` を返し、
確認できなければ503 `apply_result_unknown`。自動で再送しない。
[期限とコミットの境界、デモ期間の切替](API_ABUSE_PROTECTION.md#業務書き込みのfencing)

## 版管理と承認

- Trip更新では、トランザクション内で現行版を読み、期待版と一致する場合のみ更新と版の加算を行う。
  同じ期待版で再送・並行更新した場合は一度だけ確定する。作成と候補保存は同じIDで再作成できない。
  応答を受け取れず確定の有無が分からない場合は、再取得して現在の状態を確認できる。
- Revision保存では、同じトランザクションでTripを確認し、現行版・変更前の保存用Stop・固定状態を照合する。
  保存済み候補は、後からTripの版が進んでも元の版を保持する。
- Learningの下書きは画面で扱う。編集・却下・入力不備では現行の承認済みレコードが残る。
  再承認では、元Tripの所有権と現行Learningの版・元Trip ID・分類をトランザクション内で確認し、同じIDの承認済み内容を一度に置き換える。
  撤回は別操作とし、現行版の一致を確認して行う。再度保存する場合は新しいIDを使う。

### Revisionの適用と再取得

1. 認証後、読み取り専用トランザクションで本人のTripとRevisionを同じ時点で読み、期待版・候補の基準版・現行版、対象の存在・固定状態・変更前の値を照合する。
   差し替えの範囲は対象1件の予定名とPlace IDに限る。ID、開始時刻、滞在時間、種別、固定状態は保持する。
2. Firestoreトランザクションの外で `checkRevisionConstraints` を呼ぶ。施設を新たに検索し、候補と、保存済みPlace IDのある
   前後の予定の同一性を照合する。候補の営業時間と前後の移動を確認し、新しい根拠が揃い `satisfied` の場合だけ進む。
   適用操作の入力は版と明示承認だけ。再照合には保存した候補を使い、Geminiによる候補の再生成は行わない。
3. 同じFirestoreトランザクションで両文書を再読込し、所有権・版・対象・照合時点の両文書の更新時刻を確認する。
   対象の差し替え、Trip版の加算、Revisionの `approved` とサーバー決定日時をまとめて確定する。

候補保存の `travelModes` は、候補生成時に利用者が指定した手段を渡す。省略の契約は生成・保存ともに徒歩のみ。
新規保存時に正規化した手段を記録し、適用時にはその値を使う。保存時に所有者・旅程の保存項目・候補・報告・移動手段を署名と照合する。
署名は15分有効。保存後も未確定の候補には同じ期限を適用し、書き込みトランザクション内で期限を再確認する。
署名自体は保存しない。手段や来歴が未記録の旧候補は個別・一覧で読める。適用には新しい候補を作成・保存する。
署名のv2は報告の版と比較時の前後StopのPlace IDを含む。保存時に検証した情報をRevisionに記録し、
再検証で別施設へ解決された場合は `409 revision_endpoints_changed` を返す。v1と検証情報のない旧未承認候補は再生成が必要。
すでに確定した履歴は従来どおり確認できる。

### 未解消の本人報告

旅程文書の `revisionReports` に対象Stopごとの `blocked` と単調増加する `reportVersion` を保持する。
候補生成と候補保存で報告を記録し、適用前と書き込みトランザクション内で参照する。
元施設の変更で解消できない本人報告の矛盾、旧形式の実報告、遅延・その他の実報告が対象。模擬報告は対象外。
候補の再発行やTrip版の更新では消えない。旧旅程は保存済みの候補から報告を復元する。

認証付きの `GET /api/trips/{tripId}/revision-reports/{stopId}` は `{ tripVersion, reportVersion, blocked }` を返す。
同じ経路への `POST` で `{ expectedVersion, expectedReportVersion, confirm: true }` を送ると、本人が明示的に解消できる。
解消で報告版が進み、解消前の署名・候補は再利用できない。新しい報告が先に記録された場合は409を返す。
解消は本人の申告として扱う。再生成時に古い申告を再送した場合は改めて未解消として扱う。

新規適用は `status: 'applied'` を返す。同じRevision IDと元の `expectedVersion` の再送は、確定済みなら
`status: 'already_applied'` を返し、Maps照合や版の加算を繰り返さない。`appliedTripVersion` は適用時の版
（`baseTripVersion + 1`）で、`trip` はレスポンスの取得時点のTrip。後続の編集があれば `trip.version` の方が大きい。
新規確定時の `verification: 'fresh'` は、対象Stopの `trip.stops[].evidence` に同じリクエストで取得した一時的な根拠があることを示す。
再送応答の `verification: 'not_available'` は今回の再照合データが無いことを示し、確定記録は期限後も確認できる。
適用応答・個別取得・一覧の `revision` は保存履歴の契約を使う。 `approved` は適用済みを表し、
`constraintCheck: { status: 'not_checked', ... }` と `evidence: []` は現在の状況が要再照合であることを表す。
候補生成の共通 `RevisionSchema` と、未承認限定の新規保存契約は従来どおり。

| HTTP | 適用で追加するエラーコード        | 意味                                                                       |
| ---- | --------------------------------- | -------------------------------------------------------------------------- |
| 409  | `revision_not_pending`            | 決定済みの候補                                                             |
| 409  | `revision_travel_modes_missing`   | 旧候補に移動手段の記録がない                                               |
| 422  | `revision_simulated`              | 保存された文脈が模擬現地報告                                               |
| 409  | `revision_provenance_missing`     | 保存時に署名を検証した記録がない                                           |
| 409  | `revision_proposal_expired`       | 署名付き候補が期限切れ                                                     |
| 422  | `revision_provenance_invalid`     | 保存入力と署名が一致しない                                                 |
| 503  | `revision_provenance_unavailable` | 署名の検証に必要な鍵を利用できない                                         |
| 422  | `revision_not_applicable`         | 施設を特定できない、営業時間が矛盾する、固定予定への移動に間に合わないなど |
| 422  | `revision_place_mismatch`         | 候補や前後の予定のPlace IDが再照合と一致しない、または候補のPlace IDがない |
| 422  | `revision_unverified`             | 営業時間や経路など、適用に必要な情報を確認できない                         |
| 502  | `external_service_error`          | PlacesまたはRoutes呼び出しの失敗                                           |
| 503  | `apply_result_unknown`            | コミット結果を確認できない                                                 |

適用・本人報告の取得と解消は、他の保存操作と同じく Bearer、招待UID、Web App Check、共有利用枠が必要で、拒否は
401・403・429と503（`protection_unavailable`、`write_result_unknown`）で返る（[意味と再試行](API_ABUSE_PROTECTION.md#クライアント契約)）。
適用の再検証（Places・Routes）は保存と同じ操作の予約に含まれる。

コミット結果が不明な場合、クライアントは最新のTripと対象RevisionをGETし、Revisionの承認状態と適用版を確認する。
通信が途切れたり `apply_result_unknown` を受け取った直後の `pending` は取得時点の状態。
再送する場合は元のRevision IDと期待版を使う。確定したRevisionのGETは適用フラグが無効でも利用できる。

模擬報告の拒否は署名で候補と結び付けた `context` に基づく。署名は生成時の申告との一致を確認する。
利用者が生成時に実報告として入力した内容の事実性は、署名からは判断できない。

## 振り返り画面の保存（セッション・結果不明・保存後の確認）

`/reflection` の画面（`src/features/reflection-flow/`）は、サーバーAPIの契約（競合検知・期待版）を変えずに、
次のとおり保存を扱う。クライアントの状態管理だけで整合性を保証したことにはしない。最終的な整合はサーバーの版検査が担う。

### 認証セッションとの結び付け

- 取得した旅行・履歴・保存済みの一覧は、取得した認証セッション（UIDと`scopeEpoch`）と組で保持する
  （[AUTHENTICATION.md](./AUTHENTICATION.md)の「セッションスコープ」）。UIDまたは世代が変わると、別のセッションの画面には見えず、
  選択中の旅行・確認待ち・入力中の候補と承認・進行中の取得と保存を破棄する。A→B→Aと戻っても、最初のAの内容は復活しない。
- すべての要求（旅行・履歴・保存済みの学びのGET、承認のPOST）は`getAuthHeadersForScope(scope)`で送る。保存の各POSTの直前にも確かめ、
  途中でUIDが変わったら残りは送らず「セッションが変わったため保存を中止しました」と示す。GETは応答を採用する前にも、現在のUIDを読み直して照合する。
- 保存先（`createFirestoreLearningStore`）はセッションごとに作る。確認済みの版の記憶も、そのセッションの中だけで持つ。
  異なるUIDに同じTrip ID・Learning IDがあっても、版や内容を取り違えない。
- 認証の復元に失敗しても、匿名アカウントを自動作成しない。認証の確認中（`restoring`）は同じUIDなら内容を保つが、確認できるまで保存はできない。

### 保存済み・結果不明・未保存

承認は1件ずつなので、一部だけ保存されることがある。`SaveResult`は任意の`savedIds`（保存済み）と`unknownIds`（結果不明）を返し、
どちらにも無い学びは未保存とする。

| 結果             | 条件                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保存済み         | POST応答のID・内容・版（期待版+1）を検証できた。または保存後に取り直した一覧で、同じ内容を確認できた。                                                                                                                           |
| 結果不明         | 送信した後に応答だけを失った（通信断・タイムアウト・中止・読めない応答・契約に合わない応答）。`storage_unavailable`・`internal_error`・`invalid_stored_data`（書き込みの後に起きた可能性がある）。応答の内容が送った内容と違う。 |
| 未保存（拒否）   | サーバーが何も変更せずに拒否した固定コード（`version_conflict`・`learning_revoked`・`storage_limit_reached`・`already_exists`・`invalid_request`・認証エラー・`persistence_disabled`・`auth_unavailable`など）。                 |
| 未保存（未送信） | 送信前に止まった（セッションが変わった・認証を使えない・中止・保存前の検査）。                                                                                                                                                   |

- 結果不明の学びは、自動では再送しない。保存した後に一覧を取り直して照合し、同じ内容が見つかれば保存済みに直す。
  見つからないだけでは未保存とは決めない（処理が遅れて反映される可能性がある）。
- 利用者が結果不明の後に保存し直すと、先に保存済みの一覧を取り直す。同じ内容があれば再送せず、無ければ初回の期待版で送る。
  サーバーは期待版が合わなければ`409 version_conflict`で止めるので、二重に保存されない。
- 書き込みを送った後は、最後に一覧を取り直す（最後の取得は最後の書き込みより後）。事前の一覧で同じ内容だった学びが、処理中に変更・撤回
  されていたら、保存済みと断定しない。取り直せなかったときは、事前の一覧だけの学びを「結果不明」にする。
- 一覧は、読み取れない項目・打ち切りに加え、`listInfo.returned`と実際の件数が食い違うときも不完全として扱い、書き込みの根拠にしない。
- サーバーのエラー本文は画面に出さない。既知のコードの定型文言だけを出し、未知のコードや読めない本文はステータスごとの文言にする。
  保存サービスの停止（503）と、端末側の認証の復元の失敗は、別の理由として示す。

### 撤回の操作は未提供

画面上の編集・却下は下書きの操作で、保存済みの承認を取り消さない。保存済みの学びを撤回する操作は、この画面にはまだ無い。
画面は「保存済みの承認は取り消されない」「撤回する操作は提供していない」と事実を示す。

## 後続Issueとの接続

- **PR #27** の照合は元の `Stop.name` を維持し、候補の比較にはアダプターの `PlaceCandidate.name` を使う。
  保存や再照会を接続するときも同じ境界を守る。
- **#46** の共通判定で、実際の現地報告と根拠の矛盾、元の施設と同一の候補を適用前にも確認する。
- **PR #50・#54** は候補生成時の移動手段と署名を保存に渡し、本人の適用操作と結果不明時のGETを接続する。
  HTTP 200は `readRevisionApplyResponse` で検証し、`503 apply_result_unknown` や送信後の応答喪失では確定結果を取得するまで再操作を止める。
- **#12** は振り返り材料をクライアント申告から本人の保存済みTrip・適用履歴の参照へ切り替える。
  候補編集・却下は下書きの操作とし、承認ボタンを専用APIに接続する。
- **PR #39** のUIは全件を `save(approved[])` に渡し、0件では呼び出さない。
  接続時は変更した項目だけを版付きで承認し、結果を項目ごとに表示する。途中で失敗した場合は保存済みと未保存を区別して再試行する。
  最後の1件も独立した撤回操作で削除できるようにし、下書きの編集・却下とサーバー上の承認・撤回を別々に表示する。
- **#13** は `resolveSelectedLearnings(new FirestoreLearningStore(), actor.uid, region, selections)` を使い、
  利用者が画面で選んだ `{ id, version }` を、`listVersionedApproved` で取り出した本人の有効な承認済みLearningの現行版と照合する。
  生成APIでは本文中のLearningを認可に使わず、サーバーで採用・反映先を確定する（詳細は[学びの接続契約](LEARNINGS.md)）。
  画面の選択は、取得時の認証セッション（UID）と組で保持し、別のUIDのトークンで送らない。
  `resolveSelectedLearnings` が返す値は、Firestoreを読んだ時点のスナップショット。外部のGemini呼び出しをトランザクションで囲まない。
  反映済みTripの保存を接続する際は、参照したLearningの存在・所有者・現行承認と、生成時に検証した版を
  保存トランザクション内で再検証する（現在の保存APIは適用記録つきのTripを受け付けない。提案は[学びの接続契約](LEARNINGS.md)）。
- Trip・Revisionの削除や匿名UID喪失後のデータ保持期限は、後続のデータ運用で定める。
