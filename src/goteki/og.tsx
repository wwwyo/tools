// OGP カード用の画面ミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
// 実装は Canvas から抽出した使用色を並べる UI だが、ここでは「それらしさ」だけを抜き出し、
// サンプル画像の夕焼け（オレンジ/金/紺/黒）と色リストの帯を再現する
const SAMPLE_COLORS = ['#ff8c69', '#ffd27a', '#1e3a5f', '#fff2b2', '#141414'];

export default function GotekiOgPreview() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: '#ffffff',
        padding: 28,
      }}
    >
      <span style={{ display: 'flex', fontSize: 30, fontWeight: 700, color: '#1f1b16' }}>
        五滴
      </span>
      <span style={{ display: 'flex', fontSize: 18, color: '#7a7367', marginTop: 6 }}>
        使用色を五滴抽出
      </span>

      {/* サンプル画像プレビュー相当。夕焼け（空 2 段 + 海）を単純な帯で再現する */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          marginTop: 20,
          width: '100%',
          height: 180,
          borderRadius: 6,
          overflow: 'hidden',
          border: '2px solid rgba(140,133,123,0.35)',
        }}
      >
        <div style={{ display: 'flex', width: '100%', height: 72, backgroundColor: '#ff8c69' }} />
        <div style={{ display: 'flex', width: '100%', height: 44, backgroundColor: '#ffd27a' }} />
        <div style={{ display: 'flex', width: '100%', height: 64, backgroundColor: '#1e3a5f' }} />
      </div>

      {/* 使用色 top5 の色リスト相当。スウォッチだけ横に並べる */}
      <div style={{ display: 'flex', flexDirection: 'row', gap: 12, marginTop: 24 }}>
        {SAMPLE_COLORS.map((hex) => (
          <div
            key={hex}
            style={{
              display: 'flex',
              width: 56,
              height: 56,
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
