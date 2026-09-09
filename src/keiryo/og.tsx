// OGP カード用の画面ミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
//
// 本体（src/keiryo/main.ts）は「元画像 → サイズ → フォーマット → メタデータ → 出力」の
// 5ノードをポート付きのカードとして横に並べ、曲線のエッジで繋ぐノードフローエディタ風の
// キャンバスを見せる。ミニチュアはヘッダー帯・ポート・エッジの太さという構造だけを
// 抜き出して再現する（値の意味までは持たせない）。
type PipelineNode = {
  label: string;
};

// 実物はエッジの太さがバイト数（元画像比）に比例して段を追うごとに細くなる。
// ミニチュアでは同じ見た目を素の px 値で再現する（4本のエッジ = 5ノード間）
const PIPELINE_NODES: PipelineNode[] = [
  { label: '元画像' },
  { label: 'サイズ' },
  { label: 'フォーマット' },
  { label: 'メタデータ' },
  { label: '出力' },
];

const EDGE_WIDTHS = [5, 3.5, 2.5, 1.5];

// ノード間を繋ぐ直線 + 太さで表現するエッジ。本体は曲線ベジェだが、
// satori は矩形しか安定して描けないため、太さの変化だけを縮小して見せる
function Edge({ width }: { width: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', width: 18, height: width, borderRadius: width, backgroundColor: '#c73e2e', opacity: 0.7 }} />
    </div>
  );
}

function Port() {
  return (
    <div
      style={{
        display: 'flex',
        width: 8,
        height: 8,
        borderRadius: 4,
        border: '2px solid #c73e2e',
        backgroundColor: '#fbfaf6',
      }}
    />
  );
}

function PipelineNodeBox({ node, isFirst, isLast }: { node: PipelineNode; isFirst: boolean; isLast: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 108,
        flexShrink: 0,
        borderRadius: 6,
        border: '1px solid rgba(140,133,123,0.35)',
        backgroundColor: '#fff',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          padding: '8px 8px',
          backgroundColor: 'rgba(140,133,123,0.16)',
          fontSize: 14,
          color: '#1f1b16',
        }}
      >
        {node.label}
      </div>
      <div style={{ display: 'flex', padding: '10px 8px', justifyContent: isFirst ? 'flex-end' : isLast ? 'flex-start' : 'space-between' }}>
        {!isFirst ? <Port /> : null}
        {!isLast ? <Port /> : null}
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
        justifyContent: 'center',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        {PIPELINE_NODES.map((node, index) => (
          <div key={node.label} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
            {index > 0 ? <Edge width={EDGE_WIDTHS[index - 1] ?? 1.5} /> : null}
            <PipelineNodeBox node={node} isFirst={index === 0} isLast={index === PIPELINE_NODES.length - 1} />
          </div>
        ))}
      </div>
    </div>
  );
}
