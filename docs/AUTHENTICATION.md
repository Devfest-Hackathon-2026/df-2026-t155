# 認証・認可基盤（Issue #10 / PR 1相当）

## 範囲と保証

MVPの実装方針はFirebase Authentication匿名認証。正式なチーム合意は別途Issue #10へ記録する。
今回の実装は認証SDK、認証状態の復元、トークン検証、所有者照合ヘルパー、全拒否Rules、
認証疎通用APIとローカルテストまで。既存画面への接続は#16、生成APIへの接続は#6と調整する。
共有ドメイン契約と画面は変更しない。

- ブラウザはFirebase Auth SDKで本人の認証状態を維持する。Firestoreには直接接続しない。
- APIはBearer IDトークンをAdmin SDKの`verifyIdToken(token, true)`で検証し、失効・無効化も確認する。
- サーバーの`Actor.uid`は検証結果だけから生成する。本文・クエリ・LLMのUIDは信用しない。
- `requireOwner`はサーバーが取得した保存済み所有者と照合する。本文のownerUidを渡してはいけない。
- Rulesは本人を含む全クライアントの直接参照・一覧・作成・変更・削除を拒否する。
- Admin SDKはRulesを迂回する。今後の保存サービスでもUIDから保存先を決定し、
  関連Trip等の所有者を検証する必要がある。データ保存・その認可の実装はまだない。
- SDK依存は`src/lib/firebase/`と`src/lib/auth/`へ限定。ドメインへFirebase型を持ち込まない。
- サーバー専用モジュールは`server-only`で保護。Node.js runtimeで利用する。
- トークン・SDKエラーの原文・環境変数の値はログやHTTPエラーへ出さない。

### サーバーの障害診断ログ

`authErrorResponse`が503（`auth_unavailable`）を返す際は、設定・権限・認証情報・通信・
SDK内部・未知の分類と、許可リストにある固定コードだけをサーバーへ記録する。
未知の`error.code`は`unknown`へ正規化し、UID、トークン、SDKのmessageやstack、環境変数の値を
ログへ渡さない。HTTPレスポンスのコード・文言は従来どおりで、診断情報を追加しない。
未認証・不正/期限切れ/失効トークン等の401、所有者不一致の404は記録しない。

503の同じ診断コードは**1プロセスにつき60秒に1件まで**記録する。未知のコードも同じ1枠を使う。
これはログ量の抑制であり、要求件数の正確な集計や分散レート制限ではない。
インスタンス増加・再起動時にはログ枠も増えるため、本番のログ保持・監視とAPI利用制限は別途必要。

匿名認証は一人一アカウントや身元の保証ではない。認証状態を失うと保存データへ戻れない可能性がある。
将来のGoogle認証は既存ユーザーへのリンクを使い、UIDを維持する。メールを所有権キーにしない。
別アカウントにリンク済みの場合の統合・復旧は今回未実装。

## ローカル導入・実行

前提：Node.js **24.15以上の24系**、package.json指定のpnpm、**Java 21以上**。
ロック済み依存の`package.json`を確認した結果、下限は次の条件に合わせている。

- `re2@1.27.0`とそのビルド用`node-gyp@13.1.0`はNode.js `^24.15.0`（24系の場合）を要求する。
- `@firebase/rules-unit-testing@6.0.0`とFirebase SDK内の`@firebase/ai@3.0.0`も`>=24.12.0`を要求する。
- Node.js 24.10で一部の動作が成功しても、依存パッケージの対応範囲を満たす根拠にはならない。
  このため`engines.node`の`>=24.15.0 <25`を維持する。

JavaはOSのパッケージ管理または[Adoptium](https://adoptium.net/)等で導入し、
`java -version`で確認する。別のJDKを使う場合はJAVA_HOMEとPATHを設定する。

```sh
pnpm install --frozen-lockfile
pnpm emulators
```

初回はFirebase CLIがEmulatorバイナリをダウンロードする。Firebaseログイン・ADC取得・本番設定変更は不要。
CLIの対象はスクリプト内の架空プロジェクト`demo-groundtrip`に固定している。
Authは127.0.0.1:9099、Firestoreは127.0.0.1:8080。外部公開しない。
pnpmの依存スクリプト許可は`pnpm-workspace.yaml`へ記録し、無差別な許可をしない。

`re2: true`は`firebase-tools@15.35.0 → superstatic@10.0.0 → re2@1.27.0`という
開発用CLIの間接依存に限る既存の許可。re2のinstallはネイティブバイナリの取得を試み、
利用できない場合はnode-gypによるコンパイルを行う。アプリの認証処理からre2を直接使わない。
Auth/Firestore Emulatorそのものの必須依存ではなく、superstaticのoptional依存である。
未ビルドではsuperstaticがJavaScriptのRegExpへフォールバックするため、許可を削除すると
CLIのHosting用正規表現の実装も変わる。今回は既存CLIの挙動とRE2の利用を維持し、許可を残す。
新たなビルドスクリプトは許可しない。CLI更新時には依存経路・取得先・ビルド内容を再確認する。

Vitestは`src/**/*.test.{ts,tsx}`を対象とする。#18の統合時は設定を`vitest.config.ts`へ一本化し、
#18の`oxc.jsx.runtime: 'automatic'`と`@`エイリアスに加えて、#19の`server-only`エイリアスも保持する。
今回は#18の画面・依存パッケージ・JSX設定を取り込まない。

別ターミナルで`.env.example`を`.env.local`へコピーして`pnpm dev`を起動する。
サンプルは架空の値だけを含み、ローカルEmulator専用。本番の値は混ぜない。
`next build`/`next start`はproduction扱いなのでEmulator設定では認証できない。

## 環境変数

| 名前                               | ローカル                        | 本番                             |
| ---------------------------------- | ------------------------------- | -------------------------------- |
| NEXT_PUBLIC_FIREBASE_PROJECT_ID    | demo-groundtrip                 | 現行Firebase Project ID          |
| NEXT_PUBLIC_FIREBASE_API_KEY       | demo-api-key                    | 現行WebアプリのFirebase用APIキー |
| NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN   | demo-groundtrip.firebaseapp.com | 現行Webアプリ設定の値            |
| NEXT_PUBLIC_FIREBASE_APP_ID        | demo-app-id                     | 現行Webアプリ設定の値            |
| NEXT_PUBLIC_FIREBASE_USE_EMULATORS | true                            | falseまたは未設定                |
| FIREBASE_PROJECT_ID                | demo-groundtrip                 | クライアントと同じProject ID     |
| FIREBASE_USE_EMULATORS             | true                            | falseまたは未設定                |
| FIREBASE_AUTH_EMULATOR_HOST        | 127.0.0.1:9099                  | **変数自体を削除**               |
| FIRESTORE_EMULATOR_HOST            | 127.0.0.1:8080                  | **変数自体を削除**               |

NEXT_PUBLICの値はブラウザへ渡る。Firebase Web設定に有料API用キーや秘密鍵を入れない。
Web設定はビルド時にも必要。変更後は再ビルドする。サーバー設定は実行時に必要。
不足・不一致は認証時に安全に失敗する。ビルド時に認証やDB接続は行わない。

本番ではApp Hostingの実行サービスアカウントによるADCを使う。
サービスアカウントJSONキーは配置せず、GOOGLE_APPLICATION_CREDENTIALSも設定しない。
旧プロジェクトの権限・キー・疎通結果は流用できると仮定しない。

Emulatorは明示フラグ、demo- Project ID、固定ローカルHOSTの両方を要求する。
本番でのEmulator有効化、フラグなしのHOST混入、片方だけのEmulator接続は拒否する。
Auth Emulatorが署名なしトークンを発行するため、この分離はセキュリティ境界である。

## #16：ブラウザからの利用

`initializeAnonymousSession()`は**既存セッションの復元専用**。SDKの復元完了を待ち、
`reload()`による現在のユーザーの検証後に同じUIDを返す。SDKが無効化・削除済みユーザーを
復元時にクリアしても、新しい匿名アカウントを自動作成しない。
SDKの復元時に通信失敗が吸収されcurrentUserが残った場合も、検証のPromise失敗を成功扱いにしない。

利用可能なセッションがなければ、初回も含めて`session_ended`を返す。
これは「以前のセッションがあった」という判定ではなく、明示的な開始が必要な状態を表す。
**初回利用と保存状態を完全に失った再訪を推測で区別しない**。

新規作成は`startNewAnonymousSession()`へ分離した。「新しい利用を始める」という利用者の
操作からだけ呼び、初期化失敗のcatch、画面表示、購読イベント、通信の自動再試行から呼ばない。
以前の匿名UIDや保存データを復旧できない場合があることを開始操作の前に説明する。
このUI接続は#16の担当であり、今回画面は変更しない。
正常な既存の匿名・Google等のユーザーがいれば、新規開始関数もそのユーザーを保持する。
同じタブでの新規開始は一つのPromiseにまとめ、二重クリックで複数作成しない。
復元・検証の失敗を捕まえてそのまま作成へ進む処理はない。

SDK標準のブラウザ永続化を利用する。認証情報・トークン・UIDを独自の永続領域へ複製しない。

```ts
import { getAuthHeaders, initializeAnonymousSession } from '@/lib/auth/client'

// 再訪時の復元。session_endedでは新規開始の説明と操作を提示し、自動作成しない。
await initializeAnonymousSession()
const response = await fetch('/api/auth/session', {
  headers: await getAuthHeaders(),
  cache: 'no-store',
})
```

```ts
import { startNewAnonymousSession } from '@/lib/auth/client'

// 「新しい利用を始める」等の明示的な操作のハンドラー内だけで呼ぶ。
await startNewAnonymousSession()
```

`observeAuthState(listener)`はrestoring / session_ended / authenticated / errorを通知し、購読解除関数を返す。
ユーザー変更通知を受けたら検証を待ってからauthenticatedを通知する。購読だけでは新規作成しない。
`onIdTokenChanged`のerrorコールバックは公式仕様上呼ばれないため、渡さない。
エラーは初期化・サインイン・reload・トークン取得等のPromiseから捕捉する。
公開関数のPromise失敗は、開始時のセッションが現在も有効な場合だけ購読へ通知する。
古いセッションの失敗や、SDK初期化前で所属セッションが確定できない失敗は呼び出し元へだけ返す。
呼び出し側でもPromiseをcatchして扱う。
期限切れだけでSDKの購読イベントが自動発火する保証はない。
サインアウト・ユーザー変更・通信失敗・購読解除の後に、古い非同期検証が成功状態を上書きしない。

非同期処理はAuthインスタンス・SDKのUser参照・セッション世代に結び付ける。
UIDが同じでも、観測されたサインアウトやUserの置換を挟むと別世代になる。
SDK復元待ち・トークン取得・reloadの前後で同一性を確認し、古い成功結果も呼び出し元へ返さない。
初期化・新規開始・検証の進行中Promiseと検証済み状態もセッション単位で保持し、
古い処理のcatch/finallyが新セッションの状態や進行中処理を消さないようにする。
起動直後のSDK復元と明示的な作成による一回の遷移だけは、確認後にそのセッションへ引き継ぐ。
この世代情報はメモリ上だけの状態管理であり、永続マーカーやサーバー認可の根拠ではない。

復元中・通信失敗・session_endedでは保存ボタンを利用可能にしない。UID変更時には前ユーザーの画面データを消去し、
進行中リクエストの結果が別ユーザーの画面に反映されないよう#16側で管理する。
共用端末・別ドメイン・プライベートモードでの保持・消失は実ブラウザ確認が必要。

`getIdToken()`はSDKの更新機能を利用し、`getIdToken(true)`は明示的な更新。
未認証・失効時に匿名ユーザーを作り直す処理や自動再送は含めない。
APIのtoken_expiredに限り一度更新して再試行するUIは後続で実装する。
session_revoked等を匿名再作成で回避しない。取得した認証ヘッダーを外部URLへ送らない。

### 作成方式の選択と制約

非機密の「利用済み」マーカーを保存して初回だけ自動作成する案を第一候補として検討した。
マーカーは認可の根拠にできず、SDK保存状態とマーカーの両方が消えた後や、
マーカー導入前の利用を完全には検出できない。初回自動作成を安全に維持するには、
ストレージの読み書き失敗・プロジェクトの区別・複数タブの作成排他への対処も必要になる。

今回は旅行を始める既存の利用者操作へ作成を接続できるため、**初回も明示操作から作成する方式**を選んだ。
初回の自動作成は行わないが、ログインフォームを増やす必要はない。
マーカーの有無に依存せず、SDK状態がなければ新規作成せず停止する。
マーカー・独自ストレージ・Web Locks等の追加基盤も導入しない。

- ローカルストレージ消去、保存領域へのアクセス失敗、プライベートモード等でSDK状態が失われても、
  初期化からアカウントを作り直さない。SDKのエラーは失敗として扱う。
- 過去の利用履歴・以前のUIDの有無や、SDKがメモリ永続化へフォールバックした事実を完全には検出できない。
  認証の永続保持・匿名UIDの復旧・別端末への引き継ぎは保証しない。
- プロジェクト変更で利用できるセッションがなければ停止する。新規開始は明示操作が必要で、データ移行ではない。
- 別タブからのSDK認証変更は購読で扱い、セッション消失を自動作成の契機にしない。
  複数タブで利用者が同時に明示的な新規開始を行う場合の排他は提供しない。
  その場合にSDKが同期したユーザー変更も#16で表示へ反映し、以前のUIDに固定された結果を表示しない。
- `reload()`成功はFirebase Authのユーザー検証であり、失効確認・業務データの認可の代替ではない。
  APIは引き続き毎回Admin SDKで検証する。App Check・利用制限も別途必要。

## #6等：APIでの利用

```ts
import { authErrorResponse, requireActor } from '@/lib/auth/server'

// Route Handler内の例。認証だけでは有料APIを公開できない。
try {
  const actor = await requireActor(request)
  // actor.uidから本人の保存先を決定する。リクエストのUIDは使わない。
} catch (error) {
  return authErrorResponse(error)
}
```

`GET /api/auth/session`はこの経路を使い、成功時に`{ uid }`のみ返す。
全応答をprivate, no-storeにし、共有キャッシュへ入れない。
これは認証疎通用であり、保存・プロフィール・承認・有料APIは提供しない。

| HTTP | error.code                      | 意味                                          |
| ---- | ------------------------------- | --------------------------------------------- |
| 401  | unauthenticated / invalid_token | 未認証・不正ヘッダー・無効トークン            |
| 401  | token_expired                   | 期限切れ                                      |
| 401  | session_revoked                 | 失効・無効化・削除済みユーザー                |
| 404  | not_found                       | 保存済み所有者との不一致。存在情報を隠す      |
| 503  | auth_unavailable                | 設定・IAM・ネットワーク等。認証を省略せず停止 |

認証済みActorはリクエスト単位で扱い、モジュールのグローバル変数へ保存しない。
他Issueの業務エラーを全てauthErrorResponseへ変換せず、認証境界の例外処理を分ける。

## 検証

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:emulators
```

`pnpm test`は単体テスト。Firebase SDKをモックした認証・初期化テストと既存ドメインテストを含む。
`pnpm test:emulators`は両Emulatorを起動し、実SDKで匿名認証→Admin検証→Route Handler応答、
無効化・削除済みユーザー拒否、A/Bの所有者照合、全拒否Rulesの各操作を確認する。
クライアント回帰テストでは、SDK自身の保存状態を残してApp・アプリモジュールを再初期化し、
正常時のUID維持、無効化・削除後の非作成、サインアウト後の停止、明示的な再開始を検証する。
再作成の有無はEmulator上のユーザー件数でも確認する。
Node版SDKのメモリ永続化を使っており、ブラウザのディスク永続化や実タブ間同期を確認したテストではない。
通信障害テストはテスト用Authインスタンスの接続先だけを到達不能なローカルアドレスへ差し替え、
SDK・reload・fetchはモックしない。購読通知の競合・解除等は単体SDKモックでも検証する。
競合回帰テストはPromiseの開始・成功・失敗を明示的なゲートで制御し、Aの完了をBの認証後へ遅延させる。
単体では復元待ち・サインイン応答・検証・トークン取得、同一UIDの別世代も確認する。
実SDK統合では実トークン取得後にUser.getIdTokenの返却Promiseだけを一時的に遅延させ、
トークン取得・既存ユーザーの初期化・新規開始の検証がBへ影響しないことを確認する。
これはSDK内部の通信自体やサインインのコミット順序を操作したテストではなく、
その厳密な完了制御はSDKモック側で確認する。進行中のSDK通信のキャンセル機能は追加しない。
データ投入はRulesテストのフィクスチャに限定する。Trip等の保存サービスは実装しない。
Vitestではserver-onlyを空マーカーへ置換するが、Next.jsビルドでは置換しない。

署名偽造・期限切れ・失効などのエラー分岐は単体モックでも検証する。
Auth Emulatorでは本物の署名検証を保証できない。実環境の署名・aud/iss・IAM・失効と、
ブラウザの永続化・モバイル動作・App Hosting実行時ADCは別途確認が必要。
Firestore Emulatorにも本番との制限・トランザクションの差がある。
CIに両Emulatorの専用ジョブを追加し、本番認証情報を渡さない。

## Firebase / Google Cloud Consoleで人間が行う設定

1. 現行プロジェクトのID・Webアプリ・App Hostingバックエンドが一致することを確認する。
2. 合意をIssue #10へ記録し、Authenticationの匿名認証を有効化する。不要なプロバイダーは有効化しない。
3. Webアプリ設定を環境変数へ設定する。公開・開発ドメインも確認する。
4. FirestoreのDB・リージョンを確認し、`firestore.rules`と同じ全拒否Rulesを明示的に公開する。
   App HostingへのコードデプロイだけでRulesも反映されたとは扱わない。
5. 実行サービスアカウントを確認する。トークン失効確認に必要な`firebaseauth.users.get`を含む
   最小権限を付ける。今回の認証APIにFirestore書き込み権限は不要。
   PR 2で必要になった時点で対象DBへのroles/datastore.user等を検討する。
   Owner / Editor / Firebase Auth Adminを便宜的に実行アカウントへ付与しない。
6. App Hostingへ上記のビルド・実行環境変数を設定し、Emulator用HOST変数とJSONキーを配置しない。
7. 本番相当の確認は別途明示的に承認された環境で行う。今回のテストは本番設定を変更しない。

## 公開前に必要なApp Check・利用制限

**App Check・利用者別/全体の利用制限は未実装。有料APIを安全に公開できる状態ではない。**
今回有料APIは追加していない。認証API自体の大量アクセス・匿名アカウント大量作成のリスクも残る。

既存の`POST /api/trips/generate`にも認証・App Check・利用制限はまだ接続していない。
`.env.example`の`TRIP_GENERATION_ENABLED=false`を維持し、公開前に次を引き継ぐ。

- #10：`requireActor`による検証済みUIDの境界を提供し、#6/#7/#9のAPIへの適用と認可を確認する。
- #6（Gemini）/#7（Places/Routes）：認証・App Checkの検証後、UID別と全体の共有利用枠を
  原子的に予約してから有料呼び出しを行う。未認証・不正App Check・枠超過・枠確認失敗では呼び出さない。
- #16：明示的な匿名利用開始、Bearer IDトークンとApp Checkトークンの送信を画面へ接続する。
- 公開判断前に、匿名UID再作成・並列要求・複数インスタンス・再試行でも全体上限を回避できないことと、
  Cloud側クォータ・停止手順の実効性を検証する。匿名認証やApp Checkだけを課金上限の代わりにしない。

導入境界はRoute Handlerの認証に続くサーバー保護処理とする。
ブラウザがX-Firebase-AppCheckを送り、Admin SDKでトークンと対象アプリを検証する。
ConsoleのFirestore保護だけでは独自Next.js APIは保護されない。
クライアントSDK初期化付近にApp Checkを追加し、#16の操作と#6/#7/#9のAPIへ接続する。
未設定・不正時の動作を確認してから公開し、監視だけで保護が完成したとは扱わない。

各有料アダプターは呼び出し前に共有ストアで利用枠を予約する。
UID別に加え、匿名UID再作成で回避できない全体上限、API別上限、トークン数・FieldMask・候補数・
再試行数・タイムアウトを制限し、上限確認に失敗した場合は呼び出さない。
プロセス内カウンターだけで複数インスタンスを制御しない。
Cloud側クォータ・予算通知・手動停止手順も準備する。予算通知だけを支出上限とみなさない。

## PR 2以降への引き継ぎ

- Trip / Revision / Learningを画面モデルのまま保存せず、Maps由来情報を分離した保存DTOを設計する。
- 未承認のRevisionをTripへ反映しない。#9が決定論的制約検証、#10が認可・原子的保存を担当する。
- Learningは**編集開始時に旧版を撤回しない**。編集中候補へ旧承認をコピーせず、再承認時に
  旧版から新版へ原子的に切り替える。却下・編集失敗時は旧版を保持する。
- 同時更新・古い版・二重承認・失敗時の元データ保持をFirestoreトランザクションで保証する。
- 保存サービスで本人の関連データの所有権を再確認し、クライアントの承認状態を信用しない。
- #6/#16へ共通認証処理を接続し、UID変更時の表示保護、401更新再試行、実ブラウザ動作を検証する。
- App Check、実効的な利用制限、現行プロジェクトの実疎通が済むまで有料APIを公開しない。

## 公式資料

- [匿名認証](https://firebase.google.com/docs/auth/web/anonymous-auth)
- [認証状態の永続化](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- [onIdTokenChangedの通知・エラー仕様](https://firebase.google.com/docs/reference/js/auth#onidtokenchanged)
- [IDトークン検証](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [失効確認](https://firebase.google.com/docs/auth/admin/manage-sessions)
- [Admin SDKとADC](https://firebase.google.com/docs/admin/setup)
- [App Hostingのサービスアカウント](https://firebase.google.com/docs/app-hosting/about-app-hosting)
- [Auth Emulator](https://firebase.google.com/docs/emulator-suite/connect_auth)
- [Firestore Emulatorと本番との差](https://firebase.google.com/docs/emulator-suite/connect_firestore)
- [サーバーSDKはRulesを迂回する](https://firebase.google.com/docs/firestore/security/rules-conditions)
- [独自APIのApp Check検証](https://firebase.google.com/docs/app-check/custom-resource-backend)
