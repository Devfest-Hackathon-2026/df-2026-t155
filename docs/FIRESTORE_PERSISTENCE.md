# Firestore保存と本人データの保護（Issue #10）

ブラウザはFirebase匿名認証で取得したIDトークンを送る。各Route Handlerは既存の
`requireActor`でトークンと失効を検証する。Firestore Admin SDKは認証と同じAdmin Appを
サーバーで初期化する。Rulesはクライアントからの読み書きを全件拒否する。

## データ構造

| パス                                                | 保存用DTO                                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}/trips/{tripId}`                        | `{ ownerUid, trip }`。共通TripのID・版・日付・地域・タイムゾーン・希望・Stop・学びの適用情報を保存する。Stopは下記の保存対象に限定する。                                               |
| `users/{uid}/trips/{tripId}/revisions/{revisionId}` | `{ ownerUid, revision }`。対象Trip・版・Stop ID、理由、文脈、前後の保存用Stop、未承認状態を保存する。                                                                                  |
| `users/{uid}/learnings/{learningId}`                | 有効時は `{ ownerUid, state: 'approved', version, learning }`。撤回時は `{ ownerUid, state: 'revoked', id }`。撤回後は本文を消し、古い初回承認リクエストによる復活を防ぐためIDを残す。 |

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
- 根拠一式、住所・座標・営業時間・移動時間、Revisionの影響説明・制約判定は保存対象から外す。
  再取得時の `evidence: []` は根拠が保存されておらず要再照合であることを示す。
  UIで確認済みとして扱わず、Revisionの制約は `not_checked` を返す。
- Places表示名が必要になったときは、保存済みPlace IDをサーバーでPlace Details (New)へ渡し、
  `displayName` を取得して帰属を付けた一時表示に使う。IDが無効・不一致の場合は、元の予定名と地域で再検索する。
  今回の保存APIはMaps照会を行わず、後続の照合機能が再取得を担当する。
- 利用者の自由記述（予定名、Revisionの理由・報告、Learningの本文など）は保存する。手動転記や任意のHTTP入力の
  出所は文字列から証明できない。照合結果やMapsを使った生成処理を接続する際は、元の予定名を維持し、
  外部サービスの値をこれらの欄や生成の永続化対象に転記しない。
- 先行版の `name` 形式の文書は読み出せる。既にプレースホルダーに置換された元の名前は復元できない。

[Places APIのPlace ID保存条件](https://developers.google.com/maps/documentation/places/web-service/place-id) ·
[Google Maps Platformサービス別規約](https://cloud.google.com/maps-platform/terms/maps-service-terms) ·
[Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)

## API

保存APIは既定で無効。`PERSISTENCE_ENABLED=true` のときに有効になり、無効時は認証・本文の読み取り・DBアクセス前に
`503 persistence_disabled` を返す。有効時は全操作に `Authorization: Bearer <Firebase ID token>` が必要。JSON本文のある操作には
`Content-Type: application/json` を指定する。本文上限は64 KiB。レスポンスは `Cache-Control: private, no-store`。
DTOの所有者・撤回マーカーはレスポンスに含めない。

| 操作                                                           | 入力                                                                                                                                                                    | 成功                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `POST /api/trips`                                              | 本人が保存を選んだ `Trip`。初版は `version: 0`、`learningApplications: []`。                                                                                            | 201 `{ trip }`                                                    |
| `GET /api/trips`                                               | なし                                                                                                                                                                    | 200 `{ trips, listInfo }`                                         |
| `GET /api/trips/{tripId}`                                      | なし                                                                                                                                                                    | 200 `{ trip }`                                                    |
| `PATCH /api/trips/{tripId}`                                    | `{ expectedVersion, preferences }`。希望条件のみ変更する。                                                                                                              | 200 `{ trip }`。版はサーバーで+1。                                |
| `POST /api/trips/{tripId}/revisions`                           | 同じTrip・現行版・現行Stopを参照する `Revision`。承認状態は `pending`。                                                                                                 | 201 `{ revision }`                                                |
| `GET /api/trips/{tripId}/revisions`                            | なし                                                                                                                                                                    | 200 `{ revisions, listInfo }`                                     |
| `GET /api/trips/{tripId}/revisions/{revisionId}`               | なし                                                                                                                                                                    | 200 `{ revision }`                                                |
| `POST /api/learnings/{learningId}/approve`                     | `{ expectedVersion, sourceTripId, category, content, scope }`。本人が確認した内容（120文字以内）。初回の期待版は0、再承認は取得した版。地域限定時は元Tripの地域を使う。 | 200 `{ version, learning }`。承認状態・決定時刻はサーバーが設定。 |
| `GET /api/learnings`                                           | なし                                                                                                                                                                    | 200 `{ learnings: [{ version, learning }, ...], listInfo }`       |
| `GET /api/learnings/{learningId}`                              | なし                                                                                                                                                                    | 200 `{ version, learning }`                                       |
| `DELETE /api/learnings/{learningId}?expectedVersion={version}` | 取得した版                                                                                                                                                              | 204                                                               |

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
保存枠はUID内の蓄積量を抑える。繰り返し取得・更新や匿名UIDの量産による全体の利用量には #29 の公開前保護を適用する。

## 版管理と承認

- Trip更新では、トランザクション内で現行版を読み、期待版と一致する場合のみ更新と版の加算を行う。
  同じ期待版で再送・並行更新した場合は一度だけ確定する。作成と候補保存は同じIDで再作成できない。
  応答を受け取れず確定の有無が分からない場合は、再取得して現在の状態を確認できる。
- Revision保存では、同じトランザクションでTripを確認し、現行版・変更前の保存用Stop・固定状態を照合する。
  保存済み候補は、後からTripの版が進んでも元の版を保持する。Tripの予定を変更する適用処理は
  #28の再検証と接続してから公開する。
- Learningの下書きは画面で扱う。編集・却下・入力不備では現行の承認済みレコードが残る。
  再承認では、元Tripの所有権と現行Learningの版・元Trip ID・分類をトランザクション内で確認し、同じIDの承認済み内容を一度に置き換える。
  撤回は別操作とし、現行版の一致を確認して行う。再度保存する場合は新しいIDを使う。

## 後続Issueとの接続

- **PR #27** の照合は元の `Stop.name` を維持し、候補の比較にはアダプターの `PlaceCandidate.name` を使う。
  保存や再照会を接続するときも同じ境界を守る。
- **#9** は保存済みTripとRevisionを取得し、`baseTripVersion` と現行版を比較する。根拠や影響は再取得結果を表示する。
- **#28** は適用直前に、所有権・Trip版・対象ID・変更前Stop・固定予定を照合し、営業時間・移動・時刻の制約をサーバーで再検証する。
  取得や検証を終えた版と対象を適用トランザクション内で再照合し、対象Stopの置換、Trip版の加算、承認・適用の記録をまとめて確定する。
- **#12** は振り返り材料をクライアント申告から本人の保存済みTrip・適用履歴の参照へ切り替える。
  候補編集・却下は下書きの操作とし、承認ボタンを専用APIに接続する。
- **PR #39** のUIは全件を `save(approved[])` に渡し、0件では呼び出さない。
  接続時は変更した項目だけを版付きで承認し、結果を項目ごとに表示する。途中で失敗した場合は保存済みと未保存を区別して再試行する。
  最後の1件も独立した撤回操作で削除できるようにし、下書きの編集・却下とサーバー上の承認・撤回を別々に表示する。
- **#13** は `getApplicableLearnings(new FirestoreLearningStore(), actor.uid, region)` を使い、本人の有効な承認済みLearningを取り出す。
  生成APIでは本文中のLearningを認可に使わず、サーバーで採用・反映先を確定する。
  反映済みTripの保存を接続する際は、参照したLearningの存在・所有者・現行承認を保存トランザクション内で検証する。
- Trip・Revisionの削除や匿名UID喪失後のデータ保持期限は、後続のデータ運用で定める。
