// OGP カード用の画面ミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の App.tsx は変更しない）。
// 実物は罫線付き textarea に検知句を赤の波下線で表示するが、satori は
// text-decoration-style: wavy を解釈しないため、検知句をベタ塗りの下線バーで代替する
const LINES = [
  ['本記事では、', '最新のAI活用', 'について解説します。'],
  ['業務効率化のために', 'AIを活用', 'する企業が増えています。'],
  ['その重要な役割から', '注目を集めています', '。'],
];

function TextLine({ segments }: { segments: string[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', width: '100%' }}>
      {segments.map((segment, i) => (
        <span
          key={`${segment}-${i}`}
          style={{
            display: 'flex',
            fontSize: 15,
            color: '#1f1b16',
            // 偶数インデックスが検知句。赤の下線バーで「波下線ハイライト」を代替する
            borderBottom: i % 2 === 1 ? '3px solid #c73e2e' : 'none',
          }}
        >
          {segment}
        </span>
      ))}
    </div>
  );
}

export default function UsupperaOgPreview() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#fbfaf6',
        padding: 28,
        position: 'relative',
      }}
    >
      <span style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: '#1f1b16' }}>
        薄っぺらな戯
      </span>

      {/* 罫線付きテキストエリア相当。行間に薄緑の罫線を敷く */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          marginTop: 20,
          width: '100%',
          padding: '4px 0',
        }}
      >
        {LINES.map((segments, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              borderBottom: '1px solid rgba(143,168,138,0.5)',
              paddingBottom: 10,
            }}
          >
            <TextLine segments={segments} />
          </div>
        ))}
      </div>

      {/* ランクスタンプ相当。右下に赤の二重丸でランク文字を置く */}
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          right: 28,
          bottom: 28,
          width: 92,
          height: 92,
          borderRadius: 46,
          // satori は `border: <width> double <color>` の一括指定を解釈しないため個別指定にする
          borderStyle: 'double',
          borderWidth: 4,
          borderColor: '#c73e2e',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ display: 'flex', fontSize: 40, fontWeight: 700, color: '#c73e2e' }}>
          D
        </span>
      </div>
    </div>
  );
}
