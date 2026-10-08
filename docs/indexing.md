# SEO / indexing 診断

tools.wwwyo.dev のページが Google にインデックスされない事象を調べるときの手順と、静的コンテンツを置くときの構造上の注意。

## 前提：このサイトのレンダリング形態

Vite MPA の CSR で、各ツールの `src/<appdir>/index.html` に含まれる body は空の `<div id="app">`（React ツールは `#root`）と script タグだけで、全コンテンツは JS が DOM 構築した後に現れる。生 HTML の body は「どんなページか」をほとんど伝えない（実測 74 文字台）。Googlebot は evergreen Chromium で CSR を描画できるが、描画キューで後回しになるので新規・低権威サイトでは「描画待ち」で長い間未索引のままになりうる。

## まず確認する（全部で 5 分で見られる）

| 確認 | 方法 | 期待値 |
|------|------|--------|
| HTTP ステータス | `curl -I <url>` | 200。403/503 なら bot 遮断系を疑う |
| robots.txt | `curl <url>/robots.txt` | `User-agent: *` + `Allow: /`。Disallow: / があればそれが原因 |
| sitemap.xml | `curl <url>/sitemap.xml` | 全 page の URL が入っていること。lastmod は各ツール dir の最終コミット日で、git log が取れない環境では省略される |
| noindex | `curl -s <url> \| rg -i 'noindex\|robots'` | 無いこと。X-Robots-Tag ヘッダも確認 |
| canonical | `curl -s <url> \| rg 'rel="canonical"'` | 自 page を指していること（他 URL への canonical は正規化で弾かれる） |
| 描画後の文字数 | Playwright / Puppeteer 等の headless browser で描画後の `document.body.innerText` を取る（repo 内の環境なら Orca 内蔵ブラウザで `orca tab create --url <url>` → `orca eval --expression "document.body.innerText"`、または agent-browser skill） | 目安として数百文字以上あること。**74 文字台だと「このページが何か」を伝えられていない疑い**（thin content の可能性） |
| Cloudflare の bot 設定 | `cf zones settings get security_level -z wwwyo.dev` で Under Attack mode を確認（ダッシュボード: Security → Settings）。Bot Fight Mode は別設定で `cf` からは読めないので、ダッシュボードの Security → Bots を見る | `security_level` が `under_attack` だとインタースティシャルチャレンジが表示され、Googlebot のクロールや indexing を妨げる可能性がある。Googlebot が challenge または block されるかは Security Events で確認する。Bot Fight Mode は verified bot である Googlebot を通常素通りさせるが、誤判定がありうる |
| Search Console | URL Inspection → coverage state | `Discovered – currently not indexed` は発見済み・未クロール（まだ中身を見ていない）。`Crawled – currently not indexed` はクロール・評価済みで未採用 |

`Discovered – currently not indexed` はまだクロールされていない状態で、Google はこの時点ではコンテンツを評価していない（描画待ちや評価待ちではなく、クロールのスケジュール待ち）。`Crawled – currently not indexed` になって初めて「評価されたが未採用」と読める。いずれにせよ生 HTML が 74 文字台のままでは、描画されても thin content と見なされるリスクが高いので、静的テキストを足す方が早い（下記）。

## 静的テキストを足すとき：マウント root の外に置く

**`#app` / `#root` の内側に書いた静的テキストは消える。** 各ツールの `src/<appdir>/main.ts` が `appEl.innerHTML = <テンプレート>`（React ツールは `createRoot(#root).render()`）で root を丸ごと上書きするので、サーバーが HTML に入れておいた root 内の文章は JS 起動の瞬間に破棄される。

静的テキストを残すには2択：

- **マウント root の外（兄弟要素）に置く** — `<div id="app">` と並列の `<section>` 等。JS 起動後も DOM に残る。基本はユーザーにも見える説明文として置くのが安全。どうしても視覚的に出せない場合は、screen reader 向けテキストと同じ `.sr-only` パターン（`position: absolute`・1px サイズ・`clip-path: inset(50%)`・`overflow: hidden`）を使う。ただし検索エンジンだけに見せるテキストは Google の spam policy 上の hidden text に該当しうるので、screen reader 利用者にも読まれ、かつ内容が page の実体と同一の場合に限る
- **`transformIndexHtml` で page ごとにマウント root の前後へ注入** — `vite.config.ts` に per-page の inject plugin を足すとツールの HTML を触らずに全ページへ載せられる

やってはいけないのは、Googlebot だけに別 HTML を返す UA ベースの cloaking（policy 違反）。全ユーザーに同じ HTML を返し、JS が起きたら app が引き継ぐ形にする。

## index 申請

Search Console の URL Inspection → Request Indexing。新規・低権威サイトへの効果は限定的だが、sitemap 提出 + 内部リンク（`/` のツール一覧から各 page への a タグ）と合わせてやる。`<a href>` が無く JS ナビゲーションだけの page は bot が辿りにくいので、一覧 page は静的な a タグにしておく。
