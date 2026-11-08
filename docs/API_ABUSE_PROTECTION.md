# 課金API・Firestoreの公開前保護（Issue #29）

同一サーバープロセス・Firestoreクライアント内では、確認済みの利用枠超過だけを最大1秒、最大512件保持し、同じ要求の繰り返しによる制御文書の読取を減らす。全体枠とUID別枠を分け、費用ベクトルとUIDのハッシュを照合する。許可やストア障害は保存しない。制御文書の停止や期間切替、同時枠の解放後も最大1秒は以前の429が返る場合があるが、この間に予約を許可することはない。各インスタンスのキャッシュは共有されず、新規キーや期限切れ、インスタンス増加に伴うFirestore読取やその他の費用を制限しないため、全体の課金上限ではない。

**一般公開不可。** 課金4ルートと保存14操作（Revision適用と本人報告の取得・解消を含む）に、Firebase本人認証、招待UID、Web App Check、Firestoreの分散利用枠を接続した。機能フラグと本番の共通デモフラグは既定無効。画面側APIクライアントは本人のBearerとApp Checkを送る。#54等の画面統合・実環境検証・拒否トラフィックの費用対策が公開前に残る。Console設定と実Firebase疎通は未実施。 [Issue #29](https://github.com/cludewn/groundtrip/issues/29)

#60は短期間・少人数の審査用。既存App Hostingでこの保護を適用し、公開の判断とは分けて[期間限定の運用条件](DEMO_ACCESS.md#期間限定のapp-hosting運用)を確認する。

## 調査時点の入口と呼び出し量

基準は `main` の `25c3e0b`。公開HTTPから課金APIへ到達する経路は以下の4つ。数値は現行コードで可能な1リクエスト当たりの上限であり、今回の利用枠の設定値ではない。

| HTTP                             | 機能フラグ                    | 実際の下流処理                                                                                                                                        |
| -------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/trips/generate`       | `TRIP_GENERATION_ENABLED`     | `generateTrip` → Vertex AI Gemini 1回                                                                                                                 |
| `POST /api/trips/verify`         | `TRIP_VERIFICATION_ENABLED`   | `verifyTrip` → Places Text Search 最大4回、Routes Compute Routes 最大3回（徒歩）                                                                      |
| `POST /api/trips/revise`         | `TRIP_REVISION_ENABLED`       | `reviseTrip` → Gemini 1回、Places 最大 `3+N` 回、Routes 最大 `2+2N` 回（徒歩）。候補 `N ≤ 3`。車を明示した場合は各区間で追加1回のため、Routes最大16回 |
| `POST /api/learnings/candidates` | `LEARNING_CANDIDATES_ENABLED` | `generateLearningCandidates` → Vertex AI Gemini 最大1回                                                                                               |

Geminiは `@google/genai` をVertex AIモードで使用し、認証はADC。既存設定はSDKの送信試行1回、自動継続なし、45秒のタイムアウト、最大出力8192トークン。PlacesとRoutesはADCのOAuthと `X-Goog-User-Project` を使い、アダプターで再送せず、呼び出し単位のタイムアウトは15秒。並列に送る処理がある。Placesは営業時間を要求する場合としない場合でSKUが異なる。リクエスト数と別に、Gemini入出力トークン・PlacesのFieldMask・Routesの機能別SKUを費用に計上する。 [部分修正の呼び出し内訳](PARTIAL_REVISION.md) · [Placesの課金](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing) · [Routesの課金](https://developers.google.com/maps/documentation/routes/usage-and-billing)

`checkRevisionConstraints` は内部からMapsを呼べる。Revision適用（`POST /api/trips/{tripId}/revisions/{revisionId}/apply`）の確定前の再検証がこれを呼ぶため、適用を新たな有料の入口として扱い、同じ操作の予約と計量済みclientに接続した（[統合の内訳](#並行開発との統合)）。現行のHTTP経路の点検では、Routeからの直接呼び出しに加えて、Geminiの `generateContent`、Placesの `searchText`、Routesの `computeRoutes` の利用箇所とアダプターの呼び出し元を確認した。

Firestoreは `PERSISTENCE_ENABLED` で制御し、各Routeの `withDataActor` が本文・業務ストア操作の前にフラグ、認証、招待UID、App Check、分散利用枠を確認する。Admin SDKは全拒否Rulesを迂回するため、UIDで保存先を分け、保存済みデータで所有者を検証する。以下の操作数は既存の取得件数やトランザクションの構造から見た目安で、再試行やインデックス等の課金は別に見積もる。 [保存APIと保存枠](FIRESTORE_PERSISTENCE.md) · [Firestore課金](https://firebase.google.com/docs/firestore/pricing)

| Firestoreを使うHTTP                                                                   | 主な操作とコスト要因                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/trips`、`GET /api/trips/{tripId}`                                           | 一覧は最大21文書、個別は1文書を読む                                                                                                  |
| `POST /api/trips`、`PATCH /api/trips/{tripId}`                                        | 作成は重複・保存枠の確認と2書き込み。保存枠カウンターがない場合は最大20件を追加で確認。PATCHは版確認の読み取りとTripの書き込み       |
| `GET /api/trips/{tripId}/revisions`、`GET /api/trips/{tripId}/revisions/{revisionId}` | 親Tripを読んでから、一覧は最大13文書、個別は1文書を読む                                                                              |
| `POST /api/trips/{tripId}/revisions/{revisionId}/apply`                               | Trip・候補を読み、Places/Routesで再検証してから、Tripの更新と候補の承認を1つの取引で確定。有料と保存の枠を同時に使う                 |
| `GET`・`POST /api/trips/{tripId}/revision-reports/{stopId}`                           | 本人報告の状態を読む。解消はTripを更新する。旧文書は候補を最大13件読んで状態を復元する                                               |
| `POST /api/trips/{tripId}/revisions`                                                  | 親Trip・候補・保存枠の確認と2書き込み。保存枠カウンターがない場合は最大12件を追加で確認                                              |
| `GET /api/learnings`、`GET /api/learnings/{learningId}`                               | 一覧は最大41文書、個別は1文書を読む                                                                                                  |
| `POST /api/learnings/{learningId}/approve`                                            | Learning・元Tripを確認。初回は保存枠の確認と2書き込み。保存枠カウンターがない場合は最大40件を追加で確認。再承認はLearningを1書き込み |
| `DELETE /api/learnings/{learningId}`                                                  | 現在のLearningを読み、撤回マーカーで置き換える。HTTPはDELETEだがFirestoreでは書き込み                                                |

`GET /api/auth/session` はFirestoreや上記の有料アダプターを呼ばない。認証疎通用だが、Firebase Authの失効確認やApp Hostingへの大量アクセスは別途監視する。UIDごとのTrip・Revision・Learning保存枠は蓄積量を制御する。同じ文書を繰り返し読む・更新する場合や、UIDを増やした場合の全体利用量には別の制御が必要。

## 招待配布と公開デモ

1. 招待対象者は使うブラウザでFirebaseの匿名セッションを一度だけ明示的に開始する。管理者はトークンの共有を求めず、認証済みセッションの `GET /api/auth/session` が返すUIDを、対象者と対応づけて非公開の経路で確認する。
2. 対象者のUIDをサーバー専用の `COSTLY_API_INVITED_UIDS` にJSON配列で設定する。空配列では全員が拒否される。実UIDはSecret Manager等で管理する。資格判定にはFirebaseが検証した `Actor.uid` を使う。ブラウザを変えるなどで匿名セッションを失った場合は再登録が必要。複数リビジョンで同じ招待設定を使い、除外時は古いリビジョンへのトラフィックを止める。緊急時は対象セッションを失効させる。
3. 未登録の審査員や一般利用者には `/demo` の模擬データを案内する。模擬データの画面は有料APIや保存APIを使わず、模擬結果と明示する。招待対象者のUID登録や実環境の確認が間に合わない場合は、公開環境の課金・保存フラグを無効にしたまま提出する。

## クライアント契約

課金・保存の同一オリジン要求は `getProtectedApiHeaders()`（`src/lib/auth/protected-api.ts`）から
`Authorization: Bearer <Firebase ID token>` と `X-Firebase-AppCheck` を取得する。WebのプロバイダはreCAPTCHA Enterprise。
ヘッダー取得に失敗したら送信せず、匿名アカウントを自動作成しない。認証疎通用 `/api/auth/session` は従来の `getAuthHeaders()` を使う。
通常のApp Checkトークンは期限まで再利用できる。毎回の消費によるリプレイ防止やFirebase Authenticationへの強制はMVP対象外。
利用者の操作時にトークンを取得し、バックグラウンドの自動更新は行わない。

### 画面側クライアントの接続（UI統合）

保護ヘッダーは `getProtectedApiHeaders()` と、取得時のセッションに結び付けた `getProtectedApiHeadersForScope(scope)`（UIDがスコープと違えば `SessionChangedError` でトークンを送らない）の2つ。どちらも、サイトキー未設定・reCAPTCHA/トークン取得失敗では `AppCheckUnavailableError`（SDKの原文は含めない）で失敗し、要求を送信しない（fail-closed）。

| クライアント                                                                                               | 切替後の取得関数                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/api/trips/generate`（`trip-planner/api-client.ts`）                                                      | `getProtectedApiHeaders`（`getHeaders` で差し替え可）                              |
| `/api/trips/verify`（`trip-verification/protected-verify.ts`。HomePlannerと `useTripVerification` の既定） | `createBrowserVerifier({ getHeaders: getProtectedApiHeaders, requireAuth: true })` |
| `/api/trips/revise`（`revision-review/api-client.ts`）                                                     | `getProtectedApiHeaders`（第3引数 `getHeaders` で差し替え可）                      |
| `/api/learnings/candidates`（`learning-review/api-client.ts`）                                             | `getProtectedApiHeaders`                                                           |
| `GET /api/learnings`（`learning-reuse/api-client.ts`）                                                     | `getProtectedApiHeadersForScope(scope)`                                            |

画面の失敗表示は、App Checkを用意できない（設定不足・reCAPTCHA失敗）、認証情報を用意できない、401・403（認証・招待・アプリ検証。本文は見ず固定の文言）、429（利用制限）、503（停止）を区別する。サーバーの本文は表示しない。失敗しても入力と旅程は保持し、自動の再送はしない（再試行は利用者の操作のみ）。

未対応：#52のreflection-flowは未マージのため接続していない（マージ後に同じ関数を使う）。適用（apply）と学びの保存を呼ぶHTTPクライアントはこの時点で画面側に存在せず、接続時に同じ関数（保存は `getProtectedApiHeadersForScope`）を使う。実際のreCAPTCHA Enterprise・App Check・実Firebaseとの疎通は未検証（テストは `firebase/app-check` をモックしている）。 [Webの設定](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider) · [独自APIのトークン検証](https://firebase.google.com/docs/app-check/custom-resource-backend)

| HTTP | 意味と再試行                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401  | 本人認証失敗。既存セッションで期限切れと確定した場合だけ、明示的な再試行前に一度トークンを更新できる                                                                                               |
| 403  | `invite_required` または `app_check_invalid`。招待・対象アプリ・トークンを確認し、匿名UIDの作り直しや自動再送を行わない                                                                            |
| 429  | `uid_limit` または `global_limit`。分単位・期間累計・同時実行のいずれかが上限。POSTの自動再送は行わない                                                                                            |
| 503  | 機能停止、`auth_unavailable`、`app_check_unavailable`、`protection_unavailable`。失敗した要求を連続再送しない。`write_result_unknown` や通信断で保存結果が不明なら、再送前に版・IDで結果を確認する |

## 共有利用枠

### 設定と初期値

各機能フラグは既定無効。本番は個別フラグに加え `COSTLY_API_DEMO_ENABLED=true` が必要。
開発・テストも、有効なフラグだけでは課金・保存を呼べない。認証、招待UID、App Check、制御文書が必要。
App Checkの署名検証は統合テストでモックにする。Auth Emulatorのトークンを本番の本人認証として使わない。

全リビジョンが同じFirebaseプロジェクト、既定Firestore DB、固定パス `apiAbuseControl/gate` を使う。
管理者が初回だけ次の形で文書を作成する。日付は例で、運用前にデモ期間をUTCのISO文字列で指定する。
`policy` はAdmin権限で調整でき、`counts`・`reserved`・`leases` は実行中に上書きしない。
この初期値は招待制MVPの上限で、期間合計は再起動・再デプロイ・日付変更でリセットしない。
文書未作成・破損・停止・期間外では503。次の期間への切替は[運用手順](#デモ期間の切替)に従う。

```json
{
  "policy": {
    "enabled": false,
    "startsAt": "2026-11-10T09:00:00Z",
    "endsAt": "2026-11-14T15:00:00Z",
    "paid": {
      "uid": { "perMinute": 4, "perPeriod": 12, "concurrent": 1 },
      "global": { "perMinute": 10, "perPeriod": 80, "concurrent": 2 }
    },
    "storage": {
      "uid": { "perMinute": 12, "perPeriod": 50, "concurrent": 2 },
      "global": { "perMinute": 30, "perPeriod": 500, "concurrent": 4 }
    },
    "budget": { "gemini": 40, "places": 100, "routes": 160, "reads": 10000, "writes": 1000 }
  },
  "counts": {
    "paid": { "minute": [], "total": 0 },
    "storage": { "minute": [], "total": 0 }
  },
  "reserved": { "gemini": 0, "places": 0, "routes": 0, "reads": 0, "writes": 0 },
  "leases": []
}
```

### 判定と回復

- フラグ、Bearer検証、招待UID、App Checkの順で確認する。課金Handlerはローカル入力検証後、保存Routeは業務コールバック前に予約する。保存の不正本文は業務DBを呼ばず拒否するが、先に確定した予約は消費済み扱い。
- 直近60秒、期間累計、同時実行、サービス別の予約量を確認し、全体・UID文書の読み取り版を条件に単一のFirestoreトランザクションで書く。条件不一致なら両文書とも更新されない。競合だけ最大2試行、予約・解放の待ちは各2秒。コミット結果不明やストア障害で業務処理を始めない。予約応答が途切れても書き込み済みの枠を戻さない。
- ルートで最悪量を予約し、Gemini・Mapsのアダプターへ操作内の残枠と中断シグナルを渡す。1回のHTTP操作と有料送信の回数は別々に計上する。保存の予約量は一覧の最大取得件数と保存枠初回の追加読取を含める。業務トランザクションのコールバックは `maxAttempts: 1`。業務書き込みの予約量は、読み書き見積もりの従来の5倍を余裕として維持する。
- リースはFirestore読み取り時刻を基準に最大180秒。処理の締切は課金150秒、保存15秒を上限とし、期間末尾では短縮する。通常終了や送信を開始していない例外では自身のリースIDだけを解放する。結果が不明な例外、タイムアウト、プロセス停止、解放失敗ではリースを残し、次の予約判定で期限切れを除外する。TTLの物理削除に依存しない。書き込みを開始した要求のタイムアウトでは、同時枠を維持したまま、書き込み権だけを先に失効させる。
- 許可の目安は予約で2読取・2書込、解放で1読取・1書込。全体枠で拒否できる場合はUID文書を読まない。拒否判定の全体文書読取や競合の追加読取にも課金され得る。招待とApp Checkを通過したトラフィックの費用上限は未検証。一般公開では上流の流入制御や、Firestore読取を伴わない分散ストアを再評価する。 [Firestore料金](https://firebase.google.com/docs/firestore/pricing) · [Firestoreの競合](https://firebase.google.com/docs/firestore/transaction-data-contention)

### 業務書き込みのfencing

Trip作成・PATCH、Revision候補保存、Learning承認・撤回に加え、Revision適用の確定、本人報告の解消、部分修正の生成前に行う本人報告の記録（保存有効時）の8操作は、共通の `operation.write` を必須とする。
業務書き込みをステージした後、制御文書を読み、同じ期間・UID・リースIDに有効な保存枠があることを確認する。
同じコミットに制御文書の `lastUpdateTime` を条件とする更新を含める。
リースの書き込み権失効、回収、停止、期間切替が先に永続化されれば、古い業務書き込みもまとめて拒否される。
制御文書の他の更新でも版競合が起き得るため、競合の頻度は実環境で測る。

7つのGET（本人報告の取得を含む）は業務データを書き込まない。認証・利用枠と期限の確認を維持し、親Tripの読取後にRevisionを取得する2操作は、次の照会前にも期限を確認する。
タイムアウトはクライアントへの応答を打ち切る。コミットが先に到達した場合や、失効の永続化より先に進行中のコミットが確定した場合は保存が成立し得る。
Firestore Admin SDKのコミット条件でサーバーの現在時刻を `until` と比較できないため、制御文書に変化がなければ、最終期限確認からコミットまでの実時間の隙間が残る。
コミット段階の失敗は `write_result_unknown` とし、業務コールバックを再試行しない。再送前に版・IDで取得し直す。
同じ期待版のPATCH・Learning承認、同じIDのTrip作成・Revision保存、撤回マーカーが再送時の重複変更を防ぐ。
[Firestoreのコミット時の分離](https://firebase.google.com/docs/firestore/transaction-data-contention) · [コミットAPI](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit)

### RPCの再試行と費用

`maxAttempts` が制御するのはトランザクションのコールバック。ロック済みFirestore SDK 9.4.0の低レベル設定では、
`BatchGetDocuments` と `RunQuery` に `DEADLINE_EXCEEDED`・`INTERNAL`・`UNAVAILABLE`、
`Commit` に `RESOURCE_EXHAUSTED`・`UNAVAILABLE` の再試行が設定されている。
HTTPの期限でも送信済みRPCや内部再送が取り消されたとは判断できない。
予約時の読取・更新、fenceの追加読取と条件付き更新、失効・解放の更新、インデックス読取も別に発生する。
**5倍予約を含め、実請求額の上限は実証していない。** 利用可能なクォータを確認し、Firestore Usage・Cloud Monitoringで読取・書込・拒否と障害を測り、BillingのSKU別費用と突き合わせる。発行できる予算通知や停止手順も併用する。
予約失敗の診断は制御文書未作成・不正、期間不整合、締切、競合、結果不明、ストア障害等の固定分類を、1プロセスにつき同じ分類は毎分1回まで記録する。UID・トークン・SDKの生エラーは記録しない。
[Firestoreの課金](https://firebase.google.com/docs/firestore/pricing) · [Firestoreの監視](https://firebase.google.com/docs/firestore/monitor-usage)

### デモ期間の切替

1. `apiAbuseControl/gate` の `policy.enabled` を `false` にし、個別5フラグと本番共通フラグを無効にする。全入口・全稼働リビジョンで新規予約が止まったことを確認する。期間だけを編集して稼働中に枠を初期化しない。
2. 旧リースの `until` とアプリ・Firestoreの実行状況を確認し、進行中の業務と外部要求を収束させる。停止中は期限切れリースが物理的に残り得る。リース期限だけで送信済みのコミットの終了を断定せず、結果不明の書き込みは業務文書の版・IDで照合する。
3. 旧期間の設定・累計・予約量を記録する。Admin権限で **`gate/uids` の旧UID文書だけ**を削除し、同じ `apiAbuseControl/gate` を新しい `startsAt`／`endsAt`、零の `counts`・`reserved`、空の `leases`、`policy.enabled: false` で更新する。Firestoreで親文書を置き換えてもUIDサブコレクションは残る。途中で失敗した場合は閉じたまま両方を確認する。
4. 設定文書とUID文書の初期化、招待対象、フラグの配布先を確認する。承認された環境で新期間の `policy.enabled` と対象フラグを有効化し、同じ招待UIDが新しい期間の枠を取得できることを確認する。

## 並行開発との統合

- **#9・#46のRevision適用**（統合済み）。適用は `withDataActor(request, COSTS.applyRevision, ...)` で、最初の業務読取前に **業務Firestore読取14・書込10・Places 4・Routes 4** をまとめて予約する（有料と保存の枠を同時に取る）。読取は初回のTrip・Revision各1、従来の5試行を見込んだ確定前の再読取10、コミット結果照会2。書込はTrip・Revision各1の5倍の保守枠。Mapsは `meteredMaps(operation, maps)` 経由で取引外、確定は `operation.write` 経由で版を再照合し、結果不明のときの照会も同じ操作の読取枠内で一度だけ行う。業務の取引は再試行しないため実際は14／10に収まるが、暫定の保守枠として維持し、制御文書の費用は別計上する。適用の機能フラグ `TRIP_REVISION_APPLY_ENABLED` は認証・予約より前に判定する（停止中の要求が枠を消費しない）。部分修正の生成は、保存有効時だけ本人報告の記録（読取14・書込1の5倍、`operation.write`）を同じ操作の予約に加える。保存の候補保存は、旧文書の本人報告の復元分を加えた読取28・書込3の5倍。[予約量の一覧](PARTIAL_REVISION.md#29の予約量)
- **#53・#54のLearning選択付き生成**。本人の保存済み一覧は最大40件＋打切り判定1件なので、選択がある場合は **業務Firestore読取最大41・Gemini 1** を業務読取前に一括予約する。検証済み `Actor.uid` と選択 `{ id, version }` を使い、現行版・承認状態・地域を再照合してから `meteredGemini(operation, client)` に渡す。認証ヘッダーを持たない内部 `Request` でHTTP Handlerを呼び直す経路は、同じActorと操作を受ける業務処理へ接続し直す。空選択では業務読取を省略できる。本文の `learnings` を信用する旧経路は閉じた（HTTP契約は `learningSelections` のみ。旧形式は400）。選択がある生成は `COSTS.generateWithLearnings`（Gemini 1・読取 `LEARNING_LIMIT + 1`）、空選択は `COSTS.generate`。 [#53](https://github.com/cludewn/groundtrip/pull/53) · [#54](https://github.com/cludewn/groundtrip/pull/54)
- **#50・#52・#55を含むUI統合**。本人のBearerとApp Check、401・403・429・503の表示、セッション変更を接続する（生成・照合・修正候補・学び候補・学び一覧は接続済み。#52のreflection-flowは未接続）。結果不明の書き込みは既存版・IDの読取から確認する。適用やLearning承認のボタンからの自動再送を避ける。

## Consoleの手動操作と緊急停止

設定担当者が対象プロジェクトとApp Hostingバックエンドを確認し、次を実施する。閾値や権限を変更する前に、対象サービス、承認者、停止担当者を決める。

App Hostingの初期案は `runConfig.maxInstances: 2`、`runConfig.concurrency: 8`。サーバー側の個別5フラグと共通デモフラグは `apphosting.yaml` の `env` で `availability: [RUNTIME]` を指定する。WebサイトキーとFirebaseの公開設定はビルドにも渡す。環境別の設定やConsole側の上書きがある場合は、対象バックエンドで有効になった値をロールアウトごとに確認する。秘密はSecret Managerに置く。今回の変更ではApp Hosting設定を追加・変更していない。 [App Hostingの環境変数](https://firebase.google.com/docs/app-hosting/configure)

1. **予算と通知**。Google Cloud Consoleの **Billing → Budgets & alerts → Create budget** で対象プロジェクトの予算を作成し、合意した実績・予測の閾値と受信者を登録する。BillingのSKU別レポートでVertex AI・Maps・Firestore・App Hostingを確認し、通知の受信者と対応手順を検証する。予算アラートは集計に遅延があり、支出を自動で停止する上限ではない。 [Cloud Billingの予算アラート](https://docs.cloud.google.com/billing/docs/how-to/budgets)
2. **Gemini**。Google Cloud Consoleの **IAM & Admin → Quotas & System Limits** または **APIs & Services → Vertex AI API → Quotas & System Limits** で、実際の `GOOGLE_CLOUD_PROJECT`・モデル・ロケーション・利用方式を確認する。編集可能な該当クォータだけ合意値へ下げる。標準PayGoのDynamic Shared Quotaのように固定上限がない利用方式では、アプリの呼び出し・トークン枠で抑え、プロバイダー側の429は費用上限として扱わない。このコードはAI StudioのAPIキー経路を使用していない。 [Vertex AIのクォータ](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/quotas) · [Dynamic Shared Quota](https://cloud.google.com/blog/products/ai-machine-learning/your-ultimate-guide-to-the-latest-in-generative-ai-on-vertex-ai)
3. **Places・Routes**。**Google Maps Platform → Quotas** で **Places API (New)** のText Searchと **Routes API** のCompute Routesを選び、編集可能な指標を合意値に設定する。適用された値・対象メソッドを確認し、クォータ接近、SKU別呼び出し数と費用を監視する。クォータが共有される他のアプリも確認する。 [Places](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing) · [Routes](https://developers.google.com/maps/documentation/routes/usage-and-billing)
4. **Firestore・IAM**。Firebase Consoleの **Firestore Database → Usage / Rules** でDBとリージョンを確認し、リポジトリと同じ全拒否Rulesを公開する。Cloud Monitoringに文書の読み取り・書き込み・削除、エラー、制限ストアの競合／拒否を監視する設定を用意し、Billingと突き合わせる。App Hostingの実行サービスアカウントのADC、失効照会に必要な `firebaseauth.users.get`、対象DBの最小権限、GeminiとMapsの利用プロジェクトを確認する。本番にEmulatorホスト・デバッグトークン・サービスアカウント鍵を入れない。 [Firestore利用量の監視](https://firebase.google.com/docs/firestore/monitor-usage) · [プロジェクトとIAMの設定](AUTHENTICATION.md#firebase--google-cloud-consoleで人間が行う設定)
5. **App Check**。Firebase Consoleの **App Check** に対象Webアプリを登録し、reCAPTCHA Enterpriseの対象ドメイン、評価費用、ステージングでの通過率を確認する。独自APIはサーバー側の検証を必須化する。Authenticationの強制は利用条件と影響範囲を確認して別に切り替える。 [App Checkの強制](https://firebase.google.com/docs/app-check/enable-enforcement)
6. **Spend Cap**。Cloud Billingの **Budgets & alerts → Create budget → Spend cap enforcement** で、適用資格のある請求先なら `GOOGLE_CLOUD_PROJECT` 1件と **Gemini Enterprise Agent Platform（旧Vertex AI、`aiplatform.googleapis.com`、サービスID `C7E2-9256-1C43`）** だけを選択できる。このコードが使うGeminiはこのサービス。別のGemini API（`generativelanguage.googleapis.com`）やCloud Runも対象サービスだが、Maps（Places／Routes）とFirestoreは対象外。Spend Capは月単位、クレジット控除前の推計費用で判定し、反映遅延と進行中リクエストの超過分は請求され得る。通常の予算通知・アプリの共有枠・停止手順と併用する。対象請求先での機能可否・設定・疎通は未確認。 [Cloud Billing Spend Cap](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)

**緊急停止**

1. 影響を受ける `TRIP_GENERATION_ENABLED`・`TRIP_VERIFICATION_ENABLED`・`TRIP_REVISION_ENABLED`・`LEARNING_CANDIDATES_ENABLED`・`PERSISTENCE_ENABLED` をApp Hostingのサーバー実行環境で `false` にした設定をロールアウトする。新規予約を即時停止する場合は、管理者が `apiAbuseControl/gate` の `policy.enabled` だけを `false` にする。カウンターと既存リースは保持する。すぐに適用する必要があれば、Firebase Consoleの **App Hosting → 対象バックエンド → Rollouts → History** から、対象のフラグが無効だと確認済みのビルドに戻す。ロールバックは過去の環境設定も復元するので、単に直前のビルドを選ばない。停止を上書きし得る自動ロールアウトも確認する。 [実行環境の設定](https://firebase.google.com/docs/app-hosting/configure) · [ロールバック手順](https://firebase.google.com/docs/app-hosting/rollouts)
2. ルートが503を返すこと、既存リビジョンや別の入口にトラフィックが残っていないこと、サービス側の利用増加が収束することを確認する。進行中や送信済みの処理には課金が残り得る。停止を待てない場合は、管理者が依存範囲を確認して **APIs & Services → Enabled APIs & services** で該当するVertex AI・Places・Routes APIを停止する。Firestoreではまずアプリ側の停止を確認し、それでもAdmin経路が止まらない場合は専用実行IDのDB権限をIAMで一時的に外す。Rules変更だけではAdmin経路を止められない。
3. 調査後、原因と消費量を確認し、再公開条件を再検証してからフラグを戻す。停止の過程で旅程やLearningのデータを削除する必要はない。

## 初回公開の判定

提出に使うデプロイはチームで定めた凍結前に判断する。間に合わない場合はフラグを無効のままにし、課金・保存を使わずに確認できる模擬データのデモを選ぶ。緊急停止の手順と提出凍結中に許される対応は、公開判断前に担当者間で確認する。 [Issue #29の提出運用](https://github.com/cludewn/groundtrip/issues/29#issuecomment-6707496283)

- [x] 招待UID、App Check、分散利用制限をサーバーに実装し、本番共通フラグは既定無効にした。
- [ ] 招待対象者の配布、クライアントのApp Check接続、Web実ブラウザでの有効・無効トークンを確認した。
- [ ] 認証成功かつ上限内のときだけ許可し、UID別・全体超過とストア障害・不明な予約結果で有料処理と業務DB操作が0回になる。独立プロセス・複数UID・同時要求・並列ファンアウト・タイムアウト・プロセス停止からの復旧を確認した。
- [ ] 認証・App Check・利用制限・SDK障害時の応答と運用ログにトークン、個人情報、APIキー、外部SDKの生エラーが出ない。UIで拒否と再試行を検証した。
- [ ] Firestoreの全拒否Rules、対象DBとADC/IAM、Geminiモデル／Mapsクォータ、予算・監視・停止手順を実環境または承認済みのステージングで検証した。
- [ ] #9・#46・#53・#54との統合後の全入口を再棚卸しし、同じ費用・同時枠に接続した。
- [ ] 担当者がフラグ無効のビルドを用意し、対象サービスだけを段階的に `true` にした設定をロールアウトして、拒否動作・利用量・費用を監視できる。

`pnpm test` は既存の課金4ルートと保存14操作（部分修正の生成・適用・本人報告を含む）を対象に、認証失敗・本番停止が下流処理より先に効くことを確認する。
`pnpm test:emulators` では実Admin SDKとAuth Emulatorを使い、課金4ルートの有効・期限切れ・失効トークンの扱いを確認する。
Gemini・Places・Routesはモックに差し替える。Emulatorは署名なしトークンを使うため、本番の署名検証は別途確認する。

共有枠はAuth／Firestore Emulatorで、独立したクライアント、UID・全体の上限、競合、ストア障害と不明な予約結果、期限回復、二重・古い解放、旧PATCH再開、コミット応答喪失後の再送、同一UIDの期間切替を確認する。実FirebaseでのApp Check署名検証、App Hostingの複数実インスタンス、監視とConsole操作は別の公開前検証とする。
