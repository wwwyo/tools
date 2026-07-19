// OGP カード用の画面ミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
//
// 本体 (src/goteki/main.ts の renderBlobs) は抽出色を SVG フィルタ (feTurbulence +
// feDisplacementMap) で縁を滲ませた「白い紙に滲んだインク」として画面に散らす。satori は
// SVG フィルタ・filter: blur()・backdrop-filter のいずれも解釈しないため、縁のぼけは
// radial-gradient の色停止位置（中心はベタ、外側で急に透明へ抜ける）で近似する。
// サンプル画像（夕焼け）から抽出した色を使う: #141414 / #ff8c69 / #ffd27a / #fff2b2 / #dfbb72
type InkBlob = {
  hex: string;
  size: number;
  top: string;
  left: string;
  opacity: number;
  // 円のままだと人工的に見えるため、4 隅の半径をずらして不規則な染みの輪郭にする
  borderRadius: string;
};

// 本体の滲みは紙にうっすら広がる淡さなので、opacity は低め・サイズは大きめに取り、
// 縁は 30% 付近から抜き始めて広くぼかす。濃い #141414 を大きく置くと灰色の塊に見えて
// インクにならないため、暖色を主役にして黒はごく小さく添えるだけにする
const INK_BLOBS: InkBlob[] = [
  { hex: '#ff8c69', size: 460, top: '6%', left: '6%', opacity: 0.42, borderRadius: '58% 42% 47% 53% / 41% 55% 45% 59%' },
  { hex: '#ffd27a', size: 340, top: '-12%', left: '34%', opacity: 0.4, borderRadius: '60% 40% 55% 45% / 45% 60% 40% 55%' },
  { hex: '#dfbb72', size: 300, top: '46%', left: '54%', opacity: 0.34, borderRadius: '46% 54% 40% 60% / 55% 46% 54% 45%' },
  { hex: '#fff2b2', size: 420, top: '58%', left: '12%', opacity: 0.5, borderRadius: '44% 56% 50% 50% / 58% 44% 56% 42%' },
  { hex: '#141414', size: 150, top: '20%', left: '74%', opacity: 0.16, borderRadius: '42% 58% 61% 39% / 46% 40% 60% 54%' },
];

const SAMPLE_COLORS = ['#141414', '#ff8c69', '#ffd27a', '#fff2b2', '#dfbb72'];

function InkLayer() {
  return (
    <div style={{ display: 'flex', position: 'absolute', width: '100%', height: '100%' }}>
      {INK_BLOBS.map((blob) => (
        <div
          key={`${blob.hex}-${blob.top}-${blob.left}`}
          style={{
            display: 'flex',
            position: 'absolute',
            top: blob.top,
            left: blob.left,
            width: blob.size,
            height: blob.size,
            opacity: blob.opacity,
            borderRadius: blob.borderRadius,
            backgroundImage: `radial-gradient(circle, ${blob.hex} 0%, ${blob.hex} 30%, ${blob.hex}00 72%)`,
          }}
        />
      ))}
    </div>
  );
}

export default function GotekiOgPreview() {
  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: '100%',
        height: '100%',
        // カード側と同じ紙色。白にするとテキスト側との境目に段差が出て、消したはずの
        // 枠線と同じように見えてしまう
        backgroundColor: '#fbfaf6',
        overflow: 'hidden',
      }}
    >
      <InkLayer />

      {/* 抽出結果らしさが伝わる要素として、使用色 top5 のスウォッチを右下にまとめて残す。
          下敷きは敷かない（枠に見えるうえ、カード右端で見切れて汚くなる） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          position: 'absolute',
          right: 56,
          bottom: 56,
          gap: 16,
        }}
      >
        {SAMPLE_COLORS.map((hex) => (
          <div
            key={hex}
            style={{
              display: 'flex',
              width: 48,
              height: 48,
              borderRadius: 6,
              backgroundColor: hex,
              border: '2px solid rgba(140,133,123,0.35)',
            }}
          />
        ))}
      </div>
    </div>
  );
}
