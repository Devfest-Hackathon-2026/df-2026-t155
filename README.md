## 開発環境

- Node.js 24系
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
