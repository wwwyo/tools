/**
 * メタデータ（Exif / XMP / ICC / コメント等）の検出と、可逆な除去。
 *
 * 除去は「バイト列を再解釈して再構築する」のではなく「対象セグメント/チャンクを
 * 丸ごと読み飛ばして残りをそのまま連結する」方式にする。JPEG も PNG もコンテナ形式であり、
 * セグメント/チャンクの境界さえ正しく見つければ中身を解釈せず安全に削れるため。
 */

import { asciiAt, byteAt } from "./imageMeta";

/** 検出した1セグメント/チャンク分の情報 */
export interface MetadataSegment {
  /** 同名セグメントが複数あっても一意になる安定 id（例: "COM#0"）。チェックボックスの選択状態のキー */
  id: string;
  name: string;
  bytes: number;
  /** 元バッファ内でのこのセグメント/チャンクの開始・終了オフセット（マーカー/チャンクヘッダーを含む） */
  start: number;
  end: number;
}

/** 元ファイルのメタデータ走査結果 */
export interface MetadataScanResult {
  format: "jpeg" | "png" | "webp" | "other";
  segments: MetadataSegment[];
  totalBytes: number;
  /** ロスレスに除去できるか。WebP は RIFF サイズ/VP8X flags の再計算が必要でリスクがあるため false 固定 */
  strippable: boolean;
}

function concatUint8Arrays(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

// --- JPEG ---------------------------------------------------------------

/**
 * APPn / COM セグメントのうちメタデータとして除去対象になるものだけラベルを返す。
 * APP0 (JFIF) や DQT/SOF/DHT/SOS などデコードに必要なセグメントは null を返し素通りさせる。
 */
function classifyJpegSegment(marker: number, bytes: Uint8Array, payloadStart: number): string | null {
  if (marker === 0xffe1) {
    if (asciiAt(bytes, payloadStart, 6) === "Exif\0\0") return "APP1 Exif";
    if (asciiAt(bytes, payloadStart, 29) === "http://ns.adobe.com/xap/1.0/") return "APP1 XMP";
    return "APP1"; // 未知の APP1 も JFIF 以外の付随データなので除去対象に含める
  }
  if (marker === 0xffe2) return "APP2 ICC_PROFILE";
  if (marker === 0xffed) return "APP13 Photoshop";
  if (marker === 0xfffe) return "COM";
  return null;
}

/** JPEG のマーカー列を SOS まで走査する。onSegment は素通りマーカーにも呼ばれ、null 判定は呼び出し側が行う */
function walkJpegMarkers(
  bytes: Uint8Array,
  view: DataView,
  onMarker: (marker: number, segStart: number, segEnd: number, label: string | null) => void,
): number {
  let offset = 2; // SOI を読み飛ばす
  while (offset + 4 <= bytes.length) {
    if (byteAt(bytes, offset) !== 0xff) break;
    const marker = view.getUint16(offset);
    if (marker === 0xffd9) break; // EOI: メタデータはこれより前にしか現れない
    if (marker === 0xffda) return offset; // SOS: ここから先は圧縮データなのでマーカー走査を終える
    if (marker >= 0xffd0 && marker <= 0xffd7) {
      // RST0-7 は長さを持たない。DQT(0xFFDB) 等の隣接マーカーまで巻き込まないよう範囲を厳密にする
      onMarker(marker, offset, offset + 2, null);
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    const segEnd = offset + 2 + length;
    const label = classifyJpegSegment(marker, bytes, offset + 4);
    onMarker(marker, offset, segEnd, label);
    offset = segEnd;
  }
  return bytes.length;
}

/** 同名セグメント/チャンクが複数あっても一意になる id を振る。scan と strip で同じ規則を使う */
function nextId(counts: Map<string, number>, name: string): string {
  const idx = counts.get(name) ?? 0;
  counts.set(name, idx + 1);
  return `${name}#${idx}`;
}

function scanJpegMetadata(buf: ArrayBuffer): MetadataScanResult {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const segments: MetadataSegment[] = [];
  const counts = new Map<string, number>();
  walkJpegMarkers(bytes, view, (_marker, segStart, segEnd, label) => {
    if (label) segments.push({ id: nextId(counts, label), name: label, bytes: segEnd - segStart, start: segStart, end: segEnd });
  });
  return {
    format: "jpeg",
    segments,
    totalBytes: segments.reduce((sum, s) => sum + s.bytes, 0),
    strippable: true,
  };
}

/** 選ばれたセグメント（id）だけを読み飛ばして JPEG を再構築する（デコードに必要な部分は一切変更しない） */
function stripJpegMetadata(buf: ArrayBuffer, removeIds: ReadonlySet<string>): ArrayBuffer {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  const counts = new Map<string, number>();
  const sosOffset = walkJpegMarkers(bytes, view, (_marker, segStart, segEnd, label) => {
    if (!label) {
      chunks.push(bytes.subarray(segStart, segEnd));
      return;
    }
    const id = nextId(counts, label);
    if (!removeIds.has(id)) chunks.push(bytes.subarray(segStart, segEnd));
  });
  chunks.push(bytes.subarray(sosOffset)); // SOS 以降（スキャンデータ + EOI）はそのまま連結
  return concatUint8Arrays(chunks);
}

// --- PNG ------------------------------------------------------------------

/** 除去対象の PNG 補助チャンク（デコードに不要なもののみ） */
const PNG_STRIP_CHUNK_TYPES = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "iCCP", "tIME"]);

function walkPngChunks(
  bytes: Uint8Array,
  view: DataView,
  onChunk: (type: string, start: number, end: number) => void,
): void {
  let offset = 8; // PNG シグネチャ
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = asciiAt(bytes, offset + 4, 4);
    const end = offset + 8 + length + 4; // len(4) + type(4) + data(length) + CRC(4)
    onChunk(type, offset, Math.min(end, bytes.length));
    offset = end;
    if (type === "IEND") break;
  }
}

function scanPngMetadata(buf: ArrayBuffer): MetadataScanResult {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const segments: MetadataSegment[] = [];
  const counts = new Map<string, number>();
  walkPngChunks(bytes, view, (type, start, end) => {
    if (PNG_STRIP_CHUNK_TYPES.has(type)) segments.push({ id: nextId(counts, type), name: type, bytes: end - start, start, end });
  });
  return {
    format: "png",
    segments,
    totalBytes: segments.reduce((sum, s) => sum + s.bytes, 0),
    strippable: true,
  };
}

function stripPngMetadata(buf: ArrayBuffer, removeIds: ReadonlySet<string>): ArrayBuffer {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)]; // シグネチャ
  const counts = new Map<string, number>();
  walkPngChunks(bytes, view, (type, start, end) => {
    if (!PNG_STRIP_CHUNK_TYPES.has(type)) {
      chunks.push(bytes.subarray(start, end));
      return;
    }
    const id = nextId(counts, type);
    if (!removeIds.has(id)) chunks.push(bytes.subarray(start, end));
  });
  return concatUint8Arrays(chunks);
}

// --- WebP -------------------------------------------------------------------

/**
 * WebP は EXIF/XMP/ICCP チャンクを読み飛ばすだけでは済まない。RIFF 全体のサイズと、
 * 拡張ヘッダー VP8X の flags ビット（該当チャンクの有無を示す）を整合させて書き換える必要があり、
 * 誤ると壊れたファイルになる。検出のみ行い、除去は行わない（安全側に倒す）。
 */
const WEBP_METADATA_CHUNKS: Record<string, string> = {
  EXIF: "EXIF",
  XMP: "XMP ",
  ICCP: "ICCP",
};

function scanWebpMetadata(buf: ArrayBuffer): MetadataScanResult {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const segments: MetadataSegment[] = [];
  const counts = new Map<string, number>();
  let offset = 12; // "RIFF" + size(4) + "WEBP"
  while (offset + 8 <= bytes.length) {
    const fourCc = asciiAt(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const paddedSize = size + (size % 2);
    const chunkEnd = offset + 8 + paddedSize;
    const name = WEBP_METADATA_CHUNKS[fourCc];
    if (name) segments.push({ id: nextId(counts, name), name, bytes: 8 + paddedSize, start: offset, end: chunkEnd });
    offset = chunkEnd;
  }
  return {
    format: "webp",
    segments,
    totalBytes: segments.reduce((sum, s) => sum + s.bytes, 0),
    strippable: false,
  };
}

// --- 公開 API ---------------------------------------------------------------

/** 元ファイルのバイト列を走査し、フォーマット別にメタデータセグメント一覧を返す */
export function scanMetadata(buf: ArrayBuffer, sniffedFormat: string): MetadataScanResult {
  if (sniffedFormat === "JPEG") return scanJpegMetadata(buf);
  if (sniffedFormat === "PNG") return scanPngMetadata(buf);
  if (sniffedFormat === "WebP") return scanWebpMetadata(buf);
  return { format: "other", segments: [], totalBytes: 0, strippable: false };
}

/** ロスレスに、選んだセグメント（id）だけを除去したバイト列を返す。除去に対応しない形式は null を返す */
export function stripMetadata(buf: ArrayBuffer, sniffedFormat: string, removeIds: ReadonlySet<string>): ArrayBuffer | null {
  if (sniffedFormat === "JPEG") return stripJpegMetadata(buf, removeIds);
  if (sniffedFormat === "PNG") return stripPngMetadata(buf, removeIds);
  return null;
}

/**
 * canvas 再エンコード後の JPEG（SOI の直後、APP0 があればその直後）に、元ファイルから
 * 抜き出した完全な形のセグメント（マーカー + 長さ + payload）を差し込む。
 * canvas 出力は Exif 等を一切持たないため、削除ではなく挿入だけを行う単純な操作で足りる。
 */
export function insertJpegSegments(jpegBuf: ArrayBuffer, segments: Uint8Array[]): ArrayBuffer {
  if (segments.length === 0) return jpegBuf;
  const bytes = new Uint8Array(jpegBuf);
  const view = new DataView(jpegBuf);
  let insertAt = 2; // SOI の直後
  if (bytes.length > 4 && view.getUint16(2) === 0xffe0) {
    const app0Length = view.getUint16(4);
    insertAt = 4 + app0Length; // APP0 の直後
  }
  const before = bytes.subarray(0, insertAt);
  const after = bytes.subarray(insertAt);
  const totalLength = before.length + segments.reduce((sum, seg) => sum + seg.length, 0) + after.length;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  out.set(before, offset);
  offset += before.length;
  for (const seg of segments) {
    out.set(seg, offset);
    offset += seg.length;
  }
  out.set(after, offset);
  return out.buffer;
}
