/**
 * Display P3 + PQ (ST 2084) の ICC v4 プロファイルを clean-room 生成する。
 *
 * X はアップロード時に画像を webp/jpg へ再エンコードするが、その際 LUT 型（A2B0/B2A0）の
 * ICC プロファイルは脱落することが確認できたため、matrix/TRC 型 + cicp（[12,16,0,1] =
 * P3 色域・PQ 転送関数）の構成に変更した。cicp を解釈するデコーダは TRC を無視して
 * HDR として表示し、ICC の TRC しか見ない古いデコーダでは下記の SDR 白基準で
 * 意図的に劣化表示（白飛び）になる。
 */

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

function mulMatVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function mulMatMat(a: Mat3, b: Mat3): Mat3 {
  const row = (ai: Vec3): Vec3 => [
    ai[0] * b[0][0] + ai[1] * b[1][0] + ai[2] * b[2][0],
    ai[0] * b[0][1] + ai[1] * b[1][1] + ai[2] * b[2][1],
    ai[0] * b[0][2] + ai[1] * b[1][2] + ai[2] * b[2][2],
  ];
  return [row(a[0]), row(a[1]), row(a[2])];
}

function invert3(m: Mat3): Mat3 {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ];
}

/** CIE xy 色度座標を Y=1 の XYZ に変換する */
function xyToXyz(x: number, y: number): Vec3 {
  return [x / y, 1, (1 - x - y) / y];
}

/** RGB 原色 + 白色点の xy 色度座標から RGB→XYZ の 3x3 行列を導出する（標準的な手法） */
function rgbToXyzMatrix(rXy: readonly [number, number], gXy: readonly [number, number], bXy: readonly [number, number], wXy: readonly [number, number]): Mat3 {
  const xr = xyToXyz(rXy[0], rXy[1]);
  const xg = xyToXyz(gXy[0], gXy[1]);
  const xb = xyToXyz(bXy[0], bXy[1]);
  const unscaled: Mat3 = [
    [xr[0], xg[0], xb[0]],
    [xr[1], xg[1], xb[1]],
    [xr[2], xg[2], xb[2]],
  ];
  const xw = xyToXyz(wXy[0], wXy[1]);
  const s = mulMatVec(invert3(unscaled), xw);
  return [
    [unscaled[0][0] * s[0], unscaled[0][1] * s[1], unscaled[0][2] * s[2]],
    [unscaled[1][0] * s[0], unscaled[1][1] * s[1], unscaled[1][2] * s[2]],
    [unscaled[2][0] * s[0], unscaled[2][1] * s[1], unscaled[2][2] * s[2]],
  ];
}

/** Bradford 錐体応答行列（CIE の色順応変換で標準的に使われる定数） */
const BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

/** Bradford 法による色順応変換行列（白色点 src → dst、xy 色度座標指定） */
function bradfordAdaptation(srcWhiteXy: readonly [number, number], dstWhiteXy: readonly [number, number]): Mat3 {
  const bradfordInv = invert3(BRADFORD);
  const srcCone = mulMatVec(BRADFORD, xyToXyz(srcWhiteXy[0], srcWhiteXy[1]));
  const dstCone = mulMatVec(BRADFORD, xyToXyz(dstWhiteXy[0], dstWhiteXy[1]));
  const diag: Mat3 = [
    [dstCone[0] / srcCone[0], 0, 0],
    [0, dstCone[1] / srcCone[1], 0],
    [0, 0, dstCone[2] / srcCone[2]],
  ];
  return mulMatMat(bradfordInv, mulMatMat(diag, BRADFORD));
}

const D65: readonly [number, number] = [0.3127, 0.329];
const D50: readonly [number, number] = [0.34567, 0.3585];

const SRGB_PRIMARIES = {
  r: [0.64, 0.33] as const,
  g: [0.3, 0.6] as const,
  b: [0.15, 0.06] as const,
};
const P3_PRIMARIES = {
  r: [0.68, 0.32] as const,
  g: [0.265, 0.69] as const,
  b: [0.15, 0.06] as const,
};

const srgbToXyzD65 = rgbToXyzMatrix(SRGB_PRIMARIES.r, SRGB_PRIMARIES.g, SRGB_PRIMARIES.b, D65);
const p3ToXyzD65 = rgbToXyzMatrix(P3_PRIMARIES.r, P3_PRIMARIES.g, P3_PRIMARIES.b, D65);

/**
 * sRGB(Rec.709) 線形光 → Display P3 線形光の 3x3 行列。
 * 両色空間とも白色点が D65 で共通なため色順応変換は不要で、原色変換の行列（sRGB→XYZ と
 * XYZ→P3 の合成）を掛けるだけでよい。pqjpeg.ts の画素変換で使う。
 */
export const SRGB_TO_P3_LINEAR: Mat3 = mulMatMat(invert3(p3ToXyzD65), srgbToXyzD65);

/**
 * Display P3 原色（D65）を ICC PCS の白色点 D50 へ Bradford 順応した XYZ 行列。
 * 列がそれぞれ rXYZ/gXYZ/bXYZ タグの値になる。
 */
const p3ToXyzD50 = mulMatMat(bradfordAdaptation(D65, D50), p3ToXyzD65);
const R_XYZ_D50: Vec3 = [p3ToXyzD50[0][0], p3ToXyzD50[1][0], p3ToXyzD50[2][0]];
const G_XYZ_D50: Vec3 = [p3ToXyzD50[0][1], p3ToXyzD50[1][1], p3ToXyzD50[2][1]];
const B_XYZ_D50: Vec3 = [p3ToXyzD50[0][2], p3ToXyzD50[1][2], p3ToXyzD50[2][2]];

/** ICC 仕様で定義された PCS illuminant (D50) の s15Fixed16 固定値（X, Y, Z） */
const PCS_ILLUMINANT_D50_FIXED = [0x0000f6d6, 0x00010000, 0x0000d32d] as const;
const PCS_ILLUMINANT_D50: Vec3 = [PCS_ILLUMINANT_D50_FIXED[0] / 65536, PCS_ILLUMINANT_D50_FIXED[1] / 65536, PCS_ILLUMINANT_D50_FIXED[2] / 65536];

// ---- PQ (ST 2084) EOTF ----
// pqjpeg.ts の linearToPq（逆 EOTF、線形光→PQ 信号）の逆関数。定数は同じ ST 2084 由来。
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/** PQ 信号値 [0,1] を相対輝度（1.0 = 10000 nits）に変換する（ST 2084 EOTF） */
function pqEotf(signal: number): number {
  const s = Math.min(1, Math.max(0, signal));
  const sm = s ** (1 / PQ_M2);
  const numerator = Math.max(0, sm - PQ_C1);
  const denominator = PQ_C2 - PQ_C3 * sm;
  return (numerator / denominator) ** (1 / PQ_M1);
}

/** SDR 基準白（相対輝度 1.0）を割り当てる絶対輝度（pqjpeg.ts と同じ BT.2408 の参照値） */
const SDR_WHITE_NITS = 203;
const PQ_NORMALIZATION_NITS = 10000;
const TRC_ENTRY_COUNT = 1024;

/**
 * rTRC/gTRC/bTRC の curveType エントリを作る。SDR 基準白 203 nits を 1.0 に正規化し、
 * それ以上はクリップする。ICC の TRC しか見ない SDR ビューアではここでハイライトが
 * 白飛びするが、cicp を解釈する Chrome / X 系はこの TRC ではなく cicp で HDR 解釈するため
 * 実害はない（意図した graceful degradation）。
 */
function buildPqTrcTable(): Uint16Array {
  const table = new Uint16Array(TRC_ENTRY_COUNT);
  for (let i = 0; i < TRC_ENTRY_COUNT; i++) {
    const signal = i / (TRC_ENTRY_COUNT - 1);
    const nits = pqEotf(signal) * PQ_NORMALIZATION_NITS;
    const linear = Math.min(1, nits / SDR_WHITE_NITS);
    table[i] = Math.round(linear * 65535);
  }
  return table;
}

// ---- バイナリ組み立て ----

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function utf16BeBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out[i * 2] = (code >> 8) & 0xff;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

function s15Fixed16(value: number): number {
  return Math.round(value * 65536);
}

/** XYZType タグ（'XYZ ' + reserved(4) + s15Fixed16 x3）を組み立てる */
function buildXyzTagData(v: Vec3): Uint8Array {
  const buf = new Uint8Array(20);
  const dv = new DataView(buf.buffer);
  buf.set(asciiBytes("XYZ "), 0);
  dv.setInt32(8, s15Fixed16(v[0]));
  dv.setInt32(12, s15Fixed16(v[1]));
  dv.setInt32(16, s15Fixed16(v[2]));
  return buf;
}

/** curveType タグ（'curv' + reserved(4) + count(4) + uint16 テーブル）を組み立てる */
function buildCurvTagData(table: Uint16Array): Uint8Array {
  const buf = new Uint8Array(12 + table.length * 2);
  const dv = new DataView(buf.buffer);
  buf.set(asciiBytes("curv"), 0);
  dv.setUint32(8, table.length);
  for (let i = 0; i < table.length; i++) {
    const entry = table[i];
    if (entry !== undefined) dv.setUint16(12 + i * 2, entry);
  }
  return buf;
}

/** multiLocalizedUnicodeType タグ（1 レコードの en/US 固定）を組み立てる */
function buildMlucTagData(text: string): Uint8Array {
  const HEADER_SIZE = 16; // sig(4) + reserved(4) + numRecords(4) + recordSize(4)
  const RECORD_SIZE = 12; // language(2) + country(2) + length(4) + offset(4)
  const stringOffset = HEADER_SIZE + RECORD_SIZE;
  const strBytes = utf16BeBytes(text);

  const buf = new Uint8Array(stringOffset + strBytes.length);
  const dv = new DataView(buf.buffer);
  buf.set(asciiBytes("mluc"), 0);
  dv.setUint32(8, 1); // numRecords
  dv.setUint32(12, RECORD_SIZE);
  buf.set(asciiBytes("en"), HEADER_SIZE);
  buf.set(asciiBytes("US"), HEADER_SIZE + 2);
  dv.setUint32(HEADER_SIZE + 4, strBytes.length);
  dv.setUint32(HEADER_SIZE + 8, stringOffset);
  buf.set(strBytes, stringOffset);
  return buf;
}

/** cicpType タグ（'cicp' + reserved(4) + primaries/transfer/matrix/range の 4 byte）を組み立てる */
function buildCicpTagData(colorPrimaries: number, transferCharacteristics: number, matrixCoefficients: number, videoFullRangeFlag: number): Uint8Array {
  const buf = new Uint8Array(12);
  buf.set(asciiBytes("cicp"), 0);
  buf[8] = colorPrimaries;
  buf[9] = transferCharacteristics;
  buf[10] = matrixCoefficients;
  buf[11] = videoFullRangeFlag;
  return buf;
}

const HEADER_SIZE = 128;

/** ICC v4 ヘッダを組み立てる（profile size は仮の 0 を書き、呼び出し側で最終長に書き換える） */
function buildHeader(): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE);
  const dv = new DataView(buf.buffer);
  // 0-3: profile size は最後にまとめて書く
  // 4-7: CMM type は指定しない（0 埋め）
  dv.setUint32(8, 0x04300000); // version 4.3.0.0
  buf.set(asciiBytes("mntr"), 12); // device class: display
  buf.set(asciiBytes("RGB "), 16); // color space
  buf.set(asciiBytes("XYZ "), 20); // PCS
  // 24-35: 作成日時（固定値でよい） 2026-01-01T00:00:00
  dv.setUint16(24, 2026);
  dv.setUint16(26, 1);
  dv.setUint16(28, 1);
  dv.setUint16(30, 0);
  dv.setUint16(32, 0);
  dv.setUint16(34, 0);
  buf.set(asciiBytes("acsp"), 36);
  // 40-63: primary platform / flags / manufacturer / model / attributes は指定しない（0 埋め）
  dv.setUint32(64, 0); // rendering intent: perceptual
  dv.setInt32(68, PCS_ILLUMINANT_D50_FIXED[0]);
  dv.setInt32(72, PCS_ILLUMINANT_D50_FIXED[1]);
  dv.setInt32(76, PCS_ILLUMINANT_D50_FIXED[2]);
  // 80-127: profile creator / profile ID / reserved は 0 埋めでよい
  return buf;
}

/**
 * P3 PQ (matrix/TRC) の ICC v4 プロファイルを生成する。
 * cicp [12, 16, 0, 1] = P3 色域 (ColorPrimaries=12) + PQ 転送関数 (TransferCharacteristics=16) +
 * unspecified matrix (0) + full range (1)。
 */
function buildP3PqIccProfileUncached(): Uint8Array {
  const trcData = buildCurvTagData(buildPqTrcTable());

  // cicp を先頭にする並びは実績のあるプロファイル（X を生き残ったサンプル）のタグ順に合わせた
  const tagDefs: ReadonlyArray<{ readonly sig: string; readonly data: Uint8Array }> = [
    { sig: "cicp", data: buildCicpTagData(12, 16, 0, 1) },
    { sig: "wtpt", data: buildXyzTagData(PCS_ILLUMINANT_D50) },
    { sig: "rXYZ", data: buildXyzTagData(R_XYZ_D50) },
    { sig: "gXYZ", data: buildXyzTagData(G_XYZ_D50) },
    { sig: "bXYZ", data: buildXyzTagData(B_XYZ_D50) },
    { sig: "rTRC", data: trcData },
    { sig: "gTRC", data: trcData },
    { sig: "bTRC", data: trcData },
    { sig: "desc", data: buildMlucTagData("P3 PQ (shirobikari)") },
    { sig: "cprt", data: buildMlucTagData("CC0, generated by shirobikari (clean-room, no third-party ICC data)") },
  ];

  const tagTableSize = 4 + tagDefs.length * 12;
  let cursor = HEADER_SIZE + tagTableSize;

  const placedOffsets = new Map<Uint8Array, { readonly offset: number; readonly size: number }>();
  const uniqueBlocks: Uint8Array[] = [];
  const entries: Array<{ readonly sig: string; readonly offset: number; readonly size: number }> = [];

  for (const { sig, data } of tagDefs) {
    const existing = placedOffsets.get(data);
    if (existing) {
      entries.push({ sig, offset: existing.offset, size: existing.size });
      continue;
    }
    const offset = cursor;
    const size = data.length;
    placedOffsets.set(data, { offset, size });
    entries.push({ sig, offset, size });
    uniqueBlocks.push(data);
    cursor += size;
    cursor += (4 - (cursor % 4)) % 4; // 次のタグ開始位置を 4 byte 境界に揃える
  }

  const totalSize = cursor;
  const profile = new Uint8Array(totalSize);
  profile.set(buildHeader(), 0);
  new DataView(profile.buffer).setUint32(0, totalSize); // profile size

  const tagTableView = new DataView(profile.buffer, HEADER_SIZE, tagTableSize);
  tagTableView.setUint32(0, tagDefs.length);
  entries.forEach((entry, i) => {
    const entryOffset = 4 + i * 12;
    profile.set(asciiBytes(entry.sig), HEADER_SIZE + entryOffset);
    tagTableView.setUint32(entryOffset + 4, entry.offset);
    tagTableView.setUint32(entryOffset + 8, entry.size);
  });

  for (const block of uniqueBlocks) {
    const { offset } = placedOffsets.get(block) as { readonly offset: number; readonly size: number };
    profile.set(block, offset);
  }

  return profile;
}

let cachedProfile: Uint8Array | null = null;

/** P3 PQ の ICC プロファイルを生成する。バイト列の内容は入力を取らないため一度だけ生成しキャッシュする */
export function buildP3PqIccProfile(): Uint8Array {
  cachedProfile ??= buildP3PqIccProfileUncached();
  return cachedProfile;
}
