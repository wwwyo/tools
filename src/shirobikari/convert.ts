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
  /** ヘッドルーム（最大ゲイン、stop 単位）。1〜4 stop を想定。有限かつ 0 より大きい必要がある */
  readonly stops: number;
  /** ゲインを持ち上げ始める明るさのカーブ。0 = 全体一様、1 = ハイライトのみ。[0,1] へ clamp される */
  readonly curve: number;
};

export type GainMapResult = {
  /** 元画像の 1/4 解像度・グレースケールのゲインマップ */
  readonly gainMapImageData: ImageData;
  /** log2(最大ゲイン)。ヘッドルームの stop 数と同じ値 */
  readonly maxGainLog2: number;
};

/**
 * 元画像 1/4 解像度で平均化した Rec.709 輝度マップ。
 * 画像ロード時に1回だけ computeLumaMap で計算し、スライダー変更のたびに
 * gainMapFromLuma へ使い回すためのキャッシュ用中間データ。
 */
export type LumaMap = {
  /** gmWidth * gmHeight の線形輝度（0〜1）の平坦配列 */
  readonly lumaMap: Float32Array;
  readonly width: number;
  readonly height: number;
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

/**
 * sRGB の 8bit チャンネル値 (0-255) を線形光 (0-1) に変換する事前計算 LUT。
 * 全画素で同じ 256 パターンしか出ないため、都度計算せずここで一度だけ埋める。
 */
const SRGB_TO_LINEAR_LUT: Float32Array = (() => {
  const lut = new Float32Array(256);
  for (let value8bit = 0; value8bit < 256; value8bit++) {
    const c = value8bit / 255;
    lut[value8bit] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return lut;
})();

/** sRGB の 8bit チャンネル値 (0-255) を線形光 (0-1) に変換する */
function srgbToLinear(value8bit: number): number {
  return SRGB_TO_LINEAR_LUT[value8bit] ?? 0;
}

/** GLSL 由来の smoothstep。edge0 < edge1 を前提とする */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 線形輝度からゲイン倍率を計算する。
 * curve=0（画像全体）では luma に関係なく一様に maxGain、curve=1（明るい部分だけ）では
 * threshold 未満のゲインが 1（持ち上げなし）でハイライトだけ maxGain へ滑らかに漸近する。
 * 中間の curve では両者を線形補間するので、「画像全体」ラベルどおり curve=0 で暗部も
 * ちゃんと持ち上がる（smoothstep だけで判定すると curve=0 でも暗部がほぼ持ち上がらず
 * ラベルと矛盾していたため、一様加算項 (1-curve) を足す形に変更した）。
 */
function gainAt(linearLuma: number, maxGain: number, threshold: number, curve: number): number {
  const highlightWeight = (1 - curve) + curve * smoothstep(threshold, 1, linearLuma);
  return 1 + (maxGain - 1) * highlightWeight;
}

/**
 * ImageData から 1/4 解像度の Rec.709 輝度マップを計算する（純関数）。
 * 画素ごとに sRGB→線形変換してから輝度係数を掛けて平均するだけの重い走査で、
 * ゲインパラメータに依存しないため画像ロード時に1回だけ実行すれば足りる。
 */
export function computeLumaMap(imageData: ImageData): LumaMap {
  const { width, height, data } = imageData;
  const gmWidth = Math.max(1, Math.round(width / GAIN_MAP_DOWNSCALE));
  const gmHeight = Math.max(1, Math.round(height / GAIN_MAP_DOWNSCALE));
  const lumaMap = new Float32Array(gmWidth * gmHeight);

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
      lumaMap[gy * gmWidth + gx] = sampleCount > 0 ? lumaSum / sampleCount : 0;
    }
  }

  return { lumaMap, width: gmWidth, height: gmHeight };
}

/**
 * 事前計算済みの輝度マップにゲインカーブを適用してゲインマップを合成する（純関数）。
 * 重い輝度走査を含まない軽量な計算のみなので、スライダー変更のたびに呼び出す想定。
 * 出力は 1/4 解像度のグレースケール ImageData で、値は log2(gain) を [0,255] に正規化したもの。
 */
export function gainMapFromLuma(luma: LumaMap, params: GainMapParams): GainMapResult {
  if (!Number.isFinite(params.stops) || params.stops <= 0) {
    throw new Error(`params.stops must be a finite number greater than 0, got ${params.stops}`);
  }
  const curve = Math.min(1, Math.max(0, params.curve));

  const maxGainLog2 = params.stops;
  const maxGain = 2 ** maxGainLog2;
  // curve=0(全体一様)で threshold=0、curve=1(ハイライトのみ)で threshold=0.95 に寄せる。
  // 1.0 ぴったりにすると smoothstep(1,1,x) が常に 0 になり何も持ち上がらなくなるため避ける
  const threshold = Math.min(0.95, curve * 0.95);

  const { lumaMap, width: gmWidth, height: gmHeight } = luma;
  const gmData = new Uint8ClampedArray(gmWidth * gmHeight * 4);

  for (let idx = 0; idx < gmWidth * gmHeight; idx++) {
    const avgLuma = lumaMap[idx] ?? 0;
    const gain = gainAt(avgLuma, maxGain, threshold, curve);
    const normalized = Math.min(1, Math.max(0, Math.log2(gain) / maxGainLog2));

    const gi = idx * 4;
    const value = Math.round(normalized * 255);
    gmData[gi] = value;
    gmData[gi + 1] = value;
    gmData[gi + 2] = value;
    gmData[gi + 3] = 255;
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

/**
 * ベース JPEG をエンコードする。パラメータに依存しないため、画像ロード時に1回だけ
 * 呼び出して呼び出し側（main.ts の state）でキャッシュする想定。
 */
export async function encodeBaseJpeg(imageData: ImageData): Promise<Uint8Array> {
  const baseCanvas = imageDataToCanvas(imageData);
  return canvasToJpegBytes(baseCanvas, BASE_JPEG_QUALITY);
}

export type EncodedGainMap = {
  readonly gainMapJpeg: Uint8Array;
  readonly maxGainLog2: number;
};

/**
 * 事前計算済みの輝度マップとパラメータから、ゲインマップ JPEG のバイト列を作る。
 * スライダー変更のたびに呼ばれる軽量パス（輝度の全画素走査は含まない）。
 */
export async function encodeGainMapJpeg(luma: LumaMap, params: GainMapParams): Promise<EncodedGainMap> {
  const { gainMapImageData, maxGainLog2 } = gainMapFromLuma(luma, params);
  const gainMapCanvas = imageDataToCanvas(gainMapImageData);
  const gainMapJpeg = await canvasToJpegBytes(gainMapCanvas, GAIN_MAP_JPEG_QUALITY);
  return { gainMapJpeg, maxGainLog2 };
}
