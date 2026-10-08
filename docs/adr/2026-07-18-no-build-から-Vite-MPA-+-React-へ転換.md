# no-build から Vite MPA + React へ転換

- Status: Accepted
- Date: 2026-07-18

当初 simonw/tools と同じビルドなし静的 HTML で始めたが、コードを書くのは agent なので build の摩擦は実質ゼロと判断。守るべき制約は「no-build」ではなく「1 ツール = 1 ページ・即日 deploy」の側であり、build 解禁と引き換えに作り込み禁止事項（SPA 化・共有化）を AGENTS.md に固定した
