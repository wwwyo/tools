/**
 * メタデータ（Exif / XMP / ICC / コメント等）の検出と、可逆な除去。
 *
 * 除去は「バイト列を再解釈して再構築する」のではなく「対象セグメント/チャンクを
 * 丸ごと読み飛ばして残りをそのまま連結する」方式にする。JPEG も PNG もコンテナ形式であり、
 * セグメント/チャンクの境界さえ正しく見つければ中身を解釈せず安全に削れるため。
 */

import { asciiAt, byteAt, formatBytes } from "./imageMeta";

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

// --- PNG チャンクの CRC 再計算（eXIf の in-place 編集で使う） -----------------------

/** zlib/PNG と同じ CRC-32（多項式 0xEDB88320）のルックアップテーブル */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** PNG チャンクの CRC フィールドと同じ CRC-32 を計算する */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const idx = (crc ^ byteAt(bytes, i)) & 0xff;
    crc = (CRC32_TABLE[idx] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** セグメント（PNG チャンク）のデータ部（type/CRC を除いた中身）の絶対オフセット範囲 */
export function pngChunkDataRange(segment: MetadataSegment): { dataStart: number; dataEnd: number } {
  return { dataStart: segment.start + 8, dataEnd: segment.end - 4 };
}

/**
 * PNG チャンクのデータ部を書き換え、CRC を再計算したコピーを返す（元バッファは変更しない）。
 * チャンク長（length フィールド）は変えない前提のため、newData は元のデータ部と同じ長さでなければならない
 * （eXIf の Exif 編集は固定長 in-place 上書きに限定しているため、この前提は常に成り立つ）。
 */
export function patchPngChunkData(buf: ArrayBuffer, segment: MetadataSegment, newData: Uint8Array): ArrayBuffer {
  const { dataStart, dataEnd } = pngChunkDataRange(segment);
  if (newData.length !== dataEnd - dataStart) {
    throw new Error("patchPngChunkData: newData length must match the original chunk data length");
  }
  const copy = buf.slice(0);
  const bytes = new Uint8Array(copy);
  bytes.set(newData, dataStart);
  const view = new DataView(copy);
  const crcInput = bytes.subarray(segment.start + 4, dataEnd); // type(4) + data
  view.setUint32(dataEnd, crc32(crcInput), false);
  return copy;
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

// --- セグメントの説明・中身プレビュー -----------------------------------------
// セグメント名（MetadataSegment.name）だけを見れば何のデータか分かるエンジニアは少ないため、
// チェックボックスの隣に「何を消すことになるのか」を平易な日本語で一言添える。
// 中身のプレビューは「安価に読めるものだけ」に限定する（zTXt / PNG iCCP の zlib 展開はしない）。

const SEGMENT_DESCRIPTIONS: Record<string, string> = {
  "APP1 Exif": "撮影情報（機種・日時・向き・GPS など）",
  "APP1 XMP": "Adobe 系の編集情報・タグ（XML）",
  "APP1": "未分類の付随データ",
  "APP2 ICC_PROFILE": "カラープロファイル（色の基準。消すと色味が変わることがあります）",
  "APP13 Photoshop": "Photoshop の付随データ（IPTC キャプション等）",
  COM: "コメント文字列",
  eXIf: "撮影情報（機種・日時・向き・GPS など）",
  iCCP: "カラープロファイル（色の基準。消すと色味が変わることがあります）",
  tEXt: "テキスト情報（作者・ソフト名・説明など）",
  zTXt: "テキスト情報（作者・ソフト名・説明など）",
  iTXt: "テキスト情報（作者・ソフト名・説明など）",
  tIME: "最終更新時刻",
  EXIF: "撮影情報（機種・日時・向き・GPS など）",
  "XMP ": "Adobe 系の編集情報・タグ（XML）",
  ICCP: "カラープロファイル（色の基準。消すと色味が変わることがあります）",
};

/** セグメント名から一行の平易な説明を返す（未知の名前は null） */
export function segmentDescription(name: string): string | null {
  return SEGMENT_DESCRIPTIONS[name] ?? null;
}

const PREVIEW_MAX_CHARS = 120;

function truncatePreview(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

/** ASCII/Latin-1 前提でバイト列を文字列化する（tEXt/COM など、この形式が仕様上そう定義されているセグメント用） */
function latin1Decode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(byteAt(bytes, i));
  return s;
}

/** UTF-8 として妥当ならそれを、そうでなければ Latin-1 として読む（COM はエンコーディングを仕様で決めていないため） */
function bestEffortDecode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return latin1Decode(bytes);
  }
}

function indexOfNul(bytes: Uint8Array, from = 0): number {
  for (let i = from; i < bytes.length; i++) {
    if (byteAt(bytes, i) === 0) return i;
  }
  return -1;
}

/** PNG tEXt: keyword\0text（ともに Latin-1） */
function previewPngText(bytes: Uint8Array, segment: MetadataSegment): string | null {
  const { dataStart, dataEnd } = pngChunkDataRange(segment);
  const data = bytes.subarray(dataStart, dataEnd);
  const nul = indexOfNul(data);
  if (nul === -1) return null;
  const keyword = latin1Decode(data.subarray(0, nul));
  const text = latin1Decode(data.subarray(nul + 1));
  return `${keyword}: ${truncatePreview(text)}`;
}

/** PNG iTXt: keyword\0 compFlag(1) compMethod(1) lang\0 translatedKeyword\0 text(UTF-8)。compFlag=0 のときだけ読む */
function previewPngItxt(bytes: Uint8Array, segment: MetadataSegment): string | null {
  const { dataStart, dataEnd } = pngChunkDataRange(segment);
  const data = bytes.subarray(dataStart, dataEnd);
  const nulKeyword = indexOfNul(data);
  if (nulKeyword === -1 || nulKeyword + 1 >= data.length) return null;
  const keyword = latin1Decode(data.subarray(0, nulKeyword));
  const compFlag = byteAt(data, nulKeyword + 1);
  if (compFlag !== 0) return `${keyword}: 圧縮テキスト`;
  const nulLang = indexOfNul(data, nulKeyword + 3); // compFlag(1) + compMethod(1) の次から lang を探す
  if (nulLang === -1) return null;
  const nulTranslated = indexOfNul(data, nulLang + 1);
  if (nulTranslated === -1) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data.subarray(nulTranslated + 1));
  return `${keyword}: ${truncatePreview(text)}`;
}

/** PNG zTXt: 中身は zlib 圧縮のため展開せず、keyword だけを示す */
function previewPngZtxt(bytes: Uint8Array, segment: MetadataSegment): string | null {
  const { dataStart, dataEnd } = pngChunkDataRange(segment);
  const data = bytes.subarray(dataStart, dataEnd);
  const nul = indexOfNul(data);
  if (nul === -1) return null;
  const keyword = latin1Decode(data.subarray(0, nul));
  return `圧縮テキスト（${keyword}）`;
}

/** PNG iCCP: プロファイル本体は zlib 圧縮だが、先頭の keyword（プロファイル名）は無圧縮で読める */
function previewPngIccp(bytes: Uint8Array, segment: MetadataSegment): string | null {
  const { dataStart, dataEnd } = pngChunkDataRange(segment);
  const data = bytes.subarray(dataStart, dataEnd);
  const nul = indexOfNul(data);
  if (nul === -1) return null;
  const keyword = latin1Decode(data.subarray(0, nul));
  return keyword ? `プロファイル名: ${keyword}` : null;
}

/** JPEG COM: コメント文字列そのもの */
function previewJpegCom(bytes: Uint8Array, segment: MetadataSegment): string | null {
  const data = bytes.subarray(segment.start + 4, segment.end); // マーカー(2) + 長さ(2) を読み飛ばす
  const text = bestEffortDecode(data);
  return text ? truncatePreview(text) : null;
}

const XMP_HEADER_LEN = "http://ns.adobe.com/xap/1.0/\0".length; // 29

/** JPEG APP1 XMP: XML はそのまま出さず、サイズと拾えた範囲で CreatorTool / dc:creator だけ添える */
function previewJpegXmp(bytes: Uint8Array, segment: MetadataSegment): string {
  const xmlStart = segment.start + 4 + XMP_HEADER_LEN; // マーカー(2)+長さ(2) + XMP 識別子(29)
  const xmlBytes = bytes.subarray(xmlStart, segment.end);
  const xml = bestEffortDecode(xmlBytes);
  const creatorTool = /CreatorTool[=>]"?([^"<]*)/.exec(xml)?.[1]?.trim();
  const creator = /dc:creator[\s\S]{0,200}?<rdf:li[^>]*>([^<]*)</.exec(xml)?.[1]?.trim();
  let text = `XML, ${formatBytes(xmlBytes.length)}`;
  if (creatorTool) text += ` / CreatorTool: ${creatorTool}`;
  if (creator) text += ` / creator: ${creator}`;
  return text;
}

/**
 * ICC プロファイル本体（ヘッダー128byte + タグテーブル）から desc タグを探し、
 * プロファイル名を返す。textDescriptionType（ASCII, 旧仕様）と mluc（UTF-16BE, 現行仕様）の両方を扱う。
 */
function iccProfileDescription(bytes: Uint8Array, profileStart: number, profileEnd: number): string | null {
  if (profileEnd - profileStart < 132) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tagCount = view.getUint32(profileStart + 128, false);
  let descOffset: number | null = null;
  let descSize: number | null = null;
  for (let i = 0; i < tagCount; i++) {
    const entryOffset = profileStart + 132 + i * 12;
    if (entryOffset + 12 > profileEnd) break;
    if (asciiAt(bytes, entryOffset, 4) === "desc") {
      descOffset = profileStart + view.getUint32(entryOffset + 4, false);
      descSize = view.getUint32(entryOffset + 8, false);
      break;
    }
  }
  if (descOffset == null || descSize == null || descOffset + 12 > profileEnd) return null;

  const typeSig = asciiAt(bytes, descOffset, 4);
  if (typeSig === "desc") {
    // textDescriptionType: type(4) + reserved(4) + asciiCount(4) + ascii（NUL 終端）
    const asciiLen = view.getUint32(descOffset + 8, false);
    const start = descOffset + 12;
    const end = Math.min(start + Math.max(0, asciiLen - 1), profileEnd);
    const text = latin1Decode(bytes.subarray(start, end));
    return text || null;
  }
  if (typeSig === "mluc") {
    // multiLocalizedUnicodeType: type(4) + reserved(4) + recordCount(4) + recordSize(4) + records...
    const recordCount = view.getUint32(descOffset + 8, false);
    if (recordCount === 0) return null;
    const recordLen = view.getUint32(descOffset + 20, false); // 先頭レコードの文字列長（byte）
    const recordOffset = view.getUint32(descOffset + 24, false); // タグ先頭からの相対オフセット
    const strStart = descOffset + recordOffset;
    const strEnd = Math.min(strStart + recordLen, profileEnd);
    let text = "";
    for (let i = strStart; i + 1 < strEnd; i += 2) {
      const code = view.getUint16(i, false);
      if (code !== 0) text += String.fromCharCode(code);
    }
    return text || null;
  }
  return null;
}

/** JPEG APP2 ICC_PROFILE: "ICC_PROFILE\0" + seqNo(1) + numMarkers(1) の後にプロファイル本体が続く */
function previewJpegIcc(bytes: Uint8Array, segment: MetadataSegment): string | null {
  const profileStart = segment.start + 4 + 12 + 2; // マーカー(2)+長さ(2) + "ICC_PROFILE\0"(12) + seqNo+numMarkers(2)
  const desc = iccProfileDescription(bytes, profileStart, segment.end);
  return desc ? `プロファイル名: ${desc}` : null;
}

/**
 * セグメントの中身のうち「解凍・重い解釈をせずに安価に読める」ものだけをプレビュー文字列にする。
 * 対象外（APP1 Exif / eXIf は別枠の Exif テーブルで表示するためここでは扱わない等）や
 * パース失敗時は null を返し、呼び出し側は説明文だけを出す。
 */
export function segmentContentPreview(originalArrayBuffer: ArrayBuffer, segment: MetadataSegment): string | null {
  const bytes = new Uint8Array(originalArrayBuffer);
  try {
    switch (segment.name) {
      case "tEXt":
        return previewPngText(bytes, segment);
      case "iTXt":
        return previewPngItxt(bytes, segment);
      case "zTXt":
        return previewPngZtxt(bytes, segment);
      case "iCCP":
        return previewPngIccp(bytes, segment);
      case "COM":
        return previewJpegCom(bytes, segment);
      case "APP1 XMP":
        return previewJpegXmp(bytes, segment);
      case "APP2 ICC_PROFILE":
        return previewJpegIcc(bytes, segment);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
