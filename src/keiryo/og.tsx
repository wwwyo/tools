// OGP カード用の画面ミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
//
// 本体（src/keiryo/main.ts）は「サムネイル＋検品テーブル」のカードの下に、拡張子ごとの
// 圧縮結果を横棒付きの一覧（梯子）で並べる。ミニチュアはそのうち一目でツールと分かる
// 「梯子」側だけを抜き出して再現する。
type LadderRow = {
  label: string;
  barPercent: number;
};

// 実物は「元ファイル / JPEG / WebP / AVIF / PNG」の5段。バー幅は実物同様、
// 非可逆形式ほど短く、可逆の PNG は元ファイルに次いで長い比率バーを模す
const LADDER_ROWS: LadderRow[] = [
  { label: '元ファイル', barPercent: 100 },
  { label: 'JPEG', barPercent: 42 },
  { label: 'WebP', barPercent: 34 },
  { label: 'AVIF', barPercent: 22 },
  { label: 'PNG', barPercent: 88 },
];

function ThumbnailBox() {
  return (
    <div
      style={{
        display: 'flex',
        width: 96,
        height: 72,
        borderRadius: 6,
        border: '1px solid rgba(140,133,123,0.35)',
        backgroundColor: '#eee6d8',
        flexShrink: 0,
      }}
    />
  );
}

function LadderRowView({ row }: { row: LadderRow }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        gap: 14,
        padding: '8px 14px',
        borderRadius: 6,
        border: '1px solid rgba(140,133,123,0.35)',
        backgroundColor: '#fff',
      }}
    >
      <div style={{ display: 'flex', width: 84, fontSize: 14, fontWeight: 600, color: '#1f1b16' }}>
        {row.label}
      </div>
      <div
        style={{
          display: 'flex',
          flex: 1,
          height: 8,
          borderRadius: 4,
          backgroundColor: 'rgba(140,133,123,0.16)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: `${row.barPercent}%`,
            height: '100%',
            borderRadius: 4,
            backgroundColor: '#c73e2e',
          }}
        />
      </div>
    </div>
  );
}

export default function KeiryoOgPreview() {
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
        gap: 16,
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 16,
          padding: 14,
          borderRadius: 6,
          border: '1px solid rgba(140,133,123,0.35)',
          backgroundColor: '#fff',
        }}
      >
        <ThumbnailBox />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', width: 220, height: 10, borderRadius: 3, backgroundColor: 'rgba(140,133,123,0.25)' }} />
          <div style={{ display: 'flex', width: 160, height: 10, borderRadius: 3, backgroundColor: 'rgba(140,133,123,0.25)' }} />
          <div style={{ display: 'flex', width: 190, height: 10, borderRadius: 3, backgroundColor: 'rgba(140,133,123,0.25)' }} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {LADDER_ROWS.map((row) => (
          <LadderRowView key={row.label} row={row} />
        ))}
      </div>
    </div>
  );
}
