# `main` push で自動デプロイ、ただし `fetch-depth: 0` が要る

- Status: Accepted
- Date: 2026-07-25

[09959a3](https://github.com/wwwyo/tools/commit/09959a3)。初回デプロイ後にトップの掲載日が全部当日になる不具合が出た。`actions/checkout` の既定 `fetch-depth: 1` は shallow clone なので、`git log --diff-filter=A` で初回追加日を取る実装と噛み合わない。**git 履歴を参照する処理（掲載日・`sitemap.xml` の `lastmod`）がある限り checkout の軽量化より正しいメタデータを優先する**。日付が取れないときに当日付で埋めるのでなく要素を省く方針にしたのは、ビルドごとの出力揺れを避けるため。`sitemap` は手書きでなく Vite のツール検出結果から生成（更新漏れが構造的に起きない）、`changefreq` / `priority` は Google がほぼ無視するので入れない
