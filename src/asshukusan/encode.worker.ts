/**
 * pixel 処理（リサイズ + 再エンコード）専用の module worker。
 * OffscreenCanvas への描画と、AVIF の wasm エンコード（@jsquash/avif）はどちらも
 * 大きな画像で数百ms〜数秒かかりうるため、メインスレッドに置くと UI が固まる。
 * この worker は 1 リクエスト = 1 メッセージの単発 RPC として振る舞い、状態を持たない
 * （AVIF wasm モジュールのキャッシュだけは worker ごとに独立して持つ）。
 *
 * この ts ファイルには `/// <reference lib="webworker" />` を足していない。tsconfig は
 * リポジトリ全体で 1 本（"dom" lib）を共有しており、"webworker" lib を混ぜると
 * Window と DedicatedWorkerGlobalScope の型が衝突して壊れる。この worker が使う
 * OffscreenCanvas / self.postMessage / MessageEvent はいずれも "dom" lib 側に
 * 実行時と互換な型がすでに含まれているため、専用 tsconfig を増やしてまで
 * "webworker" lib に切り替える必要はない。
 */

import { computeTargetDims, FORMAT_MIME, type OutputFormat } from "./encodeShared";

interface EncodeRequest {
  id: number;
  bitmap: ImageBitmap;
  format: OutputFormat;
  quality: number;
  longEdgeCap: number | null;
}

type EncodeResponse =
  | { id: number; blob: Blob; width: number; height: number }
  | { id: number; error: string };

// @jsquash/avif は wasm を読み込むため、AVIF を実際に使うリクエストが来るまで import を遅らせる。
// worker はメインスレッドと別コンテキストなので、このキャッシュも worker 側に独立して持つ
// （encode.ts のメインスレッド版キャッシュとは別物）
let avifModulePromise: Promise<typeof import("@jsquash/avif")> | null = null;

function loadAvifEncoder(): Promise<typeof import("@jsquash/avif")> {
  if (!avifModulePromise) avifModulePromise = import("@jsquash/avif");
  return avifModulePromise;
}

/** quality は他形式と同じ 0..1 のスケールで受け取り、@jsquash/avif の 0..100 スケールにそのまま引き伸ばす */
async function encodeAvif(imageData: ImageData, quality: number): Promise<Blob> {
  const { encode } = await loadAvifEncoder();
  const buf = await encode(imageData, { quality: Math.round(quality * 100), speed: 8 });
  return new Blob([buf], { type: FORMAT_MIME.avif });
}

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const { id, bitmap, format, quality, longEdgeCap } = event.data;
  try {
    const dims = computeTargetDims(bitmap.width, bitmap.height, longEdgeCap);
    const canvas = new OffscreenCanvas(dims.width, dims.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context を取得できませんでした");
    ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
    bitmap.close(); // 転送されたビットマップは描画後すぐ手放してよい

    let blob: Blob;
    if (format === "avif") {
      const imageData = ctx.getImageData(0, 0, dims.width, dims.height);
      blob = await encodeAvif(imageData, quality);
    } else {
      const mime = FORMAT_MIME[format];
      blob = await canvas.convertToBlob({ type: mime, quality });
      // convertToBlob は canvas.toBlob と同様、非対応形式を無言で PNG 等へ差し替えることがある。
      // 返ってきた blob.type が要求した mime と一致するかで実際に書き出せたかを確かめ、
      // 一致しなければメインスレッドが「対応不可」として扱えるようエラーを返す
      if (blob.type !== mime) throw new Error(`${format} での書き出しに対応していません`);
    }

    const response: EncodeResponse = { id, blob, width: dims.width, height: dims.height };
    self.postMessage(response);
  } catch (error) {
    const response: EncodeResponse = {
      id,
      error: error instanceof Error ? error.message : "worker でのエンコードに失敗しました",
    };
    self.postMessage(response);
  }
};
