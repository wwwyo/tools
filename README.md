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

## Tools

- [薄っぺらな嘘 — Plausible Texture](src/plausible-texture/) — LLM っぽい定型句を検知して剥がす
