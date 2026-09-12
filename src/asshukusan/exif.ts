/**
 * JPEG/TIFF Exif（APP1）の解析・in-place 編集・生成。
 *
 * Exif は APP1 セグメント内に TIFF 形式（IFD の連なり）で入れ子になっている。
 * ここで扱う「編集」は元の IFD エントリの value/offset フィールドを上書きするだけの
 * 固定長編集に限定する（SHORT 1個・ASCII の既存 count と同じ長さの文字列・GPS 値のゼロ埋め）。
 * エントリの追加・削除やタグの count 変更はセグメント全体のバイト長・以降のオフセットを
 * ずらすため、ここでは扱わない（imageMeta.ts / metadataStrip.ts が前提にしている
 * 「セグメント境界だけ動かして中身は解釈しない」設計を崩さないため）。
 */

import { asciiAt } from "./imageMeta";
import { pngChunkDataRange, readNextJpegMarker, type MetadataScanResult } from "./metadataStrip";

/** offset/count がバッファ範囲に収まっているかを検証する（overflow-safe: JS の数値演算に折り返しは無いため単純な加算比較で足りる） */
function isInBounds(totalLength: number, start: number, length: number): boolean {
  return Number.isFinite(start) && Number.isFinite(length) && start >= 0 && length >= 0 && start + length <= totalLength;
}

const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_SOFTWARE = 0x0131;
const TAG_DATETIME = 0x0132;
const TAG_IMAGE_DESCRIPTION = 0x010e;
const TAG_ARTIST = 0x013b;
const TAG_COPYRIGHT = 0x8298;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_GPS_INFO_POINTER = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;

const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;

/** 1個の IFD エントリ（12 byte）の位置と生の値/オフセットフィールド */
export interface ExifIfdEntry {
  tag: number;
  type: number;
  count: number;
  /** payload 内でのこのエントリ自体の開始オフセット（12 byte 分） */
  entryOffset: number;
}

/** payload（"Exif\0\0" から始まる APP1 の中身）を走査して得られる IFD 群の位置情報 */
export interface ExifStructure {
  little: boolean;
  /** TIFF ヘッダーの開始オフセット（"Exif\0\0" の直後、payload 内で常に 6） */
  tiffStart: number;
  ifd0: ExifIfdEntry[];
  ifd0Offset: number;
  exifIfd: ExifIfdEntry[] | null;
  exifIfdOffset: number | null;
  gpsIfd: ExifIfdEntry[] | null;
  gpsIfdOffset: number | null;
  /** IFD0 内の GPSInfo ポインタエントリ（tag 0x8825）。GPS 除去でタグ id を書き換える対象 */
  gpsInfoEntry: ExifIfdEntry | null;
}

/** IFD を読む。offset がバッファ範囲外、またはエントリがバッファ末尾へはみ出す場合は例外を投げる（呼び出し側が IFD 単位で捕まえる） */
function readIfd(view: DataView, little: boolean, ifdAbsOffset: number): ExifIfdEntry[] {
  if (!isInBounds(view.byteLength, ifdAbsOffset, 2)) throw new RangeError("IFD offset out of bounds");
  const count = view.getUint16(ifdAbsOffset, little);
  if (!isInBounds(view.byteLength, ifdAbsOffset + 2, count * 12)) throw new RangeError("IFD entries out of bounds");
  const entries: ExifIfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entryOffset = ifdAbsOffset + 2 + i * 12;
    entries.push({
      tag: view.getUint16(entryOffset, little),
      type: view.getUint16(entryOffset + 2, little),
      count: view.getUint32(entryOffset + 4, little),
      entryOffset,
    });
  }
  return entries;
}

function findEntry(entries: ExifIfdEntry[], tag: number): ExifIfdEntry | undefined {
  return entries.find((e) => e.tag === tag);
}

/** タグだけでなく想定した TIFF 型と一致するエントリだけを返す。型が違う（=壊れている/想定外）タグは無いものとして扱う */
function findTypedEntry(entries: ExifIfdEntry[], tag: number, expectedType: number): ExifIfdEntry | undefined {
  const entry = findEntry(entries, tag);
  return entry && entry.type === expectedType ? entry : undefined;
}

/** payload（"Exif\0\0" + TIFF データ）から IFD0 / Exif IFD / GPS IFD の位置を読む */
export function parseExifStructure(payload: Uint8Array): ExifStructure | null {
  try {
    if (payload.length < 14) return null;
    if (String.fromCharCode(...payload.subarray(0, 5)) !== "Exif\0") return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const tiffStart = 6;
    const byteOrderMark = view.getUint16(tiffStart, false);
    if (byteOrderMark !== 0x4949 && byteOrderMark !== 0x4d4d) return null;
    const little = byteOrderMark === 0x4949;
    const firstIfdRel = view.getUint32(tiffStart + 4, little);
    const ifd0Offset = tiffStart + firstIfdRel;
    const ifd0 = readIfd(view, little, ifd0Offset);

    let exifIfd: ExifIfdEntry[] | null = null;
    let exifIfdOffset: number | null = null;
    let gpsIfd: ExifIfdEntry[] | null = null;
    let gpsIfdOffset: number | null = null;
    let gpsInfoEntry: ExifIfdEntry | null = null;

    // Exif IFD / GPS IFD はそれぞれ独立に試す。片方のポインタが壊れていても
    // （破損ファイル・改ざん等）、もう片方や IFD0 自体は読み取れるようにするため、
    // ここでの失敗は該当 IFD だけを「無い」ものとして扱い、外側の try へは伝播させない
    const exifPointer = findEntry(ifd0, TAG_EXIF_IFD_POINTER);
    if (exifPointer) {
      try {
        const rel = view.getUint32(exifPointer.entryOffset + 8, little);
        const offset = tiffStart + rel;
        exifIfd = readIfd(view, little, offset);
        exifIfdOffset = offset;
      } catch {
        exifIfd = null;
        exifIfdOffset = null;
      }
    }
    const gpsPointer = findEntry(ifd0, TAG_GPS_INFO_POINTER);
    if (gpsPointer) {
      try {
        const rel = view.getUint32(gpsPointer.entryOffset + 8, little);
        const offset = tiffStart + rel;
        gpsIfd = readIfd(view, little, offset);
        gpsIfdOffset = offset;
        gpsInfoEntry = gpsPointer;
      } catch {
        gpsIfd = null;
        gpsIfdOffset = null;
        gpsInfoEntry = null;
      }
    }

    return { little, tiffStart, ifd0, ifd0Offset, exifIfd, exifIfdOffset, gpsIfd, gpsIfdOffset, gpsInfoEntry };
  } catch {
    return null;
  }
}

/** ASCII タグの値を読む。count がバッファ範囲をはみ出す（壊れている）場合は null を返し、タグ無しとして扱う */
function readAscii(payload: Uint8Array, view: DataView, little: boolean, tiffStart: number, entry: ExifIfdEntry): string | null {
  const size = entry.count;
  let start: number;
  if (size <= 4) {
    start = entry.entryOffset + 8;
  } else {
    const rel = view.getUint32(entry.entryOffset + 8, little);
    start = tiffStart + rel;
  }
  if (!isInBounds(payload.length, start, size)) return null;
  let s = "";
  for (let i = 0; i < size; i++) {
    const b = payload[start + i] ?? 0;
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

function readShort(view: DataView, little: boolean, entry: ExifIfdEntry): number {
  return view.getUint16(entry.entryOffset + 8, little);
}

function readRationalAt(view: DataView, little: boolean, abs: number): number {
  const num = view.getUint32(abs, little);
  const den = view.getUint32(abs + 4, little);
  return den === 0 ? 0 : num / den;
}

/** GPS の緯度・経度（3 RATIONAL = deg/min/sec の 24 byte）を読む。範囲外・型不一致なら null（GPS 無しとして扱う） */
function readGpsCoord(
  payload: Uint8Array,
  view: DataView,
  little: boolean,
  tiffStart: number,
  coordEntry: ExifIfdEntry | undefined,
  refEntry: ExifIfdEntry | undefined,
): number | null {
  if (!coordEntry || !refEntry) return null;
  if (coordEntry.count < 3) return null; // deg/min/sec の3つの RATIONAL が必要
  const rel = view.getUint32(coordEntry.entryOffset + 8, little);
  const abs = tiffStart + rel;
  if (!isInBounds(payload.length, abs, 24)) return null;
  const deg = readRationalAt(view, little, abs);
  const min = readRationalAt(view, little, abs + 8);
  const sec = readRationalAt(view, little, abs + 16);
  let value = deg + min / 60 + sec / 3600;
  const ref = readAscii(payload, view, little, tiffStart, refEntry);
  if (ref === "S" || ref === "W") value = -value;
  return value;
}

/** UI テーブルに出す Exif タグ一式 */
export interface ExifTags {
  make: string | null;
  model: string | null;
  software: string | null;
  dateTime: string | null;
  dateTimeOriginal: string | null;
  imageDescription: string | null;
  artist: string | null;
  copyright: string | null;
  orientation: number | null;
  hasGps: boolean;
  gpsLat: number | null;
  gpsLon: number | null;
}

/** parseExifStructure の結果から表示用タグ一式を読み出す */
export function readExifTags(payload: Uint8Array, structure: ExifStructure): ExifTags {
  const { view, little, tiffStart } = viewOf(payload, structure);
  const ifd0 = structure.ifd0;
  const ascii = (tag: number): string | null => {
    const e = findTypedEntry(ifd0, tag, 2);
    return e ? readAscii(payload, view, little, tiffStart, e) : null;
  };
  const orientationEntry = findTypedEntry(ifd0, TAG_ORIENTATION, 3);
  const dateTimeOriginalEntry = structure.exifIfd ? findTypedEntry(structure.exifIfd, TAG_DATETIME_ORIGINAL, 2) : undefined;
  const gpsLatEntry = structure.gpsIfd ? findTypedEntry(structure.gpsIfd, TAG_GPS_LAT, 5) : undefined;
  const gpsLatRefEntry = structure.gpsIfd ? findTypedEntry(structure.gpsIfd, TAG_GPS_LAT_REF, 2) : undefined;
  const gpsLonEntry = structure.gpsIfd ? findTypedEntry(structure.gpsIfd, TAG_GPS_LON, 5) : undefined;
  const gpsLonRefEntry = structure.gpsIfd ? findTypedEntry(structure.gpsIfd, TAG_GPS_LON_REF, 2) : undefined;

  return {
    make: ascii(TAG_MAKE),
    model: ascii(TAG_MODEL),
    software: ascii(TAG_SOFTWARE),
    dateTime: ascii(TAG_DATETIME),
    dateTimeOriginal: dateTimeOriginalEntry ? readAscii(payload, view, little, tiffStart, dateTimeOriginalEntry) : null,
    imageDescription: ascii(TAG_IMAGE_DESCRIPTION),
    artist: ascii(TAG_ARTIST),
    copyright: ascii(TAG_COPYRIGHT),
    orientation: orientationEntry ? readShort(view, little, orientationEntry) : null,
    hasGps: structure.gpsIfd != null,
    gpsLat: readGpsCoord(payload, view, little, tiffStart, gpsLatEntry, gpsLatRefEntry),
    gpsLon: readGpsCoord(payload, view, little, tiffStart, gpsLonEntry, gpsLonRefEntry),
  };
}

function viewOf(payload: Uint8Array, structure: ExifStructure): { view: DataView; little: boolean; tiffStart: number } {
  return {
    view: new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
    little: structure.little,
    tiffStart: structure.tiffStart,
  };
}

/**
 * JPEG バッファから最初の APP1 Exif セグメントの payload を取り出す。
 * マーカー走査は metadataStrip.ts の `readNextJpegMarker` と同じ規則（0xFF fill byte を
 * スキップする）を使い、`FF FF E1` を誤ってマーカー `0xFFFF` と読まないようにする。
 */
export function extractExifPayloadFromJpegHeader(buf: ArrayBuffer): Uint8Array | null {
  try {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    if (view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset < bytes.length) {
      const info = readNextJpegMarker(bytes, offset);
      if (!info) return null;
      const { marker, headerStart } = info;
      if (marker === 0xffd9 || marker === 0xffda) return null;
      if (marker >= 0xffd0 && marker <= 0xffd7) {
        offset = headerStart;
        continue;
      }
      if (headerStart + 2 > bytes.length) return null;
      const length = view.getUint16(headerStart);
      if (length < 2) return null;
      const segEnd = headerStart + length;
      if (segEnd > bytes.length) return null;
      const payloadStart = headerStart + 2;
      if (marker === 0xffe1 && isInBounds(bytes.length, payloadStart, 5) && asciiAt(bytes, payloadStart, 5) === "Exif\0") {
        return bytes.subarray(payloadStart, segEnd);
      }
      offset = segEnd;
    }
    return null;
  } catch {
    return null;
  }
}

/** JPEG APP1 Exif payload / PNG eXIf チャンクの中身を揃えるための "Exif\0\0" ヘッダー（TIFF の前に付く） */
export const EXIF_PAYLOAD_HEADER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

/**
 * JPEG は APP1 Exif の payload（"Exif\0\0" + TIFF）をそのまま、PNG は eXIf チャンクの中身
 * （"Exif\0\0" ヘッダーを持たない生 TIFF）に疑似ヘッダーを被せて、どちらも `parseExifStructure` /
 * `readExifTags` にそのまま渡せる形で取り出す。対象セグメントが無い・形式非対応なら null。
 */
export function extractExifPayload(originalArrayBuffer: ArrayBuffer, sniffedFormat: string, scan: MetadataScanResult): Uint8Array | null {
  if (sniffedFormat === "JPEG") {
    // 呼び出し側は既にファイル全体を ArrayBuffer で持っているため、ここで 64KiB に
    // 再スライスする理由が無い。APP1 が 64KiB 境界付近にあると DataView が範囲外を読もうとして
    // 例外になっていたため、常に完全なバッファをそのまま渡す
    return extractExifPayloadFromJpegHeader(originalArrayBuffer);
  }
  if (sniffedFormat === "PNG") {
    const seg = scan.segments.find((s) => s.name === "eXIf");
    if (!seg) return null;
    const { dataStart, dataEnd } = pngChunkDataRange(seg);
    const tiff = new Uint8Array(originalArrayBuffer).subarray(dataStart, dataEnd);
    const payload = new Uint8Array(EXIF_PAYLOAD_HEADER.length + tiff.length);
    payload.set(EXIF_PAYLOAD_HEADER, 0);
    payload.set(tiff, EXIF_PAYLOAD_HEADER.length);
    return payload;
  }
  return null;
}

/** JPEG の Exif（APP1）から Orientation タグ（0x0112）だけを読む軽量パス */
export function parseJpegExifOrientation(buf: ArrayBuffer): number | null {
  const payload = extractExifPayloadFromJpegHeader(buf);
  if (!payload) return null;
  const structure = parseExifStructure(payload);
  if (!structure) return null;
  const entry = findEntry(structure.ifd0, TAG_ORIENTATION);
  if (!entry) return null;
  const { view, little } = viewOf(payload, structure);
  return readShort(view, little, entry);
}

/** Exif フィールドの編集内容。固定長のフィールドのみ扱う（詳細は本ファイル冒頭コメント） */
export interface ExifEdits {
  orientation?: number;
  dateTime?: string;
  dateTimeOriginal?: string;
  removeGps: boolean;
}

const DATETIME_PATTERN = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/;

function writeAsciiInPlace(bytes: Uint8Array, view: DataView, little: boolean, tiffStart: number, entry: ExifIfdEntry, value: string): void {
  // ASCII 型以外・count が既存の固定長（NUL 込み）を超える場合は書き込まない。19 文字 + NUL = 20 byte
  // ちょうどの DateTime 系タグにしか安全に書き込めないため、count が合わないときはスキップする
  if (entry.type !== 2 || !DATETIME_PATTERN.test(value) || entry.count < value.length + 1) return;
  const start = entry.count <= 4 ? entry.entryOffset + 8 : tiffStart + view.getUint32(entry.entryOffset + 8, little);
  if (!isInBounds(bytes.length, start, entry.count)) return;
  for (let i = 0; i < value.length; i++) bytes[start + i] = value.charCodeAt(i);
  for (let i = value.length; i < entry.count; i++) bytes[start + i] = 0; // 残りは NUL 埋め
}

/**
 * GPS IFD の各エントリの値領域をゼロ埋めし、IFD のエントリ数を 0 に、IFD0 の GPSInfo
 * ポインタのタグ id を 0xFFFF（private/unused）に書き換える。
 *
 * ファイルサイズは変えない（バイト列の伸縮はセグメント境界より後ろのオフセットをずらすため
 * ここでは扱わない）ので、GPS の生バイトは物理的にファイル内に残り続ける。それでも
 * 「座標値そのものをゼロで上書きする」+「IFD からたどり着けなくする」の二重で、
 * 標準的な Exif リーダーが GPS 情報を復元できないようにしている。
 */
function zeroOutGps(bytes: Uint8Array, view: DataView, little: boolean, tiffStart: number, structure: ExifStructure): void {
  if (!structure.gpsIfd || structure.gpsIfdOffset == null || !structure.gpsInfoEntry) return;
  for (const entry of structure.gpsIfd) {
    const typeSize = TIFF_TYPE_SIZE[entry.type] ?? 1;
    const valueBytes = typeSize * entry.count;
    if (valueBytes > 4) {
      const rel = view.getUint32(entry.entryOffset + 8, little);
      const abs = tiffStart + rel;
      // ゼロ埋めの範囲は検証済みのバイト範囲に限定する。壊れた count で
      // バッファ外まで書きに行かないようにするため
      if (isInBounds(bytes.length, abs, valueBytes)) {
        for (let i = 0; i < valueBytes; i++) bytes[abs + i] = 0;
      }
    }
    if (isInBounds(bytes.length, entry.entryOffset + 8, 4)) {
      for (let i = 0; i < 4; i++) bytes[entry.entryOffset + 8 + i] = 0;
    }
  }
  if (isInBounds(bytes.length, structure.gpsIfdOffset, 2)) view.setUint16(structure.gpsIfdOffset, 0, little); // GPS IFD のエントリ数を 0 に
  if (isInBounds(bytes.length, structure.gpsInfoEntry.entryOffset, 2)) {
    view.setUint16(structure.gpsInfoEntry.entryOffset, 0xffff, little); // タグ id を private/unused に
  }
}

/**
 * Exif payload（"Exif\0\0" + TIFF データ）に固定長編集を適用したコピーを返す。
 * 入力を書き換えず、常に同じ長さの新しい Uint8Array を返す（セグメント長を変えない前提のため）。
 */
export function applyExifEdits(exifPayload: Uint8Array, edits: ExifEdits): Uint8Array {
  const bytes = exifPayload.slice();
  const structure = parseExifStructure(bytes);
  if (!structure) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { little, tiffStart } = structure;

  if (edits.orientation != null) {
    const entry = findEntry(structure.ifd0, TAG_ORIENTATION);
    if (entry && entry.type === 3) view.setUint16(entry.entryOffset + 8, edits.orientation, little);
  }
  if (edits.dateTime != null) {
    const entry = findEntry(structure.ifd0, TAG_DATETIME);
    if (entry) writeAsciiInPlace(bytes, view, little, tiffStart, entry, edits.dateTime);
  }
  if (edits.dateTimeOriginal != null && structure.exifIfd) {
    const entry = findEntry(structure.exifIfd, TAG_DATETIME_ORIGINAL);
    if (entry) writeAsciiInPlace(bytes, view, little, tiffStart, entry, edits.dateTimeOriginal);
  }
  if (edits.removeGps) {
    zeroOutGps(bytes, view, little, tiffStart, structure);
  }

  return bytes;
}

// --- サンプル画像用の Exif APP1 生成 ----------------------------------------

interface RationalDms {
  deg: number;
  min: number;
  secNum: number;
  secDen: number;
}

function toDms(decimal: number): RationalDms {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return { deg, min, secNum: Math.round(sec * 1000), secDen: 1000 };
}

/**
 * サンプル画像だけが使う、テスト可能性のための最小 Exif APP1 ビルダー。
 * IFD0（Make/Model/Orientation + ExifIFD/GPSInfo ポインタ）→ Exif IFD（DateTimeOriginal）
 * → GPS IFD（緯度経度）の順に手組みする。TIFF は II（little-endian）固定。
 */
export function buildExifApp1(opts: {
  make: string;
  model: string;
  dateTimeOriginal: string;
  orientation: number;
  lat: number;
  lon: number;
}): Uint8Array {
  const enc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  const makeBytes = [...enc(opts.make), 0];
  const modelBytes = [...enc(opts.model), 0];
  const dtoBytes = [...enc(opts.dateTimeOriginal), 0];

  const IFD0_OFFSET = 8;
  const IFD0_ENTRY_COUNT = 5; // Make, Model, Orientation, ExifIFD pointer, GPSInfo pointer
  const IFD0_SIZE = 2 + IFD0_ENTRY_COUNT * 12 + 4;
  const MAKE_DATA_OFFSET = IFD0_OFFSET + IFD0_SIZE;
  const MODEL_DATA_OFFSET = MAKE_DATA_OFFSET + makeBytes.length;

  const EXIF_IFD_OFFSET = MODEL_DATA_OFFSET + modelBytes.length;
  const EXIF_IFD_ENTRY_COUNT = 1; // DateTimeOriginal
  const EXIF_IFD_SIZE = 2 + EXIF_IFD_ENTRY_COUNT * 12 + 4;
  const DTO_DATA_OFFSET = EXIF_IFD_OFFSET + EXIF_IFD_SIZE;

  const GPS_IFD_OFFSET = DTO_DATA_OFFSET + dtoBytes.length;
  const GPS_IFD_ENTRY_COUNT = 4; // LatRef, Lat, LonRef, Lon
  const GPS_IFD_SIZE = 2 + GPS_IFD_ENTRY_COUNT * 12 + 4;
  const GPS_LAT_DATA_OFFSET = GPS_IFD_OFFSET + GPS_IFD_SIZE;
  const GPS_LON_DATA_OFFSET = GPS_LAT_DATA_OFFSET + 24;

  const totalTiffSize = GPS_LON_DATA_OFFSET + 24;
  const buf = new ArrayBuffer(totalTiffSize);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const little = true;

  // TIFF header
  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 0x002a, little);
  view.setUint32(4, IFD0_OFFSET, little);

  function writeEntry(entryOffset: number, tag: number, type: number, count: number, valueOrOffset: number): void {
    view.setUint16(entryOffset, tag, little);
    view.setUint16(entryOffset + 2, type, little);
    view.setUint32(entryOffset + 4, count, little);
    view.setUint32(entryOffset + 8, valueOrOffset, little);
  }

  // IFD0
  view.setUint16(IFD0_OFFSET, IFD0_ENTRY_COUNT, little);
  writeEntry(IFD0_OFFSET + 2 + 0 * 12, TAG_MAKE, 2, makeBytes.length, MAKE_DATA_OFFSET);
  writeEntry(IFD0_OFFSET + 2 + 1 * 12, TAG_MODEL, 2, modelBytes.length, MODEL_DATA_OFFSET);
  writeEntry(IFD0_OFFSET + 2 + 2 * 12, TAG_ORIENTATION, 3, 1, opts.orientation);
  writeEntry(IFD0_OFFSET + 2 + 3 * 12, TAG_EXIF_IFD_POINTER, 4, 1, EXIF_IFD_OFFSET);
  writeEntry(IFD0_OFFSET + 2 + 4 * 12, TAG_GPS_INFO_POINTER, 4, 1, GPS_IFD_OFFSET);
  view.setUint32(IFD0_OFFSET + 2 + IFD0_ENTRY_COUNT * 12, 0, little); // next IFD = なし
  bytes.set(makeBytes, MAKE_DATA_OFFSET);
  bytes.set(modelBytes, MODEL_DATA_OFFSET);

  // Exif IFD
  view.setUint16(EXIF_IFD_OFFSET, EXIF_IFD_ENTRY_COUNT, little);
  writeEntry(EXIF_IFD_OFFSET + 2, TAG_DATETIME_ORIGINAL, 2, dtoBytes.length, DTO_DATA_OFFSET);
  view.setUint32(EXIF_IFD_OFFSET + 2 + EXIF_IFD_ENTRY_COUNT * 12, 0, little);
  bytes.set(dtoBytes, DTO_DATA_OFFSET);

  // GPS IFD
  const latDms = toDms(opts.lat);
  const lonDms = toDms(opts.lon);
  view.setUint16(GPS_IFD_OFFSET, GPS_IFD_ENTRY_COUNT, little);
  writeEntry(GPS_IFD_OFFSET + 2 + 0 * 12, TAG_GPS_LAT_REF, 2, 2, (opts.lat >= 0 ? "N" : "S").charCodeAt(0));
  writeEntry(GPS_IFD_OFFSET + 2 + 1 * 12, TAG_GPS_LAT, 5, 3, GPS_LAT_DATA_OFFSET);
  writeEntry(GPS_IFD_OFFSET + 2 + 2 * 12, TAG_GPS_LON_REF, 2, 2, (opts.lon >= 0 ? "E" : "W").charCodeAt(0));
  writeEntry(GPS_IFD_OFFSET + 2 + 3 * 12, TAG_GPS_LON, 5, 3, GPS_LON_DATA_OFFSET);
  view.setUint32(GPS_IFD_OFFSET + 2 + GPS_IFD_ENTRY_COUNT * 12, 0, little);

  function writeRational3(offset: number, dms: RationalDms): void {
    view.setUint32(offset, dms.deg, little);
    view.setUint32(offset + 4, 1, little);
    view.setUint32(offset + 8, dms.min, little);
    view.setUint32(offset + 12, 1, little);
    view.setUint32(offset + 16, dms.secNum, little);
    view.setUint32(offset + 20, dms.secDen, little);
  }
  writeRational3(GPS_LAT_DATA_OFFSET, latDms);
  writeRational3(GPS_LON_DATA_OFFSET, lonDms);

  // "Exif\0\0" + TIFF データを 1 本の APP1 セグメント（マーカー + 長さ込み）にする
  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const payloadLength = exifHeader.length + totalTiffSize;
  const segmentLength = payloadLength + 2; // 長さフィールド自身の 2 byte を含む
  const segment = new Uint8Array(2 + 2 + payloadLength);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment[2] = (segmentLength >> 8) & 0xff;
  segment[3] = segmentLength & 0xff;
  segment.set(exifHeader, 4);
  segment.set(bytes, 4 + exifHeader.length);
  return segment;
}
