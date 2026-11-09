# GroundTrip

> AIが作った日帰り旅行の提案を、根拠を見ながら自分で選べるアプリ。「AIの提案を、人間が根拠で選ぶ（Own the Why）」。

GroundTripは、観光とAIリテラシーを組み合わせた旅行アプリです（GDG DevFest Japan Hackathon 2026 向けの開発）。
Geminiが旅程を**提案**し、地図サービスの情報による**照合**、時刻や固定予定の**制約チェック**を経て、最後は**本人が承認**します。
この4つを混ぜません。

> **以下は、このブランチのコード上の接続範囲です。** 実環境の通し検証は未実施です。
> 「mainにマージ済み」は「一般公開URLから操作できる」とは限りません。API・画面部品・画面導線・本番設定を分けて記載します。
> 提出前には、最新main・CI・本番実機の確認結果に合わせて更新してください。

## 解決したい課題

- AIが作る旅程は、もっともらしく見えますが、**施設が実在するか、その日に営業しているか、移動が間に合うか**といった根拠が見えません。
- 旅行中は、閉店や遅れで予定が崩れます。AIの提案をそのまま信じていると、固定した予約まで巻き込んで作り直されるおそれがあります。
- 旅行の後に残るのは、感想だけです。次の旅行に活かす手がかりが、本人の判断を通さずにAIの中へ入ってしまうのも避けたい点です。

GroundTripは、旅程の**一部だけ**を便利に直す操作の中で、事実・未確認・制約・選んだ理由を確認できるようにします。AIのミス探しを、利用者に強いません。

## 主な特徴と状態

状態は、**mainにあるAPI・部品**と**通常画面からの利用可否**を区別します。公開環境の有料APIは、機能フラグが既定で無効です。

### 1. 旅程の生成

旅行先・日付・希望条件・最大4件の固定予定を入力すると、Gemini（Vertex AI）が日帰り（1地域・3〜4地点）の旅程を提案します。

- **mainに実装済み**：旅程生成API（#17）、入力画面と固定予定入力（#18・#37）、結果の路線図表示（#20）。
- **画面からの動作**：認証・App Check・招待UID・利用枠と各機能フラグの設定後に利用できます。生成した旅程の照合と保存は、本人がボタンを押して始めます。
- Geminiの出力は未照合の提案であり、施設の実在・当日の営業・移動時間の裏付けにはなりません。

### 2. 根拠の照合

提案をPlaces・Routesと照合し、情報源と整合／矛盾あり／確認できないを区別します。

- **mainに実装済み**：Places・Routesアダプター（#21）、照合ロジックと `POST /api/trips/verify`（#27）、根拠表示コンポーネント（#20）、Google Maps帰属部品・`/terms`（#40）。
- **画面接続あり**：生成後に「根拠を確認する」を押すと照合APIを呼び、戻った根拠を路線図に反映します。固定予定などを変更した場合、対応しなくなった照合結果は取り下げます。
- 未照合と、照合を試して確認できなかった状態は別です。通常営業時間・徒歩移動の照合は実際の営業時間や当日の状況を保証しません。

### 3. 1地点の部分修正と本人の承認

- **mainに実装済み**：路線図・固定予定UI（#20）、候補生成／制約検証／前後移動比較API（#28）、候補比較・未承認プレビューの画面部品（#38）。
- **画面導線**：保存済みの現在の旅程では、路線図の予定を開き「この予定だけ変更」から旅行前の候補比較へ進めます。「旅行中」の現地報告からも同じ部分修正APIを使います。`/demo`の候補は架空です。
- **画面接続あり**：保存済みの旅程から候補を比較し、本人の承認後に候補保存と適用APIを呼びます。サーバーが再検証・確定した旅程だけを採用します。未保存の旅程や保存後の変更は、そのまま適用しません。

### 4. 現地報告からの再計画

- **mainに実装済み**：少ない操作で報告するフォーム（#41）、今の予定と次の予定を手動で管理する旅行中の表示（#42）、部分修正APIが扱う `on_site` 文脈（#28）。
- **画面接続あり**：トップ画面の旅程の下に、現地報告と部分修正の候補比較があります。実際の報告だけが適用の対象で、模擬報告は比較までです。
- **適用と復旧**：「保存した旅程で旅行を続ける」から再開できます。適用結果が不明なら再操作を止め、対象候補の承認記録と最新Tripで確認します。未確認状態はUID・Trip別に端末へ残します。旅行中の位置情報は取得せず、進行状況も保存しません。
- デモ用の模擬報告は、現地の実体験として扱いません。

### 5. 振り返りと本人が承認した学び

- **mainに実装済み**：学び候補の作成API（#22）、候補の編集・承認・却下と保存状態表示（#26・#39）、Firestoreの本人別保存API（#44）。
- **画面接続あり**：トップ画面で旅程を保存すると、同じページに振り返りが現れ、保存した旅程・保存済み変更履歴・学びの承認と保存（Firestore、`PERSISTENCE_ENABLED`が必要）につながります。`/reflection` は本人の保存済み旅程、`/reflection?demo=1` は架空のデモです。
- **学び付き旅程の保存**：生成証跡と保存時のFirestore再検証を使い、学びの所有者・承認状態・版・適用範囲を確認して保存します。施設照合後のPlace IDも別のサーバー証跡で検証します。`LEARNING_TRIP_SAVE_ENABLED` は既定で無効です。本番で有効にする前に、読み取り互換リリースの先行配備と共通署名鍵の設定が必要です（[`docs/FIRESTORE_PERSISTENCE.md`](docs/FIRESTORE_PERSISTENCE.md)）。
- 編集・却下・未承認の学びは次回の旅に適用しません。モデルの再学習でもありません。

### 6. 次回旅行への反映

- **mainに実装済み**：生成API・共有データ契約は承認済みの学びの入力や適用情報を表現できます（#15・#17）。Firestore保存API（#44）は承認済みLearningを保存・取得できます。
- **画面接続あり**：旅程フォームの下で、本人の承認済みの学びを選べます。生成APIへは選んだ学びのIDと版（`learningSelections`）だけを送り、サーバーが本人の保存済みデータと照合して使います。クライアントが送る学びの本文は受け付けません。

## 設計の原則

詳細は [`docs/PRODUCT_AND_ARCHITECTURE.md`](docs/PRODUCT_AND_ARCHITECTURE.md) と [`docs/UX_DESIGN_PRINCIPLES.md`](docs/UX_DESIGN_PRINCIPLES.md) にあります。

- **4つの分離**：AIの**提案**、外部情報による**照合**、決定論的な**制約チェック**、**本人の承認**を、別の責務にします。Geminiの文章を、正しさの証拠にしません。
- **「情報源と整合」は、現実の正しさの保証ではありません**。整合は、取得した時点の情報源と合っていたことを表します。臨時休業や当日の混雑は、保証しません。
- **固定予定の保護**：本人が固定した予定は、修正の対象にしません。承認の前は、元の旅程を変えません。
- **失敗の区別**：「候補なし」「情報不足」「外部サービスの失敗」を区別します。失敗したときに、AIの推測で根拠を埋めません。
- **学びは本人が承認したものだけ**：編集した学びは、承認前に戻して再承認を求めます。これは、基盤モデルの再学習ではありません。
- **模擬は模擬と示す**：デモ用の想定や架空のデータを、実測や実際の報告と混ぜません。

## 技術構成

- **アプリ** — 使っているもの: Next.js 15 App Router・React 19・TypeScript strict・Tailwind CSS 4／現在の実装境界: 生成画面とUI部品
- **入出力検証** — 使っているもの: Zod 4（`src/domain`）／現在の実装境界: 共有モデル・APIで検証
- **AI** — 使っているもの: Vertex AI Gemini（`@google/genai`、ADC）／現在の実装境界: 旅程生成／部分修正候補／学び候補API。利用フラグで既定無効
- **Maps** — 使っているもの: Places API (New) Text Search、Routes API（徒歩・一部車）／現在の実装境界: 通常画面の照合・現地報告の候補比較・本人承認後の適用前再検証に接続
- **認証・保存** — 使っているもの: Firebase匿名認証・Firebase Admin SDK・Firestore／現在の実装境界: 通常画面の保存・振り返り・学び選択に接続。本番環境の通し確認は未実施
- **テスト** — 使っているもの: Vitest・Testing Library・Firebase Auth/Firestore Emulator、GitHub Actions／現在の実装境界: 自動テストとCI。実Google APIを用いた全画面E2Eの代わりではない
- **ホスティング** — 使っているもの: Firebase App Hosting／現在の実装境界: mainからロールアウト。公開URL：https://groundtrip--groundtrip.asia-east1.hosted.app/

Firestore Rulesはクライアントからの直接読み書きを全拒否し、Admin SDKを利用する保存APIがサーバー側で認可します。保存APIは`PERSISTENCE_ENABLED=false`が既定です。

公共交通の経路はMVPでは照会しません。詳細は[`docs/API_CONNECTIVITY_FINDINGS.md`](docs/API_CONNECTIVITY_FINDINGS.md)を参照してください。

## Google技術の使いどころと、AIの使い方

状態は上と同じ区分です（2026-11-08 時点）。

- **Gemini（Vertex AI）** — 役割: 旅程生成・変更候補・学び候補／コード上の接続状況: 通常画面の生成・現地報告からの候補比較・振り返りに接続
- **Places API (New)** — 役割: 施設の同定・営業時間の根拠／コード上の接続状況: 通常画面の照合と候補比較に接続
- **Routes API** — 役割: 前後の徒歩移動・時間成立の根拠／mainの実装状態と接続状況: 照合／部分修正APIで利用。公共交通は対象外
- **Firebase Authentication** — 役割: 匿名UIDとサーバー認可／コード上の接続状況: BearerとApp Checkを画面から付与し、UID・認証世代の切替で古い要求と表示を破棄。提出用のデモ認証も実装
- **Firestore** — 役割: Trip・Revision・Learningを本人別に保存／コード上の接続状況: 保存・振り返り・学び選択を画面に接続。実環境疎通は未確認
- **Firebase App Hosting** — 役割: Google Cloudで実行／mainの実装状態と接続状況: 初期アプリ公開済み。課金API等の安全な有効化は#29

### プロダクトの中のAI（Gemini）の使いどころ

- **旅程の提案**（`main`）：条件から日帰り旅程を作ります。出力はZodで検証し、固定予定は入力どおりに置き換えます。施設は未同定・未照合のまま返します。
- **学びの候補の作成**（`main`）：感想と、承認済みで模擬でない変更から、候補を1〜3件作ります。候補はすべて未承認で、本人が承認したものだけを残します。
- **部分修正の代替候補**：現地報告から、選んだ1地点だけの代替を最大3件作ります。成立するかは、Places・Routesと時刻の制約チェックで確かめます。承認後の適用は別の処理です。
- **Geminiがしないこと**：根拠の証拠になる、承認する、施設の実在や営業を判断する。基盤モデルの再学習もしません。

Geminiを選んだ理由と、各APIを選んだ理由の文面は、`docs/` に記載がありません。提出文書に書く前に、チームで確認してください（`docs/API_CONNECTIVITY_FINDINGS.md` には、`responseSchema` で検証用のJSONを生成できたという実測があります）。

## 画面とAPI

以下のルートは**mainのコードに存在**します。画面導線、本番での機能フラグ、IAMの設定は別に確認が必要です。

- **画面** — パス: `/`／現状: 旅程の生成（前の旅の学びの選択つき）→根拠の照合→保存→旅行前の予定変更／現地報告と候補比較・本人承認後の適用→振り返りと学びの保存。保存した旅程の再開にも対応
- **画面** — パス: `/demo`／現状: **架空の**旅程・候補・根拠による路線図と部分修正UI。実APIには接続しない
- **画面** — パス: `/reflection`／現状: 本人の保存済み旅程の振り返りと学びの保存。`/reflection?demo=1`は**架空の**Tripによる確認（保存しない）
- **画面** — パス: `/terms`／現状: 利用条件・プライバシーとGoogle Mapsの関連表示（#40）
- **画面・API** — パス: `/access#ticket=...`・`POST /api/access/exchange`／現状: 提出用のデモUIDへ認証。既定無効で、Identity Platform・App Check・アクセス券の設定と実環境確認が必要（[`docs/DEMO_ACCESS.md`](docs/DEMO_ACCESS.md)）
- **API** — パス: `POST /api/trips/generate`／現状: 旅程生成（`TRIP_GENERATION_ENABLED`、既定無効）
- **API** — パス: `POST /api/trips/verify`／現状: Places・Routes照合（`TRIP_VERIFICATION_ENABLED`、既定無効）
- **API** — パス: `POST /api/trips/revise`／現状: 部分修正候補の提案のみ（`TRIP_REVISION_ENABLED`、既定無効）
- **API** — パス: `POST /api/trips/[tripId]/revisions/[revisionId]/apply`／現状: 保存した候補の再検証と原子的な適用（`TRIP_REVISION_APPLY_ENABLED`と`PERSISTENCE_ENABLED`が必要、既定無効）。署名付き候補にはサーバー専用の`REVISION_PROPOSAL_SIGNING_KEY`も必要
- **API** — パス: `POST /api/learnings/candidates`／現状: 学びの候補生成（`LEARNING_CANDIDATES_ENABLED`、既定無効）
- **API** — パス: `GET /api/auth/session`／現状: Firebase IDトークンの確認
- **API** — パス: `/api/trips`・`/api/trips/[tripId]`・`/api/trips/[tripId]/revisions`／現状: Trip・Revisionの本人別保存・取得。`PERSISTENCE_ENABLED`が必要（既定無効）
- **API** — パス: `POST /api/trips`（学びの適用記録つき）／現状: 署名証跡と保存時の学び再検証に対応。`LEARNING_TRIP_SAVE_ENABLED` が必要（既定無効）
- **API** — パス: `/api/learnings`・`/api/learnings/[learningId]/approve`・`/api/learnings/[learningId]`／現状: Learningの取得・承認・撤回。`PERSISTENCE_ENABLED`が必要（既定無効）

保存APIの具体的なHTTPメソッド・権限・ステータスは[`docs/FIRESTORE_PERSISTENCE.md`](docs/FIRESTORE_PERSISTENCE.md)を参照してください。**Revisionの候補保存・適用・結果不明時の復旧を、現地報告の画面へ接続しています。実環境での確認は別途必要です。**

## 制限事項

- **MVPの範囲**：日帰り・1地域・3〜4地点・1地点の部分修正。複数日最適化・GPS常時追跡・モデルの追加学習は対象外です。
- **現実の制約**：通常営業時間と徒歩移動の一部を照合しますが、臨時休業・特別営業・現地混雑・渋滞・遅延の保証はありません。未照合・確認不能・矛盾は区別します。
- **路線図は模式図**です。訪問順を示すもので、地図上の距離・方角・縮尺を表しません。
- **サンプルは架空**：`/demo`と`/reflection?demo=1`のTrip・候補・模擬根拠は、実在施設の情報や実測結果ではありません。
- **学び付き保存の展開条件**：コードは対応済みですが、`LEARNING_TRIP_SAVE_ENABLED` は既定無効です。版付き履歴を読めるサーバー・クライアントを先に配備し、それをロールバック先として保持してから有効化してください。実環境（Firebase・App Check・署名鍵・保存API・各フラグを有効にした状態）での通し確認は未了です。
- **課金APIは既定で停止**：生成・照合・部分修正・学び候補作成は、機能フラグが`false`。認証・全体の利用制限・App Checkまたは代替策・課金保護（#29）なしで一般公開しないでください。
- **Firestore保存APIも既定で停止**：`PERSISTENCE_ENABLED=false`。実FirebaseのIAM・ADC・Rulesの確認と本番疎通がまだ必要です。画面からのBearer・App Check送信は接続済みです。
- **匿名認証**は身元確認ではなく、UIDを失うと保存したデータに戻れない場合があります。
- **生成と承認は別**：生成したTrip・候補は未承認です。Geminiの回答は施設・営業・価格を保証しません。

## 外部サービスの扱い

- **Google Maps Platform**：保存する外部データはPlace IDに限定。Placesの表示名・住所・座標・営業時間、Routesの所要時間や根拠一式は保存せず、一時的に扱います。規約の詳細は[`docs/MAPS_API_ADAPTERS.md`](docs/MAPS_API_ADAPTERS.md)・[`docs/FIRESTORE_PERSISTENCE.md`](docs/FIRESTORE_PERSISTENCE.md)。
- **帰属表示と利用条件**：照合結果の帰属表示、フッターの利用条件への導線、`/terms`を接続しています（[`docs/GOOGLE_MAPS_COMPLIANCE.md`](docs/GOOGLE_MAPS_COMPLIANCE.md)）。実環境での表示・運用条件の確認は別途必要です。
- **Gemini（Vertex AI）**：旅程条件・希望・固定予定・感想などをサーバーからGeminiへ送ります。サービスへの認証はADCで行い、APIキー・秘密情報はブラウザに渡しません。
- **Firebase**：匿名認証とFirestore本人別保存APIを画面に接続しています。Firestore Rulesはクライアントからの直接アクセスを全拒否し、Admin SDKを使うAPIで本人確認と認可を行います。
- **秘密情報**：変数名は[`.env.example`](.env.example)を参照。実際の値はコミットしません。

## デモ

提出時のデモの台本は [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) です。

## 開発環境

- Node.js 24.15以上の24系
- pnpm（バージョンは`package.json`に準拠）
- Windows / macOS / Linux（WSL2を含む）

### セットアップ

依存関係をインストールします。

    pnpm install --frozen-lockfile

開発サーバーを起動します。

    pnpm dev

ブラウザで http://localhost:3000 を開いてください。

### 検証

以下のコマンドを実行します。

    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm test
    pnpm build

共通データモデル・入出力契約の利用方法と未決定事項は
[`docs/DOMAIN_CONTRACTS.md`](docs/DOMAIN_CONTRACTS.md)を参照してください。

匿名認証・サーバー認証・全拒否Rules・Firebase Emulatorの実行方法と本番設定は
[`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md)を参照してください。
コードにはApp Checkと利用制限を実装しています。公開前にはConsole設定と、拒否・利用上限・停止を含む実環境の通し確認が必要です。
