# シロビカリ改修計画: SDR→HDR 変換ツール化

## ゴール

- シロビカリを「SDR 画像を受け取って HDR に変換するツール」専用にする
- 現在の説明形式コンテンツ（4 セクションのデモ）は disclosure（`<details>`）に格納して残す

## 出力形式の選定

**UltraHDR JPEG（gain map 付き JPEG）を採用する。**

- 理由:
  - SDR 環境では普通の JPEG として表示される graceful degradation がある（HDR PNG は非対応環境で色が破綻しうる）
  - Chrome / Edge / Android / macOS の写真アプリなど実利用先が広い
  - 既存デモ（dynamic-range-limit セクション）が UltraHDR JPEG を使っており、プレビューにそのまま `dynamic-range-limit: no-limit` が使える
- カウンターファクト:
  - HDR PNG（cICP: Rec.2020+PQ）案: エンコードは PNG チャンク挿入で簡単だが、表示対応が Chrome 系に限られ、SDR 環境でのフォールバックがない
  - libultrahdr-wasm 等の npm 依存案: wasm バンドルが重く、supply chain 管理も増える。UltraHDR コンテナは手組みで ~200-300 行で書けるため依存不要

## 変換パイプライン（すべてページ内 JS、外部 API なし）

1. 入力: file input + drag&drop（JPEG/PNG/WebP）。`createImageBitmap` → canvas → `getImageData`
   - 長辺 4096px にキャップ。アルファは白背景に flatten
2. gain map 合成: 画素ごとに輝度を計算し、ハイライトほど持ち上げるゲインカーブを適用
   - パラメータ（スライダー）:
     - ヘッドルーム（最大ゲイン、stop 単位。1〜4 stop、既定 2）
     - しきい値/カーブ（どの明るさから持ち上げるか。全体一様 ⇔ ハイライトのみ）
   - gain map は 1/4 解像度のグレースケール。値 = `log2(gain) / GainMapMax` を [0,255] に正規化
3. エンコード: `canvas.toBlob("image/jpeg")` でベース JPEG とゲインマップ JPEG を生成
4. コンテナ組み立て（`ultrahdr.ts` に手組み実装）:
   - プライマリ JPEG に XMP（`hdrgm:Version`, `Container:Directory`）と MPF (APP2) を挿入
   - ゲインマップ JPEG に XMP（`hdrgm:GainMapMax`, `GainMapMin`, `Gamma`, `OffsetSDR/HDR`, `HDRCapacityMax` 等）を挿入
   - MPF のオフセット計算（基点は MPF エンディアンマーカー直後）に注意
5. 出力: Blob URL でプレビュー + ダウンロードボタン

## UI 構成（新 main.ts）

```
h1 シロビカリ — SDR 画像を HDR に変換
├─ サポート状況（既存の support-list を流用: HDRディスプレイ / dynamic-range-limit）
├─ ドロップゾーン（file input 兼用）
├─ パラメータ: ヘッドルーム / カーブのスライダー（変更で再変換、debounce）
├─ プレビュー: 元画像（standard 固定） vs 変換後（no-limit）の並置
│   └─ dynamic-range-limit 非対応ブラウザには注意書き
├─ ダウンロードボタン（<name>-hdr.jpg）
└─ <details> HDR が明るく見える仕組み（解説）
    └─ 既存 4 セクション（dynamic-range-limit / HDR PNG / WebGPU ランプ / 単色比較）
```

## ファイル分割

現 main.ts（748 行）は肥大するので分割:

- `main.ts` — エントリ。コンバータ UI + disclosure の組み立て
- `convert.ts` — 画像読み込み・ゲインカーブ・gain map 合成（純関数中心）
- `ultrahdr.ts` — UltraHDR JPEG コンテナ組み立て（XMP/MPF バイナリ生成）
- `demos.ts` — 既存の説明デモ（WebGPU レンダラー 2 クラス + 初期化）を移設
  - WebGPU 初期化は `<details>` の初回 `toggle` 時に遅延実行（閉じたままなら GPU を触らない）
- `index.html` — title/description を変換ツールの説明に更新
- `og.tsx` — 変換ツールのミニチュアに更新（add-tool skill の規約に従う）

## 検証

1. `bun run typecheck`
2. `bun run dev` + ブラウザ（Chrome）で:
   - 手元の SDR 画像（goteki の sample 等）をドロップ → 変換後プレビューが no-limit で明るく光る
   - ダウンロードした JPEG を再度ページにドロップ or Chrome で開いて HDR 表示されること
   - disclosure を開くと既存デモが従来どおり動く（WebGPU 遅延初期化）
   - disclosure 閉状態で console エラーなし
3. `bun run build` が通る

## リスクと逃げ道

- MPF/XMP の手組みが最大の不確実性。Chrome の UltraHDR デコーダは比較的寛容だが、
  オフセット計算ミスで gain map が無視される（= 変換後も明るくならない）失敗モードがある。
  デバッグは「MDN の ultra-hdr.jpg のバイト構造と自分の出力を比較」で行う
- 万一手組みが難航したら、フォールバックとして HDR PNG（cICP チャンク挿入 + PQ 16bit）に切り替える
  （エンコードは CompressionStream で依存ゼロのまま可能）
