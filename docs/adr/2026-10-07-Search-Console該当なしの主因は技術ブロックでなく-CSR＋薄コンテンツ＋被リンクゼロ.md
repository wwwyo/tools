# Search Console「該当なし」の主因は技術ブロックでなく CSR＋薄コンテンツ＋被リンクゼロ

- Status: Accepted
- Date: 2026-10-07

5ページ全ての初期 HTML が共通ヘッダー＋空 `#app` で、JS 描画後でも本文 74〜313文字。公開2.7ヶ月・被リンクほぼゼロ・Common Crawl 捕捉なし。Google は evergreen Chromium で描画するが、新規・低権威サイトではレンダリングが後回しになる可能性があり（URL Inspection での実描画確認は未実施）、描画されても薄ければ「クロール済み–未登録」になりうる。対策は `transformIndexHtml` での静的コンテンツ注入（`#app` の**外**に差す — `innerHTML` 上書きで内側の注入は描画後に消える）と SC coverage 確認・index リクエスト。Astro 移行は「Vite だから」では本質を解かない（静的テキストを誰も書いていないのが問題）ので却下。静的注入の実装は未着手
