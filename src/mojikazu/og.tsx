// OGP カード用の画面ミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
//
// 本体（textarea + 文字数の大きな数字 + 原稿用紙風の罫線）の特徴を抜き出し、
// 大きな数字と、罫線入りの枡目（textarea の原稿用紙風背景）のミニチュアを描く。

const SAMPLE_TEXT = ["文字数を", "数えます"];

/** textarea の原稿用紙風罫線を模した枡目グリッド */
function ManuscriptGrid() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 320,
        borderRadius: 8,
        border: '2px solid rgba(61,90,76,0.35)',
        backgroundColor: '#ffffff',
        overflow: 'hidden',
      }}
    >
      {SAMPLE_TEXT.map((line, rowIndex) => (
        <div
          key={line}
          style={{
            display: 'flex',
            flexDirection: 'row',
            borderTop: rowIndex === 0 ? 'none' : '1px solid rgba(61,90,76,0.2)',
          }}
        >
          {line.split('').map((char, colIndex) => (
            <div
              key={`${rowIndex}-${colIndex}-${char}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 80,
                height: 70,
                borderLeft: colIndex === 0 ? 'none' : '1px solid rgba(61,90,76,0.2)',
                fontSize: 32,
                color: '#2b2a26',
              }}
            >
              {char}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function MojikazuOgPreview() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 48,
        width: '100%',
        height: '100%',
        backgroundColor: '#fbfaf6',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
        }}
      >
        <div style={{ display: 'flex', fontSize: 28, color: '#6b6a63' }}>文字数</div>
        <div style={{ display: 'flex', fontSize: 140, lineHeight: 1, color: '#3d5a4c' }}>8</div>
      </div>
      <ManuscriptGrid />
    </div>
  );
}
