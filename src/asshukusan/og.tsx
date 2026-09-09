// OGP カード用のミニチュア。satori (OGP) と通常の React 描画 (デモページ) の両方から
// 使われるため inline style のみ・display は flex のみで組む（本体の main.ts は変更しない）。
//
// 写真の中身は描かず、フレームの輪郭だけを等比で縮めながら右へずらして重ね、
// 「同じ画が絞られていく」残像として圧縮を表す。線は墨色 1px、最後の 1 枚だけ朱で塗る。

const FRAME_COUNT = 5;
const BASE_WIDTH = 336;
const BASE_HEIGHT = 224;
/** 1 枚ごとの縮小率。0.78^4 ≈ 0.37 で最後の枚が元の 1/3 強に収まる */
const SHRINK = 0.78;
/** 1 枚ごとに右へずらす量。最後の 1 枚が最外枠の内側（右端から 24px）に収まる値 */
const SHIFT_X = 47;

type Frame = { width: number; height: number; left: number; opacity: number; filled: boolean };

const FRAMES: Frame[] = Array.from({ length: FRAME_COUNT }, (_, i) => {
  const scale = SHRINK ** i;
  return {
    width: Math.round(BASE_WIDTH * scale),
    height: Math.round(BASE_HEIGHT * scale),
    left: i * SHIFT_X,
    opacity: 0.9 - i * 0.14,
    filled: i === FRAME_COUNT - 1,
  };
});

const STAGE_WIDTH = FRAMES[FRAMES.length - 1]!.left + FRAMES[FRAMES.length - 1]!.width;

export default function AsshukusanOgPreview() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        // カード側と同じ紙色。白にするとテキスト側との境目に段差が出て枠線のように見えてしまう
        backgroundColor: '#fbfaf6',
        padding: 40,
      }}
    >
      <div style={{ display: 'flex', position: 'relative', width: STAGE_WIDTH, height: BASE_HEIGHT }}>
        {FRAMES.map((frame) => (
          <div
            key={frame.left}
            style={{
              display: 'flex',
              position: 'absolute',
              left: frame.left,
              top: Math.round((BASE_HEIGHT - frame.height) / 2),
              width: frame.width,
              height: frame.height,
              borderRadius: 3,
              border: frame.filled ? '1px solid #c73e2e' : `1px solid rgba(31,27,22,${frame.opacity})`,
              backgroundColor: frame.filled ? '#c73e2e' : 'rgba(251,250,246,0.72)',
            }}
          />
        ))}
      </div>
    </div>
  );
}
