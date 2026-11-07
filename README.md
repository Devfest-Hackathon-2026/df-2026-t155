# GroundTrip

> AIが作った日帰り旅行の提案を、根拠を見ながら自分で選べるアプリ。「AIの提案を、人間が根拠で選ぶ（Own the Why）」。

GroundTripは、観光とAIリテラシーを組み合わせた旅行アプリです（GDG DevFest Japan Hackathon 2026 向けの開発）。
Geminiが旅程を**提案**し、地図サービスの情報による**照合**、時刻や固定予定の**制約チェック**を経て、最後は**本人が承認**します。
この4つを混ぜません。

> **実装状況の確認基準：2026-11-08 JST、main `9473297`（PR #43を含む）。**
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
- **画面からの動作**：生成APIが有効で、Google Cloudの権限・認証設定が正しければ利用できます。ただし、生成後の自動照合・Firestore保存はまだ接続していません。
- Geminiの出力は未照合の提案であり、施設の実在・当日の営業・移動時間の裏付けにはなりません。

### 2. 根拠の照合

提案をPlaces・Routesと照合し、情報源と整合／矛盾あり／確認できないを区別します。

- **mainに実装済み**：Places・Routesアダプター（#21）、照合ロジックと `POST /api/trips/verify`（#27）、根拠表示コンポーネント（#20）、Google Maps帰属部品・`/terms`（#40）。
- **未接続**：通常の旅程生成画面から照合APIを呼び、戻った根拠を路線図に反映する導線（別作業）。APIがmainにあっても、画面上の生成旅程が照合済みになるわけではありません。
- 未照合と、照合を試して確認できなかった状態は別です。通常営業時間・徒歩移動の照合は実際の営業時間や当日の状況を保証しません。

### 3. 1地点の部分修正と本人の承認

- **mainに実装済み**：路線図・固定予定UI（#20）、候補生成／制約検証／前後移動比較API（#28）、候補比較・未承認プレビューの画面部品（#38）。
- **現時点の画面導線**：`/demo` は架空の候補を使って比較UIを確認できます。通常のトップ画面は部分修正APIを比較UIへ渡していないため、生成した旅程から実際の候補を探せません。
- **未接続**：サーバーでの再検証・本人承認後のRevision適用・保存。候補生成APIは旅程を更新しません。固定予定や未承認の旅程を勝手に変更しないことが必須です。

### 4. 現地報告からの再計画

- **mainに実装済み**：少ない操作で報告するフォーム（#41）、今の予定と次の予定を手動で管理する旅行中の表示（#42）、部分修正APIが扱う `on_site` 文脈（#28）。
- **未接続**：ホームから旅行中画面・現地報告を開く導線と、報告内容を代替候補・承認・保存までつなぐ流れ。旅行中の位置情報は取得せず、進行状況も保存しません。
- デモ用の模擬報告は、現地の実体験として扱いません。

### 5. 振り返りと本人が承認した学び

- **mainに実装済み**：学び候補の作成API（#22）、候補の編集・承認・却下と保存状態表示（#26・#39）、Firestoreの本人別保存API（#44）。
- **未接続**：`/reflection` は架空のサンプルTripを表示する確認ページです。実際の旅程・保存済み変更履歴・Firestoreの学び承認APIとは接続されていません。現状の画面操作だけでは学びは永続保存されません。
- 編集・却下・未承認の学びは次回の旅に適用しません。モデルの再学習でもありません。

### 6. 次回旅行への反映

- **mainに実装済み**：生成API・共有データ契約は承認済みの学びの入力や適用情報を表現できます（#15・#17）。Firestore保存API（#44）は承認済みLearningを保存・取得できます。
- **未接続**：認証済み本人のLearningをサーバーで取得し、確認・選択して生成へ渡し、反映範囲と結果を画面に示す処理（Issue #13）。旅程フォームは現在、学びを空で送ります。

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
- **Maps** — 使っているもの: Places API (New) Text Search、Routes API（徒歩・一部車）／現在の実装境界: APIと照合ロジックはmainにあり、通常の生成画面には未接続
- **認証・保存** — 使っているもの: Firebase匿名認証・Firebase Admin SDK・Firestore／現在の実装境界: 本人別の保存APIはmainに実装済み（#44）。通常画面・本番環境とは未接続
- **テスト** — 使っているもの: Vitest・Testing Library・Firebase Auth/Firestore Emulator、GitHub Actions／現在の実装境界: 自動テストとCI。実Google APIを用いた全画面E2Eの代わりではない
- **ホスティング** — 使っているもの: Firebase App Hosting／現在の実装境界: mainからロールアウト。公開URL：https://groundtrip--groundtrip.asia-east1.hosted.app/

Firestore Rulesはクライアントからの直接読み書きを全拒否し、Admin SDKを利用する保存APIがサーバー側で認可します。保存APIは`PERSISTENCE_ENABLED=false`が既定です。

公共交通の経路はMVPでは照会しません。詳細は[`docs/API_CONNECTIVITY_FINDINGS.md`](docs/API_CONNECTIVITY_FINDINGS.md)を参照してください。

## Google技術の使いどころと、AIの使い方

状態は上と同じ区分です（2026-11-08 時点）。

- **Gemini（Vertex AI）** — 役割: 旅程生成・変更候補・学び候補／mainの実装状態と接続状況: 3つともAPI実装済み。生成以外は通常画面の通し導線が未完成
- **Places API (New)** — 役割: 施設の同定・営業時間の根拠／mainの実装状態と接続状況: 照合／部分修正APIはmainにあるが通常画面へ未接続
- **Routes API** — 役割: 前後の徒歩移動・時間成立の根拠／mainの実装状態と接続状況: 照合／部分修正APIで利用。公共交通は対象外
- **Firebase Authentication** — 役割: 匿名UIDとサーバー認可／mainの実装状態と接続状況: サーバーの認証処理・保存APIは実装済み。画面のBearer付与は未接続
- **Firestore** — 役割: Trip・Revision・Learningを本人別に保存／mainの実装状態と接続状況: #44でサーバーAPI実装済み。実環境疎通と画面接続は未確認
- **Firebase App Hosting** — 役割: Google Cloudで実行／mainの実装状態と接続状況: 初期アプリ公開済み。課金API等の安全な有効化は#29

### プロダクトの中のAI（Gemini）の使いどころ

- **旅程の提案**（`main`）：条件から日帰り旅程を作ります。出力はZodで検証し、固定予定は入力どおりに置き換えます。施設は未同定・未照合のまま返します。
- **学びの候補の作成**（`main`）：感想と、承認済みで模擬でない変更から、候補を1〜3件作ります。候補はすべて未承認で、本人が承認したものだけを残します。
- **部分修正の代替候補**（main、#28。通常画面には未接続）：選んだ1地点だけの代替を、最大3件作ります。成立するかは、Places・Routesと時刻の制約チェックで確かめます。
- **Geminiがしないこと**：根拠の証拠になる、承認する、施設の実在や営業を判断する。基盤モデルの再学習もしません。

Geminiを選んだ理由と、各APIを選んだ理由の文面は、`docs/` に記載がありません。提出文書に書く前に、チームで確認してください（`docs/API_CONNECTIVITY_FINDINGS.md` には、`responseSchema` で検証用のJSONを生成できたという実測があります）。

## 画面とAPI

以下のルートは**mainのコードに存在**します。画面導線、本番での機能フラグ、IAMの設定は別に確認が必要です。

- **画面** — パス: `/`／現状: 旅程の生成フォーム・路線図。部分修正の実API、照合、保存は未接続
- **画面** — パス: `/demo`／現状: **架空の**旅程・候補・根拠による路線図と部分修正UI。実APIには接続しない
- **画面** — パス: `/reflection`／現状: **架空の**Tripによる学び候補の編集・承認・却下。Firestore保存は未接続
- **画面** — パス: `/terms`／現状: 利用条件・プライバシーとGoogle Mapsの関連表示（#40）
- **API** — パス: `POST /api/trips/generate`／現状: 旅程生成（`TRIP_GENERATION_ENABLED`、既定無効）
- **API** — パス: `POST /api/trips/verify`／現状: Places・Routes照合（`TRIP_VERIFICATION_ENABLED`、既定無効）
- **API** — パス: `POST /api/trips/revise`／現状: 部分修正候補の提案のみ（`TRIP_REVISION_ENABLED`、既定無効）
- **API** — パス: `POST /api/learnings/candidates`／現状: 学びの候補生成（`LEARNING_CANDIDATES_ENABLED`、既定無効）
- **API** — パス: `GET /api/auth/session`／現状: Firebase IDトークンの確認
- **API** — パス: `/api/trips`・`/api/trips/[tripId]`・`/api/trips/[tripId]/revisions`／現状: Trip・Revisionの本人別保存・取得。`PERSISTENCE_ENABLED`が必要（既定無効）
- **API** — パス: `/api/learnings`・`/api/learnings/[learningId]/approve`・`/api/learnings/[learningId]`／現状: Learningの取得・承認・撤回。`PERSISTENCE_ENABLED`が必要（既定無効）

保存APIの具体的なHTTPメソッド・権限・ステータスは[`docs/FIRESTORE_PERSISTENCE.md`](docs/FIRESTORE_PERSISTENCE.md)を参照してください。**Revisionの実適用APIはまだ存在しません。**

## 制限事項

- **MVPの範囲**：日帰り・1地域・3〜4地点・1地点の部分修正。複数日最適化・GPS常時追跡・モデルの追加学習は対象外です。
- **現実の制約**：通常営業時間と徒歩移動の一部を照合しますが、臨時休業・特別営業・現地混雑・渋滞・遅延の保証はありません。未照合・確認不能・矛盾は区別します。
- **路線図は模式図**です。訪問順を示すもので、地図上の距離・方角・縮尺を表しません。
- **サンプルは架空**：`/demo`と`/reflection`のTrip・候補・模擬根拠は、実在施設の情報や実測結果ではありません。
- **画面接続は未完成**：生成後の照合、部分修正候補の実取得、承認後の適用・保存、現地報告による再計画、実際の旅程の振り返り、次回への学び反映は、一連の利用者操作として未接続です。
- **課金APIは既定で停止**：生成・照合・部分修正・学び候補作成は、機能フラグが`false`。認証・全体の利用制限・App Checkまたは代替策・課金保護（#29）なしで一般公開しないでください。
- **Firestore保存APIも既定で停止**：`PERSISTENCE_ENABLED=false`。実FirebaseのIAM・ADC・Rulesの確認、本番疎通、画面からのBearer送信がまだ必要です。
- **匿名認証**は身元確認ではなく、UIDを失うと保存したデータに戻れない場合があります。
- **生成と承認は別**：生成したTrip・候補は未承認です。Geminiの回答は施設・営業・価格を保証しません。

## 外部サービスの扱い

- **Google Maps Platform**：保存する外部データはPlace IDに限定。Placesの表示名・住所・座標・営業時間、Routesの所要時間や根拠一式は保存せず、一時的に扱います。規約の詳細は[`docs/MAPS_API_ADAPTERS.md`](docs/MAPS_API_ADAPTERS.md)・[`docs/FIRESTORE_PERSISTENCE.md`](docs/FIRESTORE_PERSISTENCE.md)。
- **帰属表示と利用条件**：帰属表示部品・`/terms`・対応表は#40でmainに実装済みです（[`docs/GOOGLE_MAPS_COMPLIANCE.md`](docs/GOOGLE_MAPS_COMPLIANCE.md)）。生成画面で照合結果を表示するときは、対応する帰属部品と利用条件への導線を接続する必要があります。
- **Gemini（Vertex AI）**：旅程条件・希望・固定予定・感想などをサーバーからGeminiへ送ります。サービスへの認証はADCで行い、APIキー・秘密情報はブラウザに渡しません。
- **Firebase**：匿名認証とFirestore本人別保存APIがmainにあります。Firestore Rulesはクライアントからの直接アクセスを全拒否。実アプリの画面への保存・取得は未接続です。
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
認証基盤だけでは有料APIの公開条件を満たしません。App Checkと利用制限は後続作業です。
