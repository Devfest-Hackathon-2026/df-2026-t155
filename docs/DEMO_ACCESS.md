# 提出用アクセスURL（Issue #60）

少人数の審査に限り、既存のFirebase App HostingのURL `https://<既存のApp Hostingホスト>/access#ticket=<アクセス券>` を承認済みの非公開経路で渡す。通常画面が開いてから収録を始め、アクセスURLは動画・公開リポジトリ・ログへ載せない。フラグメントはアプリ起動時に履歴から消える。途中でエラーになった場合は、時間をおいて提出資料のURLを開き直す。

このURLを開くと、同じタブの通常画面がデモUIDで開く。既存の匿名認証は別のFirebase Authインスタンスに残る。デモの保存済み旅程・学び・UID別利用枠は全デモ利用者で共有する。個人情報や秘密を入力しない。ブラウザのタブ複製・セッション復元はブラウザのタブ内ストレージの扱いに従う。

## デモを終了する

1. デモ利用中に共通ヘッダーの「デモを終了する」を押す。このタブのデモ認証を終了し、「デモを終了しました」画面を開く。アクセス券の交換画面では終了ボタンは表示されない。
2. 終了画面の「通常の利用へ」を押す。既存の通常認証があれば復元し、利用できる認証がなければ「新しい利用を始める」から明示的に開始する。
3. 終了に失敗した場合は、時間をおいてヘッダーの「デモを終了する」を押し直す。終了操作を始めたタブでは古いセッションの操作を中断し、通常認証への切り替えを保留する。終了できない状態が続く場合は、そのタブを閉じ、複製や復元をせずに新しいタブで通常URLを開く。

デモへの新規アクセスと再認証には Web Locks API が使えるブラウザが必要。アプリはタブのストレージに保存したロックIDで、アクセス券の SDK サインインと終了を直列化する。SDK サインインがすでに始まっていれば、成否が確定してから最終のサインアウトを行う。終了側のロック取得待ちは15秒で打ち切り、未完了として再試行を案内する。ブラウザのタブ複製でロックIDも複製された場合、操作が一時的に競合することがある。

終了待ちの目印の書き込みをブラウザが拒否した場合も、元の目印とロックを確認できればサインアウトを試みる。サインアウトと目印の削除が両方完了してから終了画面を開く。デモ認証を使用した画面は離脱時に進行中の操作と認証スコープを無効化し、ブラウザの履歴から戻った場合は画面を再読み込みする。終了待ちの記録とサインアウトが両方失敗した場合、再読み込み後の新しい文書が保存済みのデモ認証を復元することがある。この場合は画面から終了を再試行するか、上記の手順で新しいタブを使う。

終了操作の対象はこのタブのデモ認証だけ。共有の旅程・部分修正・学び、デモUID、アクセス券とSecret、共有利用枠はそのまま残る。別のタブや審査員は引き続き利用できる。終了前にサーバーが受理した処理は完了することがある。

## 共有UIDの本番設定

1. Firebase ConsoleのAuthentication設定で対象プロジェクトを **Firebase Authentication with Identity Platform** にアップグレード済みか確認する。未アップグレードの場合は課金・通常利用者への影響を承認してからアップグレードする。SDKの移行は不要だが、BlazeはMAUベースの課金になり、Tier 1の無料枠は月50,000 MAUまで。 [アップグレードと料金](https://firebase.google.com/docs/auth/#identity-platform)
2. Google Cloud ConsoleのIdentity Platform → Settingsで利用者によるアカウント削除を禁止する。APIを使う場合は設定管理者のOAuthで `PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/<PROJECT_ID>/config?updateMask=client.permissions.disabledUserDeletion` に `{"client":{"permissions":{"disabledUserDeletion":true}}}` を送る。管理者には `firebaseauth.configs.update` が必要。新規登録禁止は有効化せず、匿名プロバイダと匿名アカウント自動クリーンアップの現状を維持する。削除禁止は全利用者に及ぶ。通常の匿名登録・復元は引き続き利用でき、利用者自身のアカウント削除は管理者対応になる。 [利用者による削除](https://cloud.google.com/identity-platform/docs/concepts-manage-users) · [設定更新API](https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects/updateConfig)
3. 対象プロジェクトで匿名とCustom Token以外のサインイン経路を無効にする。Identity PlatformのProviders画面で、メール・パスワード、メールリンク、電話、Google等のソーシャル、SAML/OIDCを確認する。審査専用UIDを管理者が作成し、既存の利用者UIDや、メール・電話・プロバイダ連携のあるUIDを割り当てない。連携が許されると、本人のIDトークンで連携を追加し、券なしで同じ共有UIDへサインインできる。連携済みの検出は新規発行を止める補助策であり、発行後の連携の予防にはプロバイダ設定が必要。 [Firebaseのアカウント連携](https://firebase.google.com/docs/auth/web/account-linking)
4. App Hostingの実行サービスアカウントに、対象プロジェクトの `firebaseauth.configs.get` と `firebaseauth.users.get`、署名対象サービスアカウントに対する `iam.serviceAccounts.signBlob` があることを確認する。Identity Toolkit APIとIAM Service Account Credentials APIを有効にする。発行時にADCで `projects.getConfig` を参照し、Identity Platform、自己削除禁止、新規登録可、メール・電話無効を確認する。実行アカウントには設定変更権限を付けない。 [Identity Platform IAM](https://cloud.google.com/identity-platform/docs/access-control) · [Firebase Admin SDKの署名設定](https://firebase.google.com/docs/auth/admin/create-custom-tokens)
5. 対象Webアプリの Authentication 承認済みドメインと reCAPTCHA Enterprise 許可ドメインに提出用ホストを登録する。同一プロジェクトのWebアプリIDと公開サイトキーを `NEXT_PUBLIC_FIREBASE_*` と `NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY` に反映し、実ブラウザから App Check を検証する。
6. 券は信頼できるローカル環境で `crypto.randomBytes(32).toString('base64url')` 相当で作る。Secret Managerの `DEMO_ACCESS_TICKET` には `sha256`（券のUTF-8文字列のSHA-256、小文字16進64文字）、`uid`、`expiresAt`（UTC、ISO 8601の `Z` 表記）、`revoked`（有効時は `false`）を設定する。平文はアクセス制限付きの配布先で扱う。 `COSTLY_API_INVITED_UIDS` に同じUIDを追加する。
7. 承認済みのステージングで、共有UIDの利用者がFirebase Web SDKの `deleteUser` とクライアントRESTの `accounts:delete` で拒否されること、メール・パスワードやフェデレーションを連携して新しいログイン経路を作れないこと、2ブラウザの既存共有セッションが維持されること、通常の匿名新規登録と復元が成功することを確認する。Auth Emulatorは自己削除禁止を強制しない。ローカルテストは自己削除とメール連携の危険を再現し、本番での拒否はステージングで確認する。 [Identity Platformの利用者設定](https://cloud.google.com/identity-platform/docs/concepts-manage-users) · [Firebase Auth REST](https://firebase.google.com/docs/reference/rest/auth/)

自己削除禁止や他プロバイダ無効化を確認できるまで、共有UIDへの交換は有効にしない。

## 期間限定のApp Hosting運用

1. App Hostingの既存URLをそのまま使う。 `DEMO_ACCESS_ORIGIN` はそのHTTPSオリジン（末尾スラッシュなし）。 `DEMO_ACCESS_TICKET` と `COSTLY_API_INVITED_UIDS` はSecret Managerからサーバー実行時に渡し、招待リストには審査用UID 1件だけを登録する。 `NEXT_PUBLIC_FIREBASE_*` とreCAPTCHA Enterpriseの公開サイトキーはビルド時に反映する。 [App Hostingの変数とSecret設定](https://firebase.google.com/docs/app-hosting/configure)
2. [#58の共有枠](API_ABUSE_PROTECTION.md)を短い審査期間、必要な件数・同時数・費用枠で初期化する。既存のApp Hostingスケール設定（#62）と業務APIのクォータを確認し、Cloud Monitoringと予算通知を設定する。交換と実APIは、対象ロールアウトの検証を開始するまで無効にする。
3. 検証時に `DEMO_ACCESS_ENABLED`、`COSTLY_API_DEMO_ENABLED` と必要な個別APIフラグを有効にする。正規券で通常画面から実API操作を確認し、不正券、App Check不正、招待外UID、quota超過、既存匿名セッションからの切替、停止を試す。App Hostingの既定・旧カスタムドメイン、直接 `run.app`、タグ付き旧リビジョン、プレビューや別バックエンドも棚卸しする。到達可能な各経路で現行の保護が効くか、実APIが停止していることを確認する。古い設定に戻り得るロールバックと自動ロールアウトにも注意する。 [App Hostingのロールアウト](https://firebase.google.com/docs/app-hosting/rollouts)
4. 合格後に審査員だけへURLを配布する。期間、共有データ、利用上限、停止担当を共有する。 `DEMO_ACCESS_ENABLED` を停止しても既発行セッションの実API利用可否は #58 が決める。

交換はBearerを要求せず、同一オリジンのPOSTで、本文を最大43バイト、処理を8秒で制限する。正しいハッシュ・期限・未失効・招待済みUIDを確認できた要求だけが、インスタンスあたり直近60秒で12件、同時2件の枠を使う。App CheckとUIDの状態を確認してから署名する。交換処理はFirestoreを読まない。この枠はインスタンスごとに独立し、流入総数や費用の上限を保証しない。

実APIはFirebase Bearer・招待UID・App Check・共有quota・書き込みfencingを通る。未認証・招待外・App Check不正の要求はquotaや業務DBへ進まない。認証・招待・App Checkを通過した要求はquota超過でも判定のために制御文書を読み得る。券の漏洩、共有枠の消費、App Checkトークンの再利用、公開ホストへの大量アクセスによる可用性低下・App Hosting費用を、期間限定運用の残存リスクとして受容する。予算通知は支出を停止しない。 [#58の費用と監視](API_ABUSE_PROTECTION.md)

## アクセス券を扱う画面

`/access` は共通レイアウトとNext.jsのファーストパーティ資産を読み込む。Geistの取得はビルド時に行い、クライアントの計測タグは現行ソースにない。最初に読み込む外部スクリプトはWeb App CheckのreCAPTCHA Enterpriseで、現行実装は先にフラグメントを履歴から除去する。すでにページ内で動作する同一オリジンの悪意あるコードやブラウザ拡張は除去前のフラグメントを観測し得る。現行構成では追加の隔離ページは導入しない。計測や外部タグを追加する場合は、`/access` から除外できることを再確認する。

## 提出資料に添える内容

- 審査専用URLと有効期限はアクセス制限のある資料へ記載する。公開資料には操作手順とデモ動画を掲載する。
- URLを開いて通常画面に入り、旅程を生成して「根拠を確認する」を選ぶ。部分修正・保存を案内する場合は、それぞれ通常画面への接続が入ったリビジョンで先に動作確認する。
- 複数人でデモの保存内容と利用枠を共有する。提出時の実際の期間・UID別/全体の件数・Gemini/Places/Routes/Firestore枠を運用設定から転記する。429が出たら連続操作を止める。期間枠を使い切ると、その期間の利用は終了する。
- 公開前に、独立した2ブラウザ、匿名セッションがあるブラウザ、通常URL、券の無効化、上限到達、直接オリジン、古いロールアウトを確認する。App HostingからFirebase Auth、App Check、Gemini、Places、Routes、Firestoreまでの実API操作を、動画撮影と同じURLで確認する。

## #63との統合

- 交換前の `getAppCheckToken(app)` はFirebase IDトークンを要求せず、デモ用Firebaseアプリを指定できる状態を維持する。App Checkの初期化を共通化するときもFirebaseアプリごとに一度だけ行う。
- 生成・照合の送信は #63 の認証ヘッダーと失敗表示を使いつつ、画面が保持する `SessionScope` に結び付ける。 #60 の `runProtectedSession` の送信前・応答採用前の世代検証と中断を維持し、 #63 の既定クライアントと二重にヘッダーを取得しないよう統合する。
- 部分修正・学び・保存を通常画面へ接続する際は、 #54・#59・#63 の対象機能ごとに、同じ保護API、世代境界、書き込みfencingを通ることを確認する。

## 緊急停止

1. 実APIを急いで止める場合は、Firestore共有枠の `policy.enabled` を停止し、App Hostingの `COSTLY_API_DEMO_ENABLED` と対象APIの個別フラグを無効にしてロールアウトする。受理済み処理の完了と課金状況を監視する。
2. 新規の交換を止めるため、 `DEMO_ACCESS_ENABLED=false` と `revoked: true` のSecret版を反映してロールアウトする。古い設定のリビジョンへのトラフィックも止める。券を取り替えるときは、新しい乱数とハッシュを使う。
3. 既に認証されたユーザーの利用は、招待リストから専用UIDを除外し、Firebase AuthでそのUIDを無効化して、管理者操作 `revokeRefreshTokens(uid)` でセッションを失効させる。 #58のAPIはIDトークンの失効・無効ユーザーも検証する。券を止めても発行済みFirebaseカスタムトークン（Admin SDKの有効期間は最大1時間）や成立済みセッションはそれだけでは止まらない。発行済みトークンが有効な間は対象UIDを無効のまま保つ。 [Firebase Authのセッション管理](https://firebase.google.com/docs/auth/admin/manage-sessions)

URLを得た人は有効期間内に同じ共有UIDで操作できる。App Checkの通常トークンは再利用可能で、招待とApp Checkを通った要求でも利用枠の確認にFirestore読取が発生し得る。設定完了と実環境の動作を確認してから配布する。
