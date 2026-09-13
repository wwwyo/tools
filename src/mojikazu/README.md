# 文字数（mojikazu）

テキストを貼り付けると、文字数・行数などを即座に集計するツール。

## なぜ grapheme cluster で数えるか

「文字数」という言葉に対する人間の直感は「1文字として見える単位」だが、JavaScript の文字列表現とは一致しない。

- `.length`（UTF-16長）はサロゲートペアを2として数える。`𠮷`（JIS漢字、U+20BB7）は `.length` で2になる
- `Array.from(text)`（コードポイント単位）はサロゲートペアを1にまとめるが、結合文字（`か` + 濁点結合文字）や ZWJ で連結された絵文字（👨‍👩‍👧‍👦）、異体字セレクタ付き文字は複数要素に割れる
- `Intl.Segmenter(locale, { granularity: "grapheme" })` は Unicode の extended grapheme cluster 境界規則（UAX #29）に従って分割するため、上記すべてを人間が知覚する「1文字」として1つにまとめられる

そのため `count.ts` の全カウントは `Intl.Segmenter` による grapheme cluster を基本単位にしている。`Intl.Segmenter` が無い環境では `Array.from(text)`（コードポイント単位）にフォールバックする。この場合は結合文字・ZWJ絵文字などの精度が落ちる（`count.ts` の `toGraphemes` にコメントで明記）。

## 非送信の保証

テキストはこのページ内の JS だけで処理する。`fetch` / `XMLHttpRequest` / `navigator.sendBeacon` のいずれも呼ばないことで、外部送信が起きないことを保証している。ネットワークタブで確認しても通信は発生しない。

## 表示する値

- **文字数**（メイン）: grapheme cluster 数
- **文字数（空白・改行を除く）**: 空白・改行の grapheme を除いた数
- **文字数（改行を除く）**: 改行の grapheme のみを除いた数
- **行数**: `\n` 区切りの行数。末尾の改行は「次の空行の始まり」ではなく「行の終端」として扱うため、末尾の改行1つは空行として数えない（エディタの慣習に合わせている）。空文字列は0行
- 単語数は意図的に入れていない。日本語には分かち書きの慣習が無く、単語境界の判定自体が曖昧なため「単語数」という指標の意味が薄い

### 参考値（`<details>` に格納）

- **コードポイント数**: `Array.from(text).length`
- **UTF-16長**: `text.length`
- **UTF-8バイト数**: `new TextEncoder().encode(text).length`
- **全角換算**: 各 grapheme の先頭コードポイントの East Asian Width を見て、半角=0.5・全角=1として合算する。厳密な East Asian Width（UAX #11）の Wide/Fullwidth 判定は広いコードポイント範囲表を要するため、ここでは「半角ASCII（U+0000–U+007E）・半角カタカナ（U+FF61–U+FF9F）のみ0.5、それ以外は1」という簡易判定にしている（`count.ts` の `isHalfWidthCodePoint` にコメントで明記）。ギリシャ文字・キリル文字など East Asian Width 上は Narrow/Ambiguous に分類される文字も、この簡易判定では全角1扱いになる

## ファイル構成

```
mojikazu/
├── index.html      エントリ（title / description は一覧自動生成に使われる）
├── main.ts         UI・イベントハンドリング
├── count.ts         集計ロジック（DOM非依存の純関数）
├── count.test.ts    count.ts のテスト
├── styles.css       配色（theme 変数の override のみ）
└── og.tsx           OGP画像用の画面ミニチュア
```

集計ロジックを `count.ts` に純関数として分離しているのは、DOM を介さずテストできるようにするため。
