---
name: add-tool
description: tools リポジトリに新しいツールを追加するときの手順と、OGP 画像を自動生成させるための規約。「ツールを作る」「新しい PoC を足す」「OGP を出す」「og.tsx を書く」ときに使う。satori の制約と、踏み抜きやすい罠を収録している。
---

# ツールを追加する

`src/<appdir>/index.html` を作れば Vite が自動でエントリとして拾い、トップページの一覧にも OGP にも載る。一覧や `vite.config.ts` に手で登録する作業は無い。

## 最低限やること

`src/<appdir>/index.html` に `<title>` と `<meta name="description">` を書く。この 2 つが以下すべてのたねになる。

- トップページの一覧（`toolListPlugin`）
- `og:title` / `og:description`（`ogPlugin`）
- OGP 画像に描画される文字（`src/og/template.tsx`）

### description に使える文字の制約

OGP のフォントは Sawarabi Gothic の japanese サブセット 1 本だけで、**フォールバックフォントを積んでいない**。このサブセットが持たない漢字は OGP 画像で tofu (□) になる。

過去に「滲」で踏んだ。常用外の漢字を使ったら必ず `/og/` で目視確認すること。

### 太字は出せない

Sawarabi Gothic は weight 400 しか持たない。ブラウザは合成太字（synthetic bold）を作るのでサイト上では `font-bold` が効いて見えるが、**satori は合成太字を作らない**ので `fontWeight: 700` を書いても無視される。OGP で強弱を付けたいならサイズか色でやる。

## OGP に画面のミニチュアを載せる

`src/<appdir>/og.tsx` を置くと、OGP カードの右 60% にそのツールの画面ミニチュアが差し込まれる。置かなければテキストだけのカードになるので、**og.tsx は必須ではない**。

```tsx
export default function XxxOgPreview() {
  return <div style={{ display: 'flex', width: '100%', height: '100%' }}>...</div>;
}
```

### 書く前に実画面を見る

想像で書かない。dev サーバを起動して実際のツールを開き、操作して結果画面まで出してから、その特徴を抜き出す。ミニチュアは完全再現でなくてよく、「そのツールだと一目で分かる要素」だけでいい。

### satori の制約

og.tsx は satori（画像生成）とデモページ（ブラウザ描画）の両方で使われる。satori はブラウザの CSS をそのまま解釈しないので、以下を守る。

- **inline style のみ**。Tailwind class も CSS ファイルも効かない
- `display` は `flex` のみ。複数の子を持つ要素には必ず `display: 'flex'` と明示的な `flexDirection` を書く
- **使えないもの**: SVG フィルタ（feTurbulence 等）、`filter: blur()`、`backdrop-filter`、`mix-blend-mode`、grid
- **使えるもの**: `position: absolute` での重ね、`borderRadius`（4 隅バラバラの楕円指定も可）、`backgroundImage` の `radial-gradient`、`opacity`
- **外部 import を書けない**。og.tsx は data: URL 経由で読まれるため bare specifier を解決できない（後述）

ぼかしは `radial-gradient` の色停止位置（中心はベタ → 外側で急に透明へ抜く）＋低い `opacity` で近似する。`src/goteki/og.tsx` が実例。

### 見た目の落とし穴

- **背景色はカードと揃える**（`#fbfaf6`）。白にすると左のテキスト側との境目に段差が出て、枠線のように見える
- **preview 領域の端で図形が垂直に切れると「窓」に見える**。端に掛かる要素は内側に寄せる
- 濃い色を大きく置くと「滲み」ではなく「塊」に見える。淡くする

## 確認のしかた

1. `bun run dev` して `/og/` を開く。**左が React 描画、右が satori が生成した実物の PNG**。satori は React と描画が一致しないので、必ず右側で確認する
2. `bun run build` して `dist/og/<appdir>.png` を画像として開いて目視する。tofu が無いか、はみ出していないか、テキストと重なっていないか

`bun run build` が通っただけでは何も検証できていない。画像を目で見るまでが確認。

## 触るときに知っておくこと（実装の癖）

`vite.config.ts` の `ogPlugin` 周辺を触る場合のみ関係する。

- **og.tsx の読み込みに bun の .tsx native import は使えない**。`bun run dev` では動くが、`vite build` は rolldown 経由でプラグインを Node の ESM ローダー上で実行するため `ERR_UNKNOWN_FILE_EXTENSION` で落ちる。そのため dev/build 双方で `transformWithEsbuild` + `data:` URL に統一してある。og.tsx が外部 import を書けないのはこれが理由
- **satori の fonts に同じ family 名で複数登録しても 1 本しか使われない**。フォールバックを足すなら別の family 名で登録する必要がある（satori は他 family へ自動フォールバックする）
- カード一覧は `discoverOgCards()` が唯一のソース。dev middleware / build / デモページ / meta 注入がすべてこれを見ているので、ここを直せば 4 箇所すべてに効く
- `src/og/` はツールではないので `NON_TOOL_DIRS` で一覧から除外している
