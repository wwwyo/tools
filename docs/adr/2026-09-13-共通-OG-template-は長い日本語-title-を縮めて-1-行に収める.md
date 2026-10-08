# 共通 OG template は長い日本語 title を縮めて 1 行に収める

- Status: Accepted
- Date: 2026-09-13

[#25](https://github.com/wwwyo/tools/pull/25)（文字数カウンター）。7 文字の title が左カラムで「文字数カウン / ター」と語中で折れた。日本語は単語境界が無いので折り返し位置を制御できず、title を短くする（ツール側の都合を template に合わせる）のでなく template 側で幅に収まるまで文字サイズを落とす。ツール本体の textarea は罫線を外し `field-sizing: content` で内容に追従させた（rows 固定は空のとき大きすぎ、長文で足りない）
