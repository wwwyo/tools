/**
 * SDR 画像の読み込みとゲインマップの合成ロジック。
 *
 * ゲインカーブの計算そのものは ImageData だけを扱う純関数にしてあるが、
 * ファイル読み込みと canvas でのリサイズ・エンコードはブラウザ API に依存する。
 */

/** 長辺をこの px にキャップする（巨大画像でのメモリ/処理時間の暴走を防ぐ） */
const MAX_LONG_EDGE = 4096;

/** ゲインマップの解像度は元画像の 1/4（面積比 1/16）にする */
const GAIN_MAP_DOWNSCALE = 4;

/** Rec.709 の輝度係数（線形光空間で適用する） */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export type GainMapParams = {
  /** ヘッドルーム（最大ゲイン、stop 単位）。1〜4 stop を想定 */
  readonly stops: number;
  /** ゲインを持ち上げ始める明るさのカーブ。0 = 全体一様、1 = ハイライトのみ */
  readonly curve: number;
};

export type GainMapResult = {
  /** 元画像の 1/4 解像度・グレースケールのゲインマップ */
  readonly gainMapImageData: ImageData;
  /** log2(最大ゲイン)。ヘッドルームの stop 数と同じ値 */
  readonly maxGainLog2: number;
};

/**
 * File から ImageData を読み込む。長辺を MAX_LONG_EDGE にキャップし、
 * アルファチャンネルは白背景へ flatten する（JPEG はアルファを持てないため）。
 */
export async function loadSdrImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2d context を取得できませんでした");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}

/** sRGB の 8bit チャンネル値 (0-255) を線形光 (0-1) に変換する */
function srgbToLinear(value8bit: number): number {
  const c = value8bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** GLSL 由来の smoothstep。edge0 < edge1 を前提とする */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 線形輝度からゲイン倍率を計算する。
 * threshold 未満はゲイン 1（持ち上げなし）、1 に近づくほど maxGain へ滑らかに漸近する。
 */
function gainAt(linearLuma: number, maxGain: number, threshold: number): number {
  return 1 + (maxGain - 1) * smoothstep(threshold, 1, linearLuma);
}

/**
 * ImageData からゲインマップを合成する（純関数）。
 * 画素ごとに sRGB→線形変換してから Rec.709 係数で輝度を求め、ゲインカーブを適用する。
 * 出力は 1/4 解像度のグレースケール ImageData で、値は log2(gain) を [0,255] に正規化したもの。
 */
export function computeGainMap(imageData: ImageData, params: GainMapParams): GainMapResult {
  const { width, height, data } = imageData;
  const maxGainLog2 = params.stops;
  const maxGain = 2 ** maxGainLog2;
  // curve=0(全体一様)で threshold=0、curve=1(ハイライトのみ)で threshold=0.95 に寄せる。
  // 1.0 ぴったりにすると smoothstep(1,1,x) が常に 0 になり何も持ち上がらなくなるため避ける
  const threshold = Math.min(0.95, Math.max(0, params.curve)) * 0.95;

  const gmWidth = Math.max(1, Math.round(width / GAIN_MAP_DOWNSCALE));
  const gmHeight = Math.max(1, Math.round(height / GAIN_MAP_DOWNSCALE));
  const gmData = new Uint8ClampedArray(gmWidth * gmHeight * 4);

  for (let gy = 0; gy < gmHeight; gy++) {
    const y0 = Math.floor((gy * height) / gmHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gmHeight));
    for (let gx = 0; gx < gmWidth; gx++) {
      const x0 = Math.floor((gx * width) / gmWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / gmWidth));

      let lumaSum = 0;
      let sampleCount = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (r === undefined || g === undefined || b === undefined) continue;
          const luma = LUMA_R * srgbToLinear(r) + LUMA_G * srgbToLinear(g) + LUMA_B * srgbToLinear(b);
          lumaSum += luma;
          sampleCount++;
        }
      }
      const avgLuma = sampleCount > 0 ? lumaSum / sampleCount : 0;
      const gain = gainAt(avgLuma, maxGain, threshold);
      const normalized = Math.min(1, Math.max(0, Math.log2(gain) / maxGainLog2));

      const gi = (gy * gmWidth + gx) * 4;
      const value = Math.round(normalized * 255);
      gmData[gi] = value;
      gmData[gi + 1] = value;
      gmData[gi + 2] = value;
      gmData[gi + 3] = 255;
    }
  }

  return {
    gainMapImageData: new ImageData(gmData, gmWidth, gmHeight),
    maxGainLog2,
  };
}

/** ImageData を canvas に描画する */
function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2d context を取得できませんでした");
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** canvas を JPEG エンコードしてバイト列で返す */
async function canvasToJpegBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
  if (!blob) {
    throw new Error("JPEG エンコードに失敗しました");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/** ベース画像品質・ゲインマップ品質（それぞれ元画質を保ちつつファイルサイズを抑える経験値） */
const BASE_JPEG_QUALITY = 0.92;
const GAIN_MAP_JPEG_QUALITY = 0.85;

export type EncodedGainMapAssets = {
  readonly baseJpeg: Uint8Array;
  readonly gainMapJpeg: Uint8Array;
  readonly maxGainLog2: number;
};

/** SDR の ImageData とパラメータから、ベース JPEG とゲインマップ JPEG のバイト列を作る */
export async function encodeGainMapAssets(imageData: ImageData, params: GainMapParams): Promise<EncodedGainMapAssets> {
  const { gainMapImageData, maxGainLog2 } = computeGainMap(imageData, params);
  const baseCanvas = imageDataToCanvas(imageData);
  const gainMapCanvas = imageDataToCanvas(gainMapImageData);
  const [baseJpeg, gainMapJpeg] = await Promise.all([
    canvasToJpegBytes(baseCanvas, BASE_JPEG_QUALITY),
    canvasToJpegBytes(gainMapCanvas, GAIN_MAP_JPEG_QUALITY),
  ]);
  return { baseJpeg, gainMapJpeg, maxGainLog2 };
}
