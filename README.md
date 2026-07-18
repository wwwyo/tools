# tools

ペラいちの PoC ツール集。1 ツール = 1 HTML ファイルで作り、Cloudflare に deploy している。[simonw/tools](https://github.com/simonw/tools) スタイル。

## Getting Started

```bash
mise install   # bun
bun install    # wrangler + Vite + React
bun run dev    # ローカル開発（Vite dev server）
bun run build  # ビルド
bun run deploy # Cloudflare へデプロイ
```

## Tools

- [llm-ja-check](src/llm-ja-check.html) — LLM が日本語で使いがちなワードを決定論的に検知・採点する
