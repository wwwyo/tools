# シロビカリ（shirobikari）

画像をめっちゃ光らせる変換をするツール。SDR 画像を HDR JPEG に変換し、HDR 対応ディスプレイでは通常の「白」より明るく光る写真としてダウンロードできる。HDR 非対応の環境では普通の JPEG として表示される（graceful degradation）。

出力は 2 形式:

- **PQ JPEG（デフォルト）**: 画素値そのものを PQ で符号化し ICC プロファイル（Rec.2020 + PQ 転送関数）を付けた JPEG。HDR かどうかの情報が画素と ICC という JPEG の本体に埋め込まれているため、X などアップロード時にメタデータ（XMP/MPF）を剥がして再エンコードするサービスでも HDR 表示が生き残る
- **UltraHDR JPEG（副形式）**: 普通の JPEG に持ち上げ量を記録したメタデータを載せる方式。非対応環境では普通の JPEG として壊れずに表示される共有向け

## 使い方

- 画像（JPEG / PNG / WebP）をドラッグ&ドロップ / クリックで選択
- スライダーで「明るさ（2〜16倍）」と「光らせる範囲（画像全体 ⇔ 明るい部分だけ）」を調整
- プレビューと「ダウンロード（PQ）」ボタンは PQ JPEG。「UltraHDR でダウンロード」ボタンは副形式で、クリック時にその場で組み立てる
- プレビューは元画像（`dynamic-range-limit: standard` 固定）と変換後（`no-limit`）の並置
- 変換はすべてページ内 JS で完結し、画像は外部に送信しない
- 「HDR が明るく見える仕組み」の解説（CSS / HDR 画像 / WebGPU で輝度差を見比べるデモ）は
  [blog 記事](https://wwwyo.dev/blog/why-hdr-looks-brighter/)へ移設した。ページ末尾には移設先へのリンクのみ置く

## PQ JPEG とは（pqjpeg.ts）

画素ごとに sRGB→線形→（UltraHDR と同じゲインカーブで）ゲインを乗算→ sRGB primaries を Display P3 primaries に変換→ PQ (ST 2084) で符号化した JPEG。相対輝度 1.0（SDR の白）を **203 cd/m²**（BT.2408 の SDR 基準輝度）として絶対輝度に換算してから PQ 逆 EOTF（10000 nits 正規化）にかける。これにより 1.0 stop のヘッドルームなら 2×203=406 nits まで明るさを表現できる。長辺が **3000px** を超える場合は PQ 符号化の直前に canvas でリサイズする（X の HDR 表示が生き残る成功レシピが「長辺 3000px 以下」を条件にしているため。読み込み時キャップの 4096px より小さい）。

ICC プロファイルは `p3pq-icc.ts` の `buildP3PqIccProfile()` で実行時に clean-room 生成する（matrix/TRC 型 + `cicp` タグ [12, 16, 0, 1] = Display P3 色域 + PQ 転送関数）。以前は同梱の `hdr.png` の iCCP チャンクから LUT 型（A2B0/B2A0）の Rec.2020 + PQ プロファイルを抽出して埋め込んでいたが、**X へ投稿すると再エンコードパイプラインで LUT 型 ICC ごと脱落し HDR 表示が壊れる**ことが確認できたため、X を生き残った実績のある matrix/TRC + cicp 構成に作り替えた。`cicp` を解釈するデコーダ（Chrome / X 系）は TRC を無視して cicp で HDR 解釈するため実害はないが、cicp を見ず ICC の TRC しか解釈しない古いデコーダでは SDR 基準白 203 nits 以上が意図的に白飛びする（graceful degradation）。UltraHDR と違い、HDR かどうかの情報がメタデータではなく画素そのものなので、再エンコードで XMP/MPF が失われても壊れない。

## UltraHDR JPEG とは

普通の JPEG（ベース画像）に「どの画素をどれだけ持ち上げるか」を記録したグレースケール画像（ゲインマップ）を同梱した形式。HDR 対応ビューアは `ベース画像 × ゲインマップ` で明るさを復元し、非対応ビューアはメタデータを無視してベース JPEG だけを表示する。これが非対応環境でも壊れない理由。ただしこの「メタデータで明るさを表現する」設計そのものが、メタデータを剥がす再エンコードに弱い原因でもある。

## 変換パイプライン

1. **読み込み（convert.ts）**: `createImageBitmap` → canvas → `getImageData`。長辺 4096px にキャップ、アルファは白背景に flatten。この ImageData は PQ 再変換用に main.ts の state にもキャッシュする
2. **ゲインマップ合成（convert.ts）**: 画素ごとに sRGB→線形（256 要素 LUT）→ Rec.709 係数で輝度を計算し、1/4 解像度に平均。ゲインは `1 + (maxGain - 1) * ((1 - curve) + curve * smoothstep(threshold, 1, luma))` で、curve=0 なら一様、curve=1 ならハイライトのみ持ち上がる。輝度マップとベース JPEG はスライダーに依存しないため画像ロード時に1回だけ計算してキャッシュし、スライダー変更時はゲイン計算だけやり直す（LUT と `gainAt` は pqjpeg.ts でも再利用する）
3-a. **PQ JPEG 生成（pqjpeg.ts）**: 長辺が 3000px を超える場合は canvas でリサイズしたうえで、フル解像度で画素ごとにゲイン適用 → primaries 変換（sRGB→Display P3）→ PQ 符号化し、canvas 経由で JPEG エンコードした後に APP2 `ICC_PROFILE` セグメントを挿入する。ICC は `p3pq-icc.ts` の `buildP3PqIccProfile()` が clean-room 生成する（matrix/TRC + cicp [12,16,0,1]）。ダウンサンプルしたゲインマップは使わず、画素ごとの輝度からその場でゲインを計算する（スライダー変更のたびにフル解像度を再計算するのはこのため）
3-b. **UltraHDR コンテナ組み立て（ultrahdr.ts）**: ベース JPEG とゲインマップ JPEG のバイト列に XMP（`hdrgm` メタデータ + `Container:Directory`）と MPF（APP2）を挿入して連結する。依存ライブラリなし・ブラウザ API 非依存（入出力は Uint8Array）なので bun で単体検証できる。副形式なので main.ts はこの結果をキャッシュせず、ボタン押下のたびに組み立てる
4. **ダウンロード（main.ts）**: Blob URL + `<a download>`

### MPF オフセットの罠

MPF の Individual Image Offset の基点は**ファイル先頭ではなく MP Endian フィールド（TIFF ヘッダ先頭）**（CIPA DC-007）。mdn/shared-assets の ultra-hdr.jpg を再パースすると確認できる。XMP の `Item:Length` と MPF の size/offset は「メタデータ挿入後の最終バイト長」を指す必要があるため、ゲインマップ側を先に確定させてからベース側のメタデータを組む。

## HDR の白（ブランドアクセント）

タイトルとダウンロードボタンは HDR の白で表示する。CSS には HDR 色を直接指定する構文がまだ無いため（Chrome 148 時点で `color(rec2100-pq …)` は未対応）、同梱の hdr.png（Rec.2020 + PQ の白一色 PNG）を `background-clip: text` / `border-image` + `dynamic-range-limit: no-limit` で使う。SDR 環境では普通の白として見える。

- `background-clip: text` は背景色もクリップするため、ボタンのホバーは背景色変化ではなく opacity で表現している
- `border-image` には `border-radius` が効かないため、ボタンの角は直角

## ファイル構成

```
shirobikari/
├── index.html     エントリ（title / description は一覧・OGP 自動生成に使われる）
├── main.ts        コンバータ UI・イベント配線・状態管理
├── convert.ts     画像読み込み・輝度マップ・ゲインマップ合成
├── pqjpeg.ts      PQ JPEG 生成（画素の PQ 符号化 + ICC プロファイル埋め込み）。デフォルト出力
├── p3pq-icc.ts    P3 PQ の ICC v4 プロファイル生成（matrix/TRC + cicp、clean-room）。pqjpeg.ts が使う
├── ultrahdr.ts    UltraHDR JPEG コンテナ組み立て（XMP / MPF のバイナリ生成）。副形式
├── support.ts     サポート状況表示の共有ロジック（HDR ディスプレイ検出 / dynamic-range-limit 対応判定）
└── hdr.png        HDR の白一色 PNG（ブランドアクセント用。PQ JPEG の ICC はもう抽出しない）
```
