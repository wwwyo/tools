# OGP の `Content-Type` 疑いは空振り、配信は最初から正しかった

- Status: Accepted
- Date: 2026-07-20

X でカードが出ない件で `text/html` が返っていない説を追ったが、実レスポンスを見ると Cloudflare Workers の static assets が拡張子に応じて既に正しく付与していた（HTML は `text/html`、画像は `image/png`）。`/goteki` は 307 で `/goteki/` へ飛びクローラも追従する（共有 URL は末尾スラッシュ付きが無難）。**推測で原因を作らず先にレスポンスを見れば1手で終わっていた**。これで 07-19 の Bot Fight と合わせて post を塞ぐ技術要因は消えた
