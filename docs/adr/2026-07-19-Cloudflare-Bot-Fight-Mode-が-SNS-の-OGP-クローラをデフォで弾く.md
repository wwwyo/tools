# Cloudflare Bot Fight Mode が SNS の OGP クローラをデフォで弾く

- Status: Accepted
- Date: 2026-07-19

deploy も OGP 生成も完了しているのに X でカードが出ない原因がこれだった。Bot Fight は無料プランの既定で有効になっており、SNS の unfurl bot も bot として落とすため、**「出荷は終わったが人目に触れない」状態をインフラの既定値が作る**。post を出口とする PJ では、deploy の完了条件に「OGP が外部サービスで実際に展開されること」まで含めないと、完了判定を誤る
