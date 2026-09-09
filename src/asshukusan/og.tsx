// OGP カード用の画面ミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
//
// 本体はノードフローだが、1200×630 の右 60% に 5 ノードを横に並べると小さすぎて何のツールか
// 読めない。OGP では「工程を経るごとにバイト数が減る」ことだけを伝えればよいので、
// 工程を縦に積んだ棒グラフに置き換え、最終行に削減率を大きく出す。
type StageRow = {
  label: string;
  bytes: string;
  /** 元画像を 1 としたバイト数の比率。棒の長さに使う */
  ratio: number;
};

// 実写 2.4 MB を長辺 1600px の WebP にしたときの典型的な推移
const STAGE_ROWS: StageRow[] = [
  { label: '元画像', bytes: '2.4 MB', ratio: 1 },
  { label: 'サイズ', bytes: '640 KB', ratio: 0.27 },
  { label: 'フォーマット', bytes: '210 KB', ratio: 0.09 },
  { label: 'メタデータ', bytes: '196 KB', ratio: 0.08 },
];

// U+2212（−）は Sawarabi Gothic の japanese サブセットに無く消えるため ASCII のハイフンを使う
const OUTPUT = { bytes: '196 KB', delta: '-92%' };

const LABEL_WIDTH = 126;
const BYTES_WIDTH = 78;
const BAR_TRACK_WIDTH = 314;

function StageBar({ row }: { row: StageRow }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', height: 44 }}>
      <div style={{ display: 'flex', width: LABEL_WIDTH, fontSize: 18, color: '#1f1b16' }}>{row.label}</div>
      <div
        style={{
          display: 'flex',
          width: BAR_TRACK_WIDTH,
          height: 14,
          borderRadius: 7,
          backgroundColor: 'rgba(140,133,123,0.18)',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: Math.max(10, Math.round(BAR_TRACK_WIDTH * row.ratio)),
            height: 14,
            borderRadius: 7,
            backgroundColor: '#c73e2e',
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          width: BYTES_WIDTH,
          justifyContent: 'flex-end',
          fontSize: 17,
          color: '#7a7367',
        }}
      >
        {row.bytes}
      </div>
    </div>
  );
}

export default function AsshukusanOgPreview() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        // カード側と同じ紙色。白にするとテキスト側との境目に段差が出て枠線のように見えてしまう
        backgroundColor: '#fbfaf6',
        padding: 40,
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: '22px 26px',
          borderRadius: 8,
          border: '1px solid rgba(140,133,123,0.35)',
          backgroundColor: '#ffffff',
        }}
      >
        {STAGE_ROWS.map((row) => (
          <StageBar key={row.label} row={row} />
        ))}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 10,
            paddingTop: 14,
            borderTop: '1px solid rgba(140,133,123,0.35)',
          }}
        >
          <div style={{ display: 'flex', width: LABEL_WIDTH, fontSize: 18, color: '#1f1b16' }}>出力</div>
          <div style={{ display: 'flex', fontSize: 30, color: '#1f1b16' }}>{OUTPUT.bytes}</div>
          <div style={{ display: 'flex', marginLeft: 18, fontSize: 30, color: '#c73e2e' }}>{OUTPUT.delta}</div>
        </div>
      </div>
    </div>
  );
}
