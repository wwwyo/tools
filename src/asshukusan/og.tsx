// OGP カード用のミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
//
// 工程や数値は載せず「大きな写真が小さくなる」絵だけで圧縮を表す。
// 写真は sky / ground の 2 段グラデーションと太陽の丸で記号化する。

type PhotoSize = { width: number; height: number; radius: number };

const BEFORE: PhotoSize = { width: 330, height: 220, radius: 10 };
const AFTER: PhotoSize = { width: 132, height: 88, radius: 6 };

function Photo({ size }: { size: PhotoSize }) {
  const sunSize = Math.round(size.height * 0.2);
  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: size.width,
        height: size.height,
        borderRadius: size.radius,
        border: '1px solid rgba(140,133,123,0.35)',
        backgroundImage: 'linear-gradient(180deg, #cfe3f2 0%, #e9f1f7 62%, #8fae66 62%, #6d9150 100%)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: Math.round(size.height * 0.16),
          left: Math.round(size.width * 0.68),
          width: sunSize,
          height: sunSize,
          borderRadius: sunSize,
          backgroundColor: '#f6e7a8',
        }}
      />
    </div>
  );
}

// 矢印の字形は Sawarabi Gothic の japanese サブセットに無く、border の三角形も satori は
// 矩形に描いてしまうため、線を太→細に段階で細らせて「絞られていく」向きを表す
function Squeeze() {
  const widths = [10, 7, 4];
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', margin: '0 22px' }}>
      {widths.map((w, i) => (
        <div
          key={w}
          style={{
            display: 'flex',
            width: 22,
            height: w,
            borderRadius: w,
            marginLeft: i === 0 ? 0 : 8,
            backgroundColor: '#c73e2e',
          }}
        />
      ))}
    </div>
  );
}

export default function AsshukusanOgPreview() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        // カード側と同じ紙色。白にするとテキスト側との境目に段差が出て枠線のように見えてしまう
        backgroundColor: '#fbfaf6',
        padding: 40,
      }}
    >
      <Photo size={BEFORE} />
      <Squeeze />
      <Photo size={AFTER} />
    </div>
  );
}
