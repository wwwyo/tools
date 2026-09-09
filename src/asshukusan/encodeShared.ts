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
