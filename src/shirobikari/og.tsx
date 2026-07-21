// OGP カード用のミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
//
// 本体は CSS / HDR画像 / WebGPU の3手法で「白より明るい光」を並べて見せるツールだが、
// UI をそのまま縮小しても伝わらないため、ミニチュアは画面の再現をやめて「暗闇の中で
// 白い光源がまぶしく光っている」一枚絵だけを描く。一目で HDR・まぶしさの話だと分かればいい。
//
// カード側は暗系なので ogColors で外枠ごと上書きする（揃えないとカード中央で
// 背景色が切り替わって継ぎ目が出る）。styles.css で使っている shadcn dark テーマの
// 値に近い、少し暖色寄りのニュートラルにしてある。
export const ogColors = {
  background: '#0a0806',
  foreground: '#f7f3ea',
  primary: '#ffb066',
  mutedForeground: '#c2b8ab',
};

// 光源の中心。preview 領域は 720x630 で、右カラム内に収まるように置く。
const CENTER_X = 400;
const CENTER_Y = 300;

// ぼかしは filter: blur() が使えないため radial-gradient で近似するが、2つの罠を踏んだ:
// 1. 「中心はベタ色→外側で透明」という色停止を複数の円に分けて重ねると、円ごとの
//    塗りつぶし範囲の境目が同心円のリング（的当ての的）として見える
// 2. 1枚の円にまとめても、色停止の大部分を不透明（opacity 1）のまま白→暖色に
//    色相だけ変化させると、陰影のついた「球」（惑星）に見えてしまい光らない。
//    見た目が「玉」になるのは、色停止のほとんどが不透明のまま推移するから
// 対策: ごく小さい芯（白）だけを不透明にし、そこから先はすぐに alpha を落とし始めて
// 外側までなだらかに 0 へ近づける。alpha の下がり方を線形にすると縁が固く見えるため、
// 停止点を密に置いて減衰を減速させる（下に行くほど alpha の下がり幅を小さくする）。
// 円のサイズ自体は preview 領域の端を超えて大きく取るが、端に到達する時点で既に
// alpha がほぼ 0 になるよう距離を逆算してあるので、クリップされても「窓」に見えない
// （見える濃さの部分が端に掛からなければ、透明に近い裾野が切れても気付かれない）。
const GLOW_SIZE = 640;

function GlowLayers() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'absolute', width: '100%', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: CENTER_Y - GLOW_SIZE / 2,
          left: CENTER_X - GLOW_SIZE / 2,
          width: GLOW_SIZE,
          height: GLOW_SIZE,
          borderRadius: '50%',
          backgroundImage:
            'radial-gradient(circle, ' +
            '#ffffff 0%, ' +
            '#fff6e2 8%, ' +
            'rgba(255,224,166,0.85) 17%, ' +
            'rgba(255,193,122,0.55) 29%, ' +
            'rgba(255,157,82,0.3) 42%, ' +
            'rgba(255,157,82,0.12) 57%, ' +
            'rgba(255,157,82,0.03) 72%, ' +
            'rgba(255,157,82,0) 100%)',
        }}
      />
    </div>
  );
}

// 「輝度 1.0（白）を超える」ことを控えめに示す添え物。0→白のグラデーションバー本体
// (=SDRの上限) の少し先に、バーより明るい小さな光点を独立して置き、スケールが
// バーの外まで続いていることを暗示する。文字は使わない。
function BrightnessHint() {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', position: 'absolute', top: 562, left: 420 }}>
      <div
        style={{
          display: 'flex',
          width: 180,
          height: 12,
          borderRadius: 6,
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,0.04) 0%, #d8d2c6 55%, #ffffff 88%, #ffffff 100%)',
        }}
      />
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: -19,
          left: 185,
          width: 50,
          height: 50,
          opacity: 0.55,
          borderRadius: '50%',
          backgroundImage: 'radial-gradient(circle, #ffffff 0%, #ffffff 30%, #ffffff00 100%)',
        }}
      />
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: -3,
          left: 201,
          width: 18,
          height: 18,
          borderRadius: '50%',
          backgroundColor: '#ffffff',
        }}
      />
    </div>
  );
}

export default function ShirobikariOgPreview() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: ogColors.background,
        // 中心が暖色みを帯びたビネットで沈み込み、外周は素の背景色へ滑らかに戻る。
        // 別レイヤーの円と違って円のフチが可視化されない（外周色 = コンテナ背景色）ため、
        // 端で切れて「窓」に見える心配がない
        backgroundImage: `radial-gradient(circle at ${CENTER_X}px ${CENTER_Y}px, #2b1a0f 0%, ${ogColors.background} 62%)`,
        overflow: 'hidden',
      }}
    >
      <GlowLayers />
      <BrightnessHint />
    </div>
  );
}
