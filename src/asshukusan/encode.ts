/**
 * 縮小・再エンコードと、動作確認用サンプル画像の生成。
 * 決定論的な処理は全てページ内 Canvas で完結し、画像を外部へは送らない。
 *
 * リサイズ + 再エンコードそのもの（pixel 処理）は encode.worker.ts の module worker に
 * 逃がしている。OffscreenCanvas / Worker が使えない環境（古い Safari 等）だけ、
 * このファイル内のメインスレッド経路にフォールバックする。
 */

import { buildExifApp1 } from "./exif";
import { insertJpegSegments } from "./metadataStrip";
import {
  computeTargetDims,
  encodeAvif,
  extensionFor,
  FORMAT_MIME,
  type EncodeResult,
  type OutputFormat,
  type ProbedFormat,
} from "./encodeShared";

export { computeTargetDims, extensionFor };
export type { EncodeResult, OutputFormat, ProbedFormat };

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

/**
 * ブラウザが実際にその形式で書き出せるかを 1×1 canvas で probe する。
 * 対応していない形式は canvas.toBlob が無言で別形式（PNG 等）を返すことがあるため、
 * 返ってきた blob.type が要求した mime と一致するかで判定する。
 *
 * この probe はメインスレッドの 1×1 canvas のまま残している（worker へ移していない）。
 * 1×1 の toBlob は実測でも数msで返る軽い処理で、UI をブロックする類の作業ではないため、
 * わざわざ worker 側に probe メッセージを増やす複雑さに見合わない。
 */
export async function detectFormatSupport(): Promise<Record<ProbedFormat, boolean>> {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;

  async function supports(mime: string): Promise<boolean> {
    const blob = await canvasToBlob(canvas, mime);
    return blob !== null && blob.type === mime;
  }

  const [jpeg, webp] = await Promise.all([supports(FORMAT_MIME.jpeg), supports(FORMAT_MIME.webp)]);
  // canvas.toBlob は AVIF を書き出せる実装が無いため probe しない。@jsquash/avif の wasm エンコーダに
  // 切り替えているので、対応可否は WebAssembly が動くかどうかだけで決まる
  const avif = typeof WebAssembly === "object";
  return { jpeg, webp, avif };
}

/**
 * OffscreenCanvas/Worker が使えない環境向けのフォールバック経路。worker 版と同じ手順
 * （drawImage → toBlob、AVIF だけ getImageData → wasm encode）をメインスレッドで直接行う。
 */
async function encodeImageMainThread(
  img: HTMLImageElement,
  opts: { format: OutputFormat; quality: number; longEdgeCap: number | null },
): Promise<EncodeResult> {
  const dims = computeTargetDims(img.naturalWidth, img.naturalHeight, opts.longEdgeCap);
  const canvas = document.createElement("canvas");
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context を取得できませんでした");
  ctx.drawImage(img, 0, 0, dims.width, dims.height);

  if (opts.format === "avif") {
    const blob = await encodeAvif(ctx.getImageData(0, 0, dims.width, dims.height), opts.quality);
    return { blob, width: dims.width, height: dims.height };
  }

  const mime = FORMAT_MIME[opts.format];
  const blob = await canvasToBlob(canvas, mime, opts.quality);
  if (!blob) throw new Error("エンコードに失敗しました");

  return { blob, width: dims.width, height: dims.height };
}

// --- worker 経由のエンコード -------------------------------------------------
// OffscreenCanvas と Worker が両方使える環境でだけ worker を使う
const canUseWorker = typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined";

type WorkerResponse =
  | { id: number; blob: Blob; width: number; height: number }
  | { id: number; error: string };

interface PendingEncode {
  resolve: (result: EncodeResult) => void;
  reject: (error: Error) => void;
}

let encodeWorker: Worker | null = null;
let nextRequestId = 0;
const pendingEncodes = new Map<number, PendingEncode>();

/**
 * パイプラインの各段は直列に呼ばれる設計（size → format の比較表も1件ずつ await する。
 * pipeline.ts 参照）ため、同時に複数の encode リクエストが飛び交うことはない。
 * リクエストごとに worker を作り直す・複数体持つ利点がなく、生成コストと wasm の
 * 二重ロードを避けるため 1 体だけ遅延生成して使い回す
 */
function getEncodeWorker(): Worker {
  if (encodeWorker) return encodeWorker;
  const w = new Worker(new URL("./encode.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const data = event.data;
    const task = pendingEncodes.get(data.id);
    if (!task) return;
    pendingEncodes.delete(data.id);
    if ("error" in data) task.reject(new Error(data.error));
    else task.resolve({ blob: data.blob, width: data.width, height: data.height });
  };
  w.onerror = (event) => {
    // worker の起動失敗など、個々の message ではなく worker 自体が壊れたケース。
    // 保留中の全リクエストをこのタイミングで解決しないと、呼び出し元が永遠に待ち続ける
    const error = new Error(event.message || "worker でエラーが発生しました");
    for (const [id, task] of pendingEncodes) {
      task.reject(error);
      pendingEncodes.delete(id);
    }
    // 壊れた worker を使い回すと以後の全リクエストが同じ失敗を繰り返すので捨てて、次回の呼び出しで作り直す
    w.terminate();
    if (encodeWorker === w) encodeWorker = null;
  };
  encodeWorker = w;
  return w;
}

async function encodeImageViaWorker(
  img: HTMLImageElement,
  opts: { format: OutputFormat; quality: number; longEdgeCap: number | null },
): Promise<EncodeResult> {
  // createImageBitmap 自体はメインスレッドでしか呼べないが、デコード済みのビットマップを
  // worker へ転送するだけなので画素コピーは発生しない（Transferable として move される）。
  // imageOrientation の既定値はブラウザで異なり（Safari は Exif の向きを適用しない）、
  // <img> を drawImage するメインスレッド経路と結果がずれるので明示する
  const bitmap = await createImageBitmap(img, { imageOrientation: "from-image" });
  const w = getEncodeWorker();
  const id = nextRequestId++;
  return new Promise<EncodeResult>((resolve, reject) => {
    pendingEncodes.set(id, { resolve, reject });
    w.postMessage({ id, bitmap, format: opts.format, quality: opts.quality, longEdgeCap: opts.longEdgeCap }, [bitmap]);
  });
}

/**
 * 画像を指定の長辺上限まで縮小し、指定形式・品質で再エンコードする。
 * PNG は可逆圧縮のため quality は canvas 側で無視される（呼び出し側は気にせず渡してよい）。
 */
export async function encodeImage(
  img: HTMLImageElement,
  opts: { format: OutputFormat; quality: number; longEdgeCap: number | null },
): Promise<EncodeResult> {
  if (canUseWorker) return encodeImageViaWorker(img, opts);
  return encodeImageMainThread(img, opts);
}

/**
 * 動作確認用のサンプル画像（夕焼けの風景）をその場で生成する。
 * ノイズや雲の粒をランダム生成しているのは、実写に近い「グラデーションだけではない」データを
 * 圧縮させて縮小・品質ラダーの効果差が体感できるようにするため。
 *
 * canvas が吐く JPEG には Exif が一切無いため、メタデータカードの segment 一覧・Exif 詳細・
 * 編集機能を実写を用意せず試せるように、生成後に buildExifApp1 + insertJpegSegments で
 * 実データ（Make/Model/DateTimeOriginal/Orientation/GPS）入りの APP1 を差し込む。
 *
 * これは起動時に1回だけ走る軽い装飾的処理（1600×1067 の JPEG エンコード1回）であり、
 * このタスクが対象とする「pixel 処理を worker に逃がす」対象（縮小・再エンコードのループ）
 * ではないため、メインスレッドのまま残している。
 */
export function generateSampleFile(): Promise<File> {
  return new Promise((resolve, reject) => {
    const w = 1600;
    const h = 1067;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("canvas 2d context を取得できませんでした"));
      return;
    }

    const horizon = h * 0.55;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, "#9fc6e8");
    sky.addColorStop(0.6, "#cfe6f2");
    sky.addColorStop(1, "#f2ead3");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);

    const ground = ctx.createLinearGradient(0, horizon, 0, h);
    ground.addColorStop(0, "#7f9a5a");
    ground.addColorStop(1, "#4d6636");
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, w, h - horizon);

    ctx.fillStyle = "rgba(255, 245, 200, 0.9)";
    ctx.beginPath();
    ctx.arc(w * 0.78, horizon * 0.35, 70, 0, Math.PI * 2);
    ctx.fill();

    for (let c = 0; c < 14; c++) {
      const cx = Math.random() * w;
      const cy = Math.random() * horizon * 0.7;
      const rx = 60 + Math.random() * 140;
      const ry = 14 + Math.random() * 24;
      ctx.fillStyle = `rgba(255,255,255,${(0.25 + Math.random() * 0.35).toFixed(2)})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let t = 0; t < 40; t++) {
      const tx = Math.random() * w;
      const ty = horizon - Math.random() * 20;
      const tr = 6 + Math.random() * 18;
      ctx.fillStyle = `rgba(50, 70, 40, ${(0.4 + Math.random() * 0.4).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(tx, ty, tr, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let g = 0; g < 60; g++) {
      const gx = Math.random() * w;
      const gy = horizon + Math.random() * (h - horizon);
      const gr = 3 + Math.random() * 10;
      ctx.fillStyle = `rgba(0,0,0,${(0.03 + Math.random() * 0.06).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(gx, gy, gr, 0, Math.PI * 2);
      ctx.fill();
    }

    // ピクセル単位のノイズで写真らしい粒状感を足す
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let p = 0; p < d.length; p += 4) {
      if (Math.random() < 0.15) {
        const n = (Math.random() - 0.5) * 18;
        d[p] = Math.min(255, Math.max(0, (d[p] ?? 0) + n));
        d[p + 1] = Math.min(255, Math.max(0, (d[p + 1] ?? 0) + n));
        d[p + 2] = Math.min(255, Math.max(0, (d[p + 2] ?? 0) + n));
      }
    }
    ctx.putImageData(imgData, 0, 0);

    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("サンプル画像の生成に失敗しました"));
        return;
      }
      try {
        const exifApp1 = buildExifApp1({
          make: "Asshukusan",
          model: "Sample",
          dateTimeOriginal: "2026:09:09 12:00:00",
          orientation: 1,
          lat: 35.6812,
          lon: 139.7671,
        });
        const withExif = insertJpegSegments(await blob.arrayBuffer(), [exifApp1]);
        resolve(new File([withExif], "sample-photo.jpg", { type: "image/jpeg", lastModified: Date.now() }));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("サンプル画像への Exif 埋め込みに失敗しました"));
      }
    }, "image/jpeg", 0.92);
  });
}
