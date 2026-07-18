# tools

simonw/tools 流の「ペラいち PoC 置き場」。1 ツール = 1 HTML ファイルで作り、即 deploy して即 post する。作り込むより出荷を優先する。

## 設計原則

- **1 ツール = 1 HTML ファイル**（`public/*.html`）。ビルドなし・フレームワークなし・依存なしの self-contained な vanilla HTML/CSS/JS
- 外部 CDN / API に依存しない。決定論的なロジックはすべてページ内 JS で完結させる
- ツールを追加したら `public/index.html` の一覧にリンクを足す
- 完成度より出荷速度。動いたら deploy して post する

## ディレクトリ構造

```
tools/
├── public/          デプロイされる静的ファイル（1 ツール = 1 HTML）
│   ├── index.html   ツール一覧
│   └── *.html       各ツール
├── wrangler.jsonc   Cloudflare Workers static assets 設定
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
bun run dev      # ローカル開発サーバ（wrangler dev）
bun run deploy   # Cloudflare へデプロイ（wrangler deploy）
```

## 技術スタック

- Vanilla HTML / CSS / JS（ビルドなし）
- Cloudflare Workers static assets（wrangler）
- bun（wrangler 実行用のみ）
