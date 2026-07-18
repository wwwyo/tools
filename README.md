# tools

ペラいちの PoC ツール集。1 ツール = 1 HTML ファイルで作り、Cloudflare に deploy している。[simonw/tools](https://github.com/simonw/tools) スタイル。

## Getting Started

```bash
mise install   # bun
bun install    # wrangler
bun run dev    # ローカル開発
bun run deploy # Cloudflare へデプロイ
```

## Tools

- [llm-ja-check](public/llm-ja-check.html) — LLM が日本語で使いがちなワードを決定論的に検知・採点する
