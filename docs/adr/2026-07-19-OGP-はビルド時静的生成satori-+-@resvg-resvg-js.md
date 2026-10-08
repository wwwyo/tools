# OGP はビルド時静的生成（satori + @resvg/resvg-js）

- Status: Accepted
- Date: 2026-07-19

ツール数が少なく内容も固定なので Worker での動的生成は過剰。入力は各ツールの `title` / `description` を SSOT にし、OGP 専用メタをツール側に増やさない。各ツール配下の `og.tsx` で実画面ミニチュアを差し込み、無ければテキストのみにフォールバック（必須化すると出荷摩擦が増えるため）。satori はブラウザの CSS と一致せず `text-decoration: wavy` 等は効かないので、見た目は近似で割り切る
