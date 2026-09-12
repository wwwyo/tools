/**
 * ICC プロファイル（ICC.1 仕様のヘッダー128byte + タグテーブル）のパース。
 *
 * DOM に依存しない純粋関数のみを置く（ブラウザ・Node どちらからも呼べるようにするため、
 * verify.ts のような Node スクリプトからも import できる）。壊れた入力に対しても
 * 例外を投げず、読めたフィールドだけを返し、読めなかったフィールドは
 * 「（読めない）」または null にする（呼び出し側が UI で個別に判定しなくて済むようにするため）。
 */

import { asciiAt, byteAt } from "./imageMeta";

export interface IccXyz {
  x: number;
  y: number;
  z: number;
}

export interface IccTagInfo {
  signature: string;
  size: number;
  /** 既知の型を解読できたときの表示用文字列。未対応の型・読めなかった場合は null */
  decoded: string | null;
}

export interface IccProfileInfo {
  profileSize: number | null;
  preferredCmm: string | null;
  versionMajor: number | null;
  versionMinor: number | null;
  deviceClass: string | null;
  deviceClassLabel: string | null;
  colorSpace: string | null;
  pcs: string | null;
  /** "YYYY-MM-DD HH:MM" */
  creationDate: string | null;
  primaryPlatform: string | null;
  renderingIntent: number | null;
  renderingIntentLabel: string | null;
  illuminant: IccXyz | null;
  creatorSignature: string | null;
  description: string | null;
  copyright: string | null;
  whitePoint: IccXyz | null;
  redPrimary: IccXyz | null;
  greenPrimary: IccXyz | null;
  bluePrimary: IccXyz | null;
  /** rTRC が curv・count===1 のときガンマ値（例: "2.20"）、count>1 のとき「曲線 N 点」 */
  redGamma: string | null;
  tags: IccTagInfo[];
  /** description に "sRGB" を含む、または原色が sRGB 標準値に近い（許容誤差 0.01）場合に true */
  isSrgbEquivalent: boolean;
  /** isSrgbEquivalent を根拠付ける一言。UI にそのまま出す */
  judgmentText: string;
}

const UNREADABLE = "（読めない）";

const DEVICE_CLASS_LABELS: Record<string, string> = {
  mntr: "ディスプレイ",
  prtr: "プリンタ",
  scnr: "スキャナ",
  link: "デバイスリンク",
  spac: "色空間変換",
  abst: "アブストラクト",
  nmcl: "名前付きカラー",
};

const RENDERING_INTENT_LABELS: Record<number, string> = {
  0: "知覚的",
  1: "相対的な色域を維持",
  2: "彩度優先",
  3: "絶対的な色域を維持",
};

/** sRGB の標準原色（rXYZ/gXYZ/bXYZ, D50 適合済み）。判定の許容誤差は 0.01（実測プロファイルの丸め誤差を吸収するため） */
const SRGB_PRIMARIES = {
  r: { x: 0.4361, y: 0.2225, z: 0.0139 },
};
const SRGB_TOLERANCE = 0.01;

function inBounds(len: number, offset: number, size: number): boolean {
  return offset >= 0 && size >= 0 && offset + size <= len;
}

function safeAscii(bytes: Uint8Array, offset: number, len: number): string | null {
  if (!inBounds(bytes.length, offset, len)) return null;
  return asciiAt(bytes, offset, len);
}

/** 文字列フィールドを NUL/空白トリムする（4byte固定のシグネチャ欄は右詰めの空白パディングがあるため） */
function trimSig(s: string): string {
  return s.replace(/[\0 ]+$/, "");
}

function s15Fixed16(view: DataView, offset: number): number | null {
  if (!inBounds(view.byteLength, offset, 4)) return null;
  return view.getInt32(offset, false) / 65536;
}

function readXyzAt(view: DataView, offset: number): IccXyz | null {
  const x = s15Fixed16(view, offset);
  const y = s15Fixed16(view, offset + 4);
  const z = s15Fixed16(view, offset + 8);
  if (x == null || y == null || z == null) return null;
  return { x, y, z };
}

function formatXyz(v: IccXyz | null): string {
  if (!v) return UNREADABLE;
  return `${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}`;
}

interface TagEntry {
  signature: string;
  offset: number;
  size: number;
}

/** タグテーブル（オフセット128、count(4) + 12byte エントリの列）を読む。壊れていれば読めた分だけ返す */
function readTagTable(bytes: Uint8Array, view: DataView): TagEntry[] {
  const entries: TagEntry[] = [];
  if (!inBounds(bytes.length, 128, 4)) return entries;
  const count = view.getUint32(128, false);
  // 桁あふれ・異常値からの防御。実在の ICC プロファイルでタグ数が万を超えることはない
  const safeCount = Number.isFinite(count) ? Math.min(count, 10000) : 0;
  for (let i = 0; i < safeCount; i++) {
    const entryOffset = 132 + i * 12;
    if (!inBounds(bytes.length, entryOffset, 12)) break;
    const signature = trimSig(asciiAt(bytes, entryOffset, 4));
    const offset = view.getUint32(entryOffset + 4, false);
    const size = view.getUint32(entryOffset + 8, false);
    entries.push({ signature, offset, size });
  }
  return entries;
}

function findTag(entries: TagEntry[], signature: string): TagEntry | undefined {
  return entries.find((e) => e.signature === signature);
}

/** textDescriptionType（'desc'）または 'text' または 'mluc' のいずれかから ASCII/UTF-16BE 文字列を読む */
function decodeTextTag(bytes: Uint8Array, view: DataView, tag: TagEntry): string | null {
  const { offset, size } = tag;
  if (!inBounds(bytes.length, offset, Math.min(size, 8))) return null;
  const typeSig = safeAscii(bytes, offset, 4);
  if (typeSig === "desc") {
    // textDescriptionType: type(4) + reserved(4) + asciiCount(4) + ascii（NUL 終端含む）+ ...
    if (!inBounds(bytes.length, offset + 8, 4)) return null;
    const asciiCount = view.getUint32(offset + 8, false);
    const start = offset + 12;
    const end = Math.min(start + Math.max(0, asciiCount - 1), offset + size, bytes.length);
    if (start > end) return null;
    return latin1(bytes.subarray(start, end)) || null;
  }
  if (typeSig === "text") {
    // textType: type(4) + reserved(4) + ASCII（NUL 終端）
    const start = offset + 8;
    const end = Math.min(offset + size, bytes.length);
    if (start > end) return null;
    const raw = latin1(bytes.subarray(start, end));
    const nul = raw.indexOf("\0");
    return (nul === -1 ? raw : raw.slice(0, nul)) || null;
  }
  if (typeSig === "mluc") {
    // multiLocalizedUnicodeType: type(4) + reserved(4) + recordCount(4) + recordSize(4) + records...
    if (!inBounds(bytes.length, offset + 8, 8)) return null;
    const recordCount = view.getUint32(offset + 8, false);
    if (recordCount === 0) return null;
    const recordLen = view.getUint32(offset + 20, false); // 先頭レコードの文字列長（byte）
    const recordOffset = view.getUint32(offset + 24, false); // タグ先頭からの相対オフセット
    const strStart = offset + recordOffset;
    const strEnd = Math.min(strStart + recordLen, offset + size, bytes.length);
    if (strStart >= strEnd) return null;
    let text = "";
    for (let i = strStart; i + 1 < strEnd; i += 2) {
      const code = view.getUint16(i, false);
      if (code !== 0) text += String.fromCharCode(code);
    }
    return text || null;
  }
  return null;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(byteAt(bytes, i));
  return s;
}

/** XYZType（'XYZ '）から最初の XYZ 三つ組を読む: type(4) + reserved(4) + XYZ(12) */
function decodeXyzTag(bytes: Uint8Array, view: DataView, tag: TagEntry): IccXyz | null {
  const { offset, size } = tag;
  if (size < 20) return null;
  if (!inBounds(bytes.length, offset, 20)) return null;
  return readXyzAt(view, offset + 8);
}

/** curveType（'curv'）: type(4) + reserved(4) + count(4) + values。count===1 は u8Fixed8Number のガンマ値 */
function decodeCurveGamma(bytes: Uint8Array, view: DataView, tag: TagEntry): string | null {
  const { offset, size } = tag;
  if (!inBounds(bytes.length, offset, 12) || size < 12) return null;
  const typeSig = safeAscii(bytes, offset, 4);
  if (typeSig !== "curv") return null;
  const count = view.getUint32(offset + 8, false);
  if (count === 0) return "1.0（リニア）";
  if (count === 1) {
    if (!inBounds(bytes.length, offset + 12, 2)) return UNREADABLE;
    const raw = view.getUint16(offset + 12, false); // u8Fixed8Number: 上位8bit整数部・下位8bit小数部
    return (raw / 256).toFixed(2);
  }
  return `曲線 ${count} 点`;
}

/** タグ1件を UI 表示用に解読する。既知のタグ（desc/cprt/wtpt/rXYZ/gXYZ/bXYZ/rTRC）だけ decoded を埋める */
function decodeTag(bytes: Uint8Array, view: DataView, entry: TagEntry): IccTagInfo {
  try {
    let decoded: string | null = null;
    if (entry.signature === "desc" || entry.signature === "cprt") {
      decoded = decodeTextTag(bytes, view, entry);
    } else if (entry.signature === "wtpt" || entry.signature === "rXYZ" || entry.signature === "gXYZ" || entry.signature === "bXYZ") {
      decoded = formatXyz(decodeXyzTag(bytes, view, entry));
    } else if (entry.signature === "rTRC" || entry.signature === "gTRC" || entry.signature === "bTRC") {
      decoded = decodeCurveGamma(bytes, view, entry);
    }
    return { signature: entry.signature, size: entry.size, decoded };
  } catch {
    return { signature: entry.signature, size: entry.size, decoded: UNREADABLE };
  }
}

function xyzCloseTo(a: IccXyz, b: IccXyz, tolerance: number): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.z - b.z) <= tolerance;
}

/**
 * バッファ（JPEG APP2 ICC_PROFILE 連結後 or WebP ICCP チャンクの中身）から ICC プロファイル情報を読む。
 * ヘッダー128byte すら読めない極端に短い入力だけ null を返し、それ以外は読めた範囲で部分的な情報を返す。
 */
export function parseIccProfile(bytes: Uint8Array): IccProfileInfo | null {
  if (bytes.length < 128) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const profileSize = inBounds(bytes.length, 0, 4) ? view.getUint32(0, false) : null;
  const preferredCmm = safeAscii(bytes, 4, 4);
  const versionMajor = inBounds(bytes.length, 8, 1) ? byteAt(bytes, 8) : null;
  const versionMinor = inBounds(bytes.length, 9, 1) ? byteAt(bytes, 9) >> 4 : null;
  const deviceClassRaw = safeAscii(bytes, 12, 4);
  const deviceClass = deviceClassRaw ? trimSig(deviceClassRaw) : null;
  const colorSpaceRaw = safeAscii(bytes, 16, 4);
  const colorSpace = colorSpaceRaw ? trimSig(colorSpaceRaw) : null;
  const pcsRaw = safeAscii(bytes, 20, 4);
  const pcs = pcsRaw ? trimSig(pcsRaw) : null;

  let creationDate: string | null = null;
  if (inBounds(bytes.length, 24, 12)) {
    try {
      const year = view.getUint16(24, false);
      const month = view.getUint16(26, false);
      const day = view.getUint16(28, false);
      const hour = view.getUint16(30, false);
      const minute = view.getUint16(32, false);
      const pad = (n: number): string => String(n).padStart(2, "0");
      creationDate = year > 0 ? `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}` : null;
    } catch {
      creationDate = UNREADABLE;
    }
  }

  const primaryPlatformRaw = safeAscii(bytes, 40, 4);
  const primaryPlatform = primaryPlatformRaw ? trimSig(primaryPlatformRaw) || null : null;

  const renderingIntent = inBounds(bytes.length, 64, 4) ? view.getUint32(64, false) : null;
  const illuminant = inBounds(bytes.length, 68, 12) ? readXyzAt(view, 68) : null;
  const creatorSignatureRaw = safeAscii(bytes, 80, 4);
  const creatorSignature = creatorSignatureRaw ? trimSig(creatorSignatureRaw) || null : null;

  const tagEntries = readTagTable(bytes, view);
  const tags = tagEntries.map((entry) => decodeTag(bytes, view, entry));

  const descTag = findTag(tagEntries, "desc");
  const description = descTag ? decodeTextTag(bytes, view, descTag) : null;
  const cprtTag = findTag(tagEntries, "cprt");
  const copyright = cprtTag ? decodeTextTag(bytes, view, cprtTag) : null;
  const wtptTag = findTag(tagEntries, "wtpt");
  const whitePoint = wtptTag ? decodeXyzTag(bytes, view, wtptTag) : null;
  const rXyzTag = findTag(tagEntries, "rXYZ");
  const redPrimary = rXyzTag ? decodeXyzTag(bytes, view, rXyzTag) : null;
  const gXyzTag = findTag(tagEntries, "gXYZ");
  const greenPrimary = gXyzTag ? decodeXyzTag(bytes, view, gXyzTag) : null;
  const bXyzTag = findTag(tagEntries, "bXYZ");
  const bluePrimary = bXyzTag ? decodeXyzTag(bytes, view, bXyzTag) : null;
  const rTrcTag = findTag(tagEntries, "rTRC");
  const redGamma = rTrcTag ? decodeCurveGamma(bytes, view, rTrcTag) : null;

  // sRGB 判定: プロファイル名に "sRGB" を含むか、赤原色が sRGB 標準値と許容誤差 0.01 以内で一致するか。
  // 許容誤差 0.01 はエンコーダごとの丸め（s15Fixed16 は 1/65536 単位だが、実測プロファイルは
  // さらに桁を落として書き出すことが多い）を吸収しつつ、明確に違うプロファイルは弾ける値として選んだ
  const descriptionMatchesSrgb = description != null && description.toLowerCase().includes("srgb");
  const primariesMatchSrgb = redPrimary != null && xyzCloseTo(redPrimary, SRGB_PRIMARIES.r, SRGB_TOLERANCE);
  const isSrgbEquivalent = descriptionMatchesSrgb || primariesMatchSrgb;
  const judgmentText = isSrgbEquivalent
    ? "sRGB 相当。除去しても色味は変わりません"
    : "sRGB ではありません。除去すると色味が変わります";

  return {
    profileSize,
    preferredCmm: preferredCmm ? trimSig(preferredCmm) || null : null,
    versionMajor,
    versionMinor,
    deviceClass,
    deviceClassLabel: deviceClass ? (DEVICE_CLASS_LABELS[deviceClass] ?? null) : null,
    colorSpace,
    pcs,
    creationDate,
    primaryPlatform,
    renderingIntent,
    renderingIntentLabel: renderingIntent != null ? (RENDERING_INTENT_LABELS[renderingIntent] ?? null) : null,
    illuminant,
    creatorSignature,
    description,
    copyright,
    whitePoint,
    redPrimary,
    greenPrimary,
    bluePrimary,
    redGamma,
    tags,
    isSrgbEquivalent,
    judgmentText,
  };
}
