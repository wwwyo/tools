# tools

ペラいち PoC 置き場。1 ツール = 1 ディレクトリで作り、即 deploy して即 post する。作り込むより出荷を優先する。

## 設計原則

- **1 ツール = 1 ディレクトリ**（`src/<appdir>/`、エントリは `index.html`）。ツールは vanilla JS でも React でも OK、ただし各ツールは独立していなければならない
- **FORBIDDEN**: SPA 化、ツール間でのコンポーネント・ルーティング共有、クロスツール共有設計システム構築。ツールは常に独立
- 外部 CDN / API に依存しない。決定論的なロジックはすべてページ内 JS で完結させる
- ツール一覧は各ツールの `index.html` の `<title>` / `<meta name="description">` からビルド時に自動生成される（Vite はビルド時に `src/<appdir>/index.html` を自動検出し、`src/index.html` の一覧を手で足す必要はない）
- 完成度より出荷速度。動いたら build して deploy して post する

## ディレクトリ構造

```
tools/
├── src/
│   ├── index.html       ツール一覧
│   ├── global.css       Tailwind v4 エントリ（@import "tailwindcss" + @theme トークン）
│   └── <appdir>/        各ツール（1 ツール = 1 ディレクトリ）
│       ├── index.html   エントリ
│       └── *.tsx など   実装（vanilla JS または React）
├── dist/            Vite build 出力（gitignore、デプロイ対象）
├── vite.config.ts   Vite 設定（src/<appdir>/index.html を自動検出）
├── tsconfig.json    TypeScript 設定（jsx: "react-jsx" 含む）
├── wrangler.jsonc   Cloudflare Workers static assets 設定（dist/ を参照）
├── mise.toml        ツール管理（bun）
└── bunfig.toml      exact install + 7day cooldown
```

## セットアップ

ツールは mise で管理している。

```bash
mise install   # bun をインストール
bun install    # wrangler をインストール
```

## コマンド

```bash
bun install      # 依存インストール
bun run dev      # ローカル開発サーバ（Vite dev）
bun run build    # ビルド（Vite build → dist/）
bun run deploy   # Cloudflare へデプロイ（build → wrangler deploy）
```

## 技術スタック

- HTML / CSS / JS + Vite MPA（Vanilla JS または React。JSX 対応）
- Tailwind CSS v4（@tailwindcss/vite。スタイルはユーティリティ class を基本とし、表現しづらいものだけ各ツールの CSS に @layer components で書く）
- TypeScript（オプション、any は禁止）
- Cloudflare Workers static assets（wrangler）
- bun（パッケージ管理）
- mise（ツール管理）
