# tools

ペラいちの PoC ツール集。1 ツール = 1 ディレクトリで作り、Cloudflare に deploy している。

## Getting Started

```bash
mise install   # bun
bun install    # wrangler + Vite + React
bun run dev    # ローカル開発（Vite dev server）
bun run build  # ビルド
bun run deploy # Cloudflare へデプロイ
```

## Structure

```
src/
├── index.html       ツール一覧（ビルド時に自動生成）
├── global.css       Tailwind v4 エントリ
└── <appdir>/        各ツール（1 ツール = 1 ディレクトリ）
    └── index.html   エントリ
```

## License

[MIT](LICENSE)
