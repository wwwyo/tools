# シロビカリ（shirobikari）

画像をめっちゃ光らせる変換をするツール。SDR 画像を UltraHDR JPEG に変換し、HDR 対応ディスプレイでは通常の「白」より明るく光る写真としてダウンロードできる。HDR 非対応の環境では普通の JPEG として表示される（graceful degradation）。

## 使い方

- 画像（JPEG / PNG / WebP）をドラッグ&ドロップ / クリックで選択
- スライダーで「明るさ（2〜16倍）」と「光らせる範囲（画像全体 ⇔ 明るい部分だけ）」を調整
- プレビューは元画像（`dynamic-range-limit: standard` 固定）と変換後（`no-limit`）の並置
- 変換はすべてページ内 JS で完結し、画像は外部に送信しない
- ページ末尾の disclosure「HDR が明るく見える仕組み」に、CSS / HDR 画像 / WebGPU で輝度差を見比べる解説デモがある（WebGPU は初回 open 時に遅延初期化）

## UltraHDR JPEG とは

普通の JPEG（ベース画像）に「どの画素をどれだけ持ち上げるか」を記録したグレースケール画像（ゲインマップ）を同梱した形式。HDR 対応ビューアは `ベース画像 × ゲインマップ` で明るさを復元し、非対応ビューアはメタデータを無視してベース JPEG だけを表示する。これが非対応環境でも壊れない理由。

## 変換パイプライン

1. **読み込み（convert.ts）**: `createImageBitmap` → canvas → `getImageData`。長辺 4096px にキャップ、アルファは白背景に flatten
2. **ゲインマップ合成（convert.ts）**: 画素ごとに sRGB→線形（256 要素 LUT）→ Rec.709 係数で輝度を計算し、1/4 解像度に平均。ゲインは `1 + (maxGain - 1) * ((1 - curve) + curve * smoothstep(threshold, 1, luma))` で、curve=0 なら一様、curve=1 ならハイライトのみ持ち上がる。輝度マップとベース JPEG はスライダーに依存しないため画像ロード時に1回だけ計算してキャッシュし、スライダー変更時はゲイン計算だけやり直す
3. **コンテナ組み立て（ultrahdr.ts）**: ベース JPEG とゲインマップ JPEG のバイト列に XMP（`hdrgm` メタデータ + `Container:Directory`）と MPF（APP2）を挿入して連結する。依存ライブラリなし・ブラウザ API 非依存（入出力は Uint8Array）なので bun で単体検証できる
4. **ダウンロード（main.ts）**: Blob URL + `<a download>`

### MPF オフセットの罠

MPF の Individual Image Offset の基点は**ファイル先頭ではなく MP Endian フィールド（TIFF ヘッダ先頭）**（CIPA DC-007）。mdn/shared-assets の ultra-hdr.jpg（同梱）を再パースすると確認できる。XMP の `Item:Length` と MPF の size/offset は「メタデータ挿入後の最終バイト長」を指す必要があるため、ゲインマップ側を先に確定させてからベース側のメタデータを組む。

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
├── ultrahdr.ts    UltraHDR JPEG コンテナ組み立て（XMP / MPF のバイナリ生成）
├── demos.ts       解説デモ（dynamic-range-limit / HDR PNG / WebGPU）
├── hdr.png        HDR の白一色 PNG（解説デモ + ブランドアクセントに使用）
└── ultra-hdr.jpg  UltraHDR サンプル（mdn/shared-assets 由来。解説デモに使用）
```
