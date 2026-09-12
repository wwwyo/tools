/**
 * encode.ts（メインスレッド）と encode.worker.ts（worker）の両方から使う、DOM を持たない
 * 純粋な型・定数・計算だけを集める。encode.ts は document 依存のフォールバック経路を持つため
 * worker からは import させたくない。共有したい部分だけをここへ切り出すことで、
 * worker のバンドルにメインスレッド専用コードが紛れ込むのを防ぐ。
 */

// wasm 本体（3.4 MB）は @jsquash/avif が初回 encode 時に fetch するので、モジュール自体は
// 静的 import でよい。動的 import にしても先送りできるのはグルーコード数十 KB だけで、
// そのために worker のビルド形式を変える必要が生じるほうが割に合わない
import encodeAvifWasm, { init as initAvif } from "@jsquash/avif/encode";

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

// wasm の初期化は @jsquash/avif が `encode()` 初回に内部で行う（fetch + instantiate）。
// ここでは初期化の成否だけを 1 つの Promise で握り、失敗したら捨てて次回やり直せるようにする。
// @jsquash/avif 自身は失敗した初期化 Promise を持ち続けるため、明示的に `init()` を呼び直して
// 上書きしないと同じ失敗を再現し続ける
let avifInitPromise: Promise<void> | null = null;

function ensureAvifInitialized(): Promise<void> {
  if (!avifInitPromise) {
    avifInitPromise = initAvif().then(() => undefined);
  }
  return avifInitPromise;
}

/** 失敗した初期化をキャッシュから外し、次回の呼び出しで wasm の読み込みからやり直せるようにする */
export function resetAvifEncoder(): void {
  avifInitPromise = null;
}

/**
 * quality は他形式と同じ 0..1 のスケールで受け取り、@jsquash/avif の 0..100 スケールにそのまま引き伸ばす。
 *
 * `UnsupportedFormatError` にするのは wasm の初期化に失敗した場合だけに限定する
 * （呼び出し側はこれを「このセッションでは AVIF が丸ごと使えない」判定に使い、モジュールを
 * 作り直させ、AVIF を比較表から外す）。モジュール自体は生きていて `encode()` 呼び出しだけが
 * 失敗した場合（大きすぎる画像での OOM 等）は普通の Error のまま投げる。ここを混同すると、
 * たまたま重い1枚のエンコードが失敗しただけで以後ずっと AVIF が選べなくなってしまう。
 */
export async function encodeAvif(imageData: ImageData, quality: number): Promise<Blob> {
  try {
    await ensureAvifInitialized();
  } catch (error) {
    resetAvifEncoder();
    throw new UnsupportedFormatError(error instanceof Error ? error.message : "AVIF エンコーダの読み込みに失敗しました");
  }
  const buf = await encodeAvifWasm(imageData, { quality: Math.round(quality * 100), speed: 8 });
  return new Blob([buf], { type: FORMAT_MIME.avif });
}
