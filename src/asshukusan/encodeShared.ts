/**
 * encode.ts（メインスレッド）と encode.worker.ts（worker）の両方から使う、DOM を持たない
 * 純粋な型・定数・計算だけを集める。encode.ts は document 依存のフォールバック経路を持つため
 * worker からは import させたくない。共有したい部分だけをここへ切り出すことで、
 * worker のバンドルにメインスレッド専用コードが紛れ込むのを防ぐ。
 */

/** このツールが梯子の行として並べる出力形式。品質パラメータの有無に関わらず、拡張子ごとに1行 */
export type OutputFormat = "jpeg" | "webp" | "avif" | "png";

/** canvas.toBlob の対応可否を実機で probe する対象。PNG は可逆圧縮で全ブラウザが常に対応するため対象外 */
export type ProbedFormat = "jpeg" | "webp" | "avif";

export const FORMAT_MIME: Record<OutputFormat, string> = {
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  png: "image/png",
};

const FORMAT_EXT: Record<OutputFormat, string> = {
  jpeg: "jpg",
  webp: "webp",
  avif: "avif",
  png: "png",
};

export function extensionFor(format: OutputFormat): string {
  return FORMAT_EXT[format];
}

/** 再エンコード結果 */
export interface EncodeResult {
  blob: Blob;
  width: number;
  height: number;
}

/** 長辺の上限（px）から出力寸法を求める。cap が null、または画像が既に cap 以下ならアップスケールせず原寸を返す */
export function computeTargetDims(
  naturalWidth: number,
  naturalHeight: number,
  longEdgeCap: number | null,
): { width: number; height: number } {
  if (!longEdgeCap) return { width: naturalWidth, height: naturalHeight };
  const longEdge = Math.max(naturalWidth, naturalHeight);
  if (longEdge <= longEdgeCap) return { width: naturalWidth, height: naturalHeight };
  const scale = longEdgeCap / longEdge;
  return { width: Math.round(naturalWidth * scale), height: Math.round(naturalHeight * scale) };
}

// @jsquash/avif は wasm を読み込むため、AVIF を実際に使うまで import を遅らせる。
// module Promise はこのモジュールのインスタンスごと（メインスレッド / worker で別）に 1 つ持ち、
// 複数回 AVIF を選んでも読み込みは初回の 1 回だけにする
let avifModulePromise: Promise<typeof import("@jsquash/avif")> | null = null;

function loadAvifEncoder(): Promise<typeof import("@jsquash/avif")> {
  if (!avifModulePromise) avifModulePromise = import("@jsquash/avif");
  return avifModulePromise;
}

/**
 * wasm の初期化・エンコードに失敗した（CSP で wasm 実行がブロックされている等）ことを表す。
 * 呼び出し側（pipeline.ts / main.ts）はこれを「このセッションでは AVIF が使えない」判定に使う。
 */
export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFormatError";
  }
}

/**
 * 失敗した wasm モジュール Promise をキャッシュから外す。読み込み済みとして使い回すと、
 * 一度失敗した後の全リクエストが同じ失敗を再現するだけになるため、次回呼び出しで
 * import からやり直せるようにする（CSP 設定の反映後の再試行等）。
 */
export function resetAvifEncoder(): void {
  avifModulePromise = null;
}

/** quality は他形式と同じ 0..1 のスケールで受け取り、@jsquash/avif の 0..100 スケールにそのまま引き伸ばす */
export async function encodeAvif(imageData: ImageData, quality: number): Promise<Blob> {
  try {
    const { encode } = await loadAvifEncoder();
    const buf = await encode(imageData, { quality: Math.round(quality * 100), speed: 8 });
    return new Blob([buf], { type: FORMAT_MIME.avif });
  } catch (error) {
    resetAvifEncoder();
    throw new UnsupportedFormatError(error instanceof Error ? error.message : "AVIF の書き出しに失敗しました");
  }
}
