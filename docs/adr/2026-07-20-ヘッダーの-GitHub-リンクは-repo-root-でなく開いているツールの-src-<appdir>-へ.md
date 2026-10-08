# ヘッダーの GitHub リンクは repo root でなく開いているツールの `src/<appdir>` へ

- Status: Accepted
- Date: 2026-07-20

`vite.config.ts` の `headerPlugin` で `ctx.path` を見て注入時に差し替える（dev の `/goteki/` と build の `/goteki/index.html` の両方を解釈）。`src/header.html` 側に repo URL を埋めないのは、ツール側に環境依存の知識を持たせないため
