/**
 * PQ (ST 2084) 符号化 JPEG の生成。
 *
 * UltraHDR は「ベース JPEG + ゲインマップのメタデータ」で明るさを表現するため、
 * X などアップロード時にメタデータ（XMP/MPF）を剥がすサービスでは SDR に落ちる。
 * こちらは画素値そのものを Rec.2020 の絶対輝度として PQ で符号化し、その意味を
 * 復元するための ICC プロファイル（Rec.2020 + PQ）を埋め込む。画素と ICC は
 * 再エンコードしても失われないため、メタデータ非対応の環境でも HDR 表示が生き残る。
 */

import { LUMA_B, LUMA_G, LUMA_R, SRGB_TO_LINEAR_LUT, gainAt, type GainMapParams } from "./convert";
import { findInsertionOffset, insertSegments, writeUint16BE } from "./ultrahdr";
import hdrPngUrl from "./hdr.png";

/** SDR 基準白（相対輝度 1.0）を割り当てる絶対輝度（BT.2408 の参照値） */
const SDR_WHITE_NITS = 203;
/** PQ (ST 2084) の正規化基準輝度 */
const PQ_NORMALIZATION_NITS = 10000;

/**
 * Rec.709(sRGB) 線形光 → Rec.2020 線形光の 3x3 行列。
 * 両色空間とも白色点が D65 で共通なため色順応変換は不要で、原色変換の行列を掛けるだけでよい。
 */
const REC709_TO_REC2020: readonly (readonly [number, number, number])[] = [
  [0.6274039, 0.329283, 0.0433131],
  [0.0690973, 0.9195404, 0.0113623],
  [0.0163914, 0.0880133, 0.8955953],
];

/** ST 2084 (PQ) 逆 EOTF の定数（SMPTE ST 2084 / Rec.2100 で定義された値） */
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/**
 * 線形光の相対輝度（0 = 黒、1.0 = SDR 基準白 = SDR_WHITE_NITS）を PQ 信号値 [0,1] に符号化する。
 * 負値（原色変換の丸め誤差由来）は 0 clamp する。1.0 stop を超えるハイライトは
 * PQ_NORMALIZATION_NITS（10000 nits）に対する相対値としてそのまま符号化される。
 */
function linearToPq(relativeLinear: number): number {
  const nits = Math.max(0, relativeLinear) * SDR_WHITE_NITS;
  const l = nits / PQ_NORMALIZATION_NITS;
  const lm1 = l ** PQ_M1;
  const numerator = PQ_C1 + PQ_C2 * lm1;
  const denominator = 1 + PQ_C3 * lm1;
  return (numerator / denominator) ** PQ_M2;
}

/**
 * ImageData を PQ 符号化した ImageData に変換する（純関数）。
 * フル解像度で画素ごとに走るため、中間オブジェクトを作らず TypedArray を直接操作する。
 * ゲインは convert.ts の gainMapFromLuma と同じカーブだが、ダウンサンプルせず
 * 画素ごとの輝度からその場で計算する（gainMapFromLuma のような 1/4 解像度キャッシュは持たない）。
 */
export function encodePqPixels(imageData: ImageData, params: GainMapParams): ImageData {
  if (!Number.isFinite(params.stops) || params.stops <= 0) {
    throw new Error(`params.stops must be a finite number greater than 0, got ${params.stops}`);
  }
  const curve = Math.min(1, Math.max(0, params.curve));
  const maxGainLog2 = params.stops;
  const maxGain = 2 ** maxGainLog2;
  const threshold = Math.min(0.95, curve * 0.95);

  const m0 = REC709_TO_REC2020[0];
  const m1 = REC709_TO_REC2020[1];
  const m2 = REC709_TO_REC2020[2];
  if (!m0 || !m1 || !m2) {
    throw new Error("REC709_TO_REC2020 matrix is malformed");
  }

  const { width, height, data } = imageData;
  const out = new Uint8ClampedArray(data.length);

  for (let i = 0; i < data.length; i += 4) {
    const r8 = data[i];
    const g8 = data[i + 1];
    const b8 = data[i + 2];
    const a8 = data[i + 3];
    if (r8 === undefined || g8 === undefined || b8 === undefined || a8 === undefined) continue;

    const rLin = SRGB_TO_LINEAR_LUT[r8] ?? 0;
    const gLin = SRGB_TO_LINEAR_LUT[g8] ?? 0;
    const bLin = SRGB_TO_LINEAR_LUT[b8] ?? 0;

    const luma = LUMA_R * rLin + LUMA_G * gLin + LUMA_B * bLin;
    const gain = gainAt(luma, maxGain, threshold, curve);

    const rGained = rLin * gain;
    const gGained = gLin * gain;
    const bGained = bLin * gain;

    const r2020 = m0[0] * rGained + m0[1] * gGained + m0[2] * bGained;
    const g2020 = m1[0] * rGained + m1[1] * gGained + m1[2] * bGained;
    const b2020 = m2[0] * rGained + m2[1] * gGained + m2[2] * bGained;

    out[i] = Math.round(linearToPq(r2020) * 255);
    out[i + 1] = Math.round(linearToPq(g2020) * 255);
    out[i + 2] = Math.round(linearToPq(b2020) * 255);
    out[i + 3] = a8;
  }

  return new ImageData(out, width, height);
}

/** PQ JPEG のベース品質（UltraHDR のベースと同じ経験値をそのまま流用） */
const PQ_JPEG_QUALITY = 0.95;

/** APP2 ICC プロファイルセグメントの識別子（Adobe/libjpeg の慣例。1 marker あたり最大 65519 byte） */
const ICC_APP2_ID = "ICC_PROFILE\0";
const MARKER_APP2 = 0xe2;
const MAX_ICC_CHUNK_SIZE = 0xffff - 2 - ICC_APP2_ID.length - 2; // 長さフィールド(2) + ID(12) + seq/total(2)

/**
 * ICC プロファイルを APP2 セグメント列に分割する。65519 byte を超える場合は
 * seq_no/num_markers を振って複数セグメントに分割する（ICC 仕様どおり）。
 */
function buildIccProfileSegments(icc: Uint8Array): Uint8Array[] {
  const idBytes = new TextEncoder().encode(ICC_APP2_ID);
  const numMarkers = Math.max(1, Math.ceil(icc.length / MAX_ICC_CHUNK_SIZE));
  const segments: Uint8Array[] = [];
  for (let seq = 1; seq <= numMarkers; seq++) {
    const start = (seq - 1) * MAX_ICC_CHUNK_SIZE;
    const chunk = icc.subarray(start, Math.min(icc.length, start + MAX_ICC_CHUNK_SIZE));
    const length = 2 + idBytes.length + 2 + chunk.length;
    if (length > 0xffff) {
      throw new Error(`ICC segment too large: ${length} bytes`);
    }
    const segment = new Uint8Array(2 + length);
    segment[0] = 0xff;
    segment[1] = MARKER_APP2;
    writeUint16BE(segment, 2, length);
    segment.set(idBytes, 4);
    segment[4 + idBytes.length] = seq;
    segment[4 + idBytes.length + 1] = numMarkers;
    segment.set(chunk, 4 + idBytes.length + 2);
    segments.push(segment);
  }
  return segments;
}

async function fetchHdrPngBytes(): Promise<Uint8Array> {
  const response = await fetch(hdrPngUrl);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * PNG チャンクを走査して iCCP チャンクの中身（圧縮前のプロファイル名 + 圧縮方式 + zlib 圧縮データ）
 * のうち zlib 圧縮データ部分を取り出す。iCCP が見つからない、または圧縮方式が zlib(0) 以外の
 * PNG は本ツールが同梱する hdr.png の前提から外れるためエラーにする。
 */
function extractCompressedIccFromPng(png: Uint8Array): Uint8Array {
  const decoder = new TextDecoder("latin1");
  let offset = 8; // PNG シグネチャ(8byte)の直後から
  while (offset + 8 <= png.length) {
    const chunkHeader = new DataView(png.buffer, png.byteOffset + offset, 8);
    const length = chunkHeader.getUint32(0);
    const type = decoder.decode(png.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    if (dataStart + length > png.length) {
      throw new Error(`malformed PNG chunk "${type}": declared length exceeds buffer size`);
    }
    if (type === "iCCP") {
      const chunkData = png.subarray(dataStart, dataStart + length);
      let nameEnd = 0;
      while (nameEnd < chunkData.length && chunkData[nameEnd] !== 0) nameEnd++;
      const compressionMethod = chunkData[nameEnd + 1];
      if (compressionMethod !== 0) {
        throw new Error(`unsupported iCCP compression method: ${compressionMethod}`);
      }
      return chunkData.subarray(nameEnd + 2);
    }
    if (type === "IEND") break;
    offset = dataStart + length + 4; // + CRC(4byte)
  }
  throw new Error("hdr.png に iCCP チャンクが見つかりませんでした");
}

/** PNG の iCCP が持つ zlib (RFC1950) 圧縮データを伸長する */
async function inflateZlib(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([compressed.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let iccProfilePromise: Promise<Uint8Array> | null = null;

/**
 * hdr.png（Rec.2020 + PQ の ICC プロファイルを iCCP チャンクに持つ）から ICC プロファイルの
 * バイト列を取り出す。fetch・PNG パース・伸長はいずれも一度きりでよいため、
 * 初回呼び出しの Promise をモジュール内にキャッシュして使い回す。
 */
function getIccProfile(): Promise<Uint8Array> {
  iccProfilePromise ??= fetchHdrPngBytes().then(extractCompressedIccFromPng).then(inflateZlib);
  return iccProfilePromise;
}

/**
 * ImageData から PQ JPEG のバイト列を生成する。
 * canvas への描画・JPEG エンコードはブラウザ API 依存だが、画素の PQ 符号化 (encodePqPixels)
 * と ICC セグメントの組み立てはバイト列操作のみなので分離してある。
 */
export async function encodePqJpeg(imageData: ImageData, params: GainMapParams): Promise<Uint8Array> {
  const pqImageData = encodePqPixels(imageData, params);

  const canvas = document.createElement("canvas");
  canvas.width = pqImageData.width;
  canvas.height = pqImageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2d context を取得できませんでした");
  }
  ctx.putImageData(pqImageData, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", PQ_JPEG_QUALITY);
  });
  if (!blob) {
    throw new Error("JPEG エンコードに失敗しました");
  }
  const jpegBytes = new Uint8Array(await blob.arrayBuffer());

  const icc = await getIccProfile();
  const segments = buildIccProfileSegments(icc);
  const insertOffset = findInsertionOffset(jpegBytes);
  return insertSegments(jpegBytes, insertOffset, segments);
}
