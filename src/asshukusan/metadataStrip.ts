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
  /**
   * ペイロード（マーカー/チャンクヘッダーの直後）の開始オフセット。JPEG は 0xFF の fill byte
   * （ITU-T T.81 B.1.1.5）が任意個数入りうるため `start + 4` では実際のマーカーコード位置とずれる。
   * ここには `readNextJpegMarker` が返す `headerStart + 2`（長さフィールドの直後）を入れる。
   * PNG チャンク・WebP チャンクはヘッダーが固定 8 byte のため `start + 8` になる。
   */
  payloadStart: number;
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

/** 標準 XMP の名前空間 URI 識別子。29 byte 目の NUL まで含めて比較する（仕様上 NUL 込みで固定長） */
export const XMP_APP1_HEADER = "http://ns.adobe.com/xap/1.0/\0";

/** ICC プロファイルの識別子（"ICC_PROFILE" + NUL の 12 byte） */
const ICC_APP2_HEADER = "ICC_PROFILE\0";

/** MPO（マルチピクチャフォーマット）の索引を持つ APP2 の識別子（"MPF" + NUL の 4 byte） */
const MPF_APP2_HEADER = "MPF\0";

/**
 * APPn / COM セグメントのうちメタデータとして除去対象になるものだけラベルを返す。
 * APP0 (JFIF) や DQT/SOF/DHT/SOS などデコードに必要なセグメントは null を返し素通りさせる。
 */
function classifyJpegSegment(marker: number, bytes: Uint8Array, payloadStart: number): string | null {
  if (marker === 0xffe1) {
    if (asciiAt(bytes, payloadStart, 6) === "Exif\0\0") return "APP1 Exif";
    if (asciiAt(bytes, payloadStart, XMP_APP1_HEADER.length) === XMP_APP1_HEADER) return "APP1 XMP";
    return "APP1"; // 未知の APP1 も JFIF 以外の付随データなので除去対象に含める
  }
  if (marker === 0xffe2) {
    if (asciiAt(bytes, payloadStart, ICC_APP2_HEADER.length) === ICC_APP2_HEADER) return "APP2 ICC_PROFILE";
    // MPO の副画像索引（MPF）は既定で保持したい未知データの代表例のため、専用ラベルを分ける
    if (asciiAt(bytes, payloadStart, MPF_APP2_HEADER.length) === MPF_APP2_HEADER) return "APP2 MPF";
    return "APP2"; // それ以外の未知 APP2 も、正体不明のまま既定で保持する付随データとして扱う
  }
  if (marker === 0xffed) return "APP13 Photoshop";
  if (marker === 0xfffe) return "COM";
  return null;
}

/**
 * JPEG マーカーの位置を1つ読む。マーカーコードの前には 0xFF の fill byte
 * （ITU-T T.81 B.1.1.5）が任意個数続きうるため、0xFF の連続をスキップして最初の
 * 非 0xFF バイトをマーカーコードとして扱う（`FF FF E1` を `0xFFFF` と誤認しない）。
 * `FF 00` はスタッフィングバイトでヘッダー領域には現れないはずのため、見つけたら
 * 構造エラーとして扱う。読めない・壊れている場合は null を返す。
 */
export function readNextJpegMarker(
  bytes: Uint8Array,
  offset: number,
): { marker: number; segStart: number; headerStart: number } | null {
  if (offset >= bytes.length || byteAt(bytes, offset) !== 0xff) return null;
  const segStart = offset;
  let p = offset + 1;
  while (p < bytes.length && byteAt(bytes, p) === 0xff) p++;
  if (p >= bytes.length) return null;
  const low = byteAt(bytes, p);
  if (low === 0x00) return null;
  return { marker: 0xff00 | low, segStart, headerStart: p + 1 };
}

/**
 * JPEG のマーカー列を SOS まで走査する。onSegment は素通りマーカーにも呼ばれ、null 判定は呼び出し側が行う。
 * `ok: false` は構造的に壊れている（長さが不正・範囲外）ことを表し、呼び出し側は原本を無加工で通す。
 * onMarker の最後の引数 `headerStart` は `readNextJpegMarker` が返すマーカーコード直後の位置で、
 * 呼び出し側が payload の開始（`headerStart + 2`。長さフィールドの直後）を求めるのに使う。
 */
function walkJpegMarkers(
  bytes: Uint8Array,
  view: DataView,
  onMarker: (marker: number, segStart: number, segEnd: number, label: string | null, headerStart: number) => void,
): { sosOffset: number; ok: boolean } {
  let offset = 2; // SOI を読み飛ばす
  while (offset < bytes.length) {
    const info = readNextJpegMarker(bytes, offset);
    if (!info) return { sosOffset: bytes.length, ok: false };
    const { marker, segStart, headerStart } = info;
    if (marker === 0xffd9) return { sosOffset: bytes.length, ok: true }; // EOI: メタデータはこれより前にしか現れない
    if (marker === 0xffda) return { sosOffset: segStart, ok: true }; // SOS: ここから先は圧縮データなのでマーカー走査を終える
    if (marker >= 0xffd0 && marker <= 0xffd7) {
      // RST0-7 は長さを持たない
      onMarker(marker, segStart, headerStart, null, headerStart);
      offset = headerStart;
      continue;
    }
    if (headerStart + 2 > bytes.length) return { sosOffset: bytes.length, ok: false };
    const length = view.getUint16(headerStart);
    if (length < 2) return { sosOffset: bytes.length, ok: false }; // 長さフィールド自身の2byteを含むため最小2
    const segEnd = headerStart + length;
    if (segEnd > bytes.length) return { sosOffset: bytes.length, ok: false };
    const label = classifyJpegSegment(marker, bytes, headerStart + 2);
    onMarker(marker, segStart, segEnd, label, headerStart);
    offset = segEnd;
  }
  return { sosOffset: bytes.length, ok: true };
}

/** 同名セグメント/チャンクが複数あっても一意になる id を振る。scan と strip で同じ規則を使う */
function nextId(counts: Map<string, number>, name: string): string {
  const idx = counts.get(name) ?? 0;
  counts.set(name, idx + 1);
  return `${name}#${idx}`;
}

/** APP2 ICC_PROFILE の seqNo/numMarkers（"ICC_PROFILE\0"(12) の直後の2byte）を読む。読めなければ null */
function iccMarkerInfo(bytes: Uint8Array, payloadStart: number): { seqNo: number; numMarkers: number } | null {
  const p = payloadStart + ICC_APP2_HEADER.length;
  if (p + 2 > bytes.length) return null;
  return { seqNo: byteAt(bytes, p), numMarkers: byteAt(bytes, p + 1) };
}

/** 複数チャンクに分割された ICC プロファイル（有効なグループ）は全チャンクへ同じ id を振り、1つのチェックボックスで一括除去できるようにする */
const ICC_GROUP_ID = "APP2 ICC_PROFILE#group";

interface IccPieceInfo {
  segStart: number;
  segEnd: number;
  payloadStart: number;
  seqNo: number;
  numMarkers: number;
}

/** バッファ全体を1回走査し、APP2 ICC_PROFILE の各ピースの位置・seqNo/numMarkers を集める */
function collectIccPieces(bytes: Uint8Array, view: DataView): IccPieceInfo[] {
  const pieces: IccPieceInfo[] = [];
  walkJpegMarkers(bytes, view, (_marker, segStart, segEnd, label, headerStart) => {
    if (label !== "APP2 ICC_PROFILE") return;
    const payloadStart = headerStart + 2;
    const info = iccMarkerInfo(bytes, payloadStart);
    if (info) pieces.push({ segStart, segEnd, payloadStart, seqNo: info.seqNo, numMarkers: info.numMarkers });
  });
  return pieces;
}

/**
 * 分割 ICC を1グループとして扱ってよいかを判定する。全ピースが同じ numMarkers を共有し、
 * seqNo が 1..numMarkers を過不足なく1回ずつ覆っているときだけ有効なグループとみなし、
 * そのグループに属する segStart の集合を返す。条件を満たさない（壊れている・混線している）
 * 場合は空集合を返し、呼び出し側は各ピースを個別セグメントとして扱う
 */
function validIccGroupSegStarts(pieces: IccPieceInfo[]): ReadonlySet<number> {
  if (pieces.length < 2) return new Set();
  const numMarkers = pieces[0]?.numMarkers ?? 0;
  if (numMarkers < 2 || pieces.length !== numMarkers) return new Set();
  if (!pieces.every((p) => p.numMarkers === numMarkers)) return new Set();
  const seqNos = pieces.map((p) => p.seqNo).toSorted((a, b) => a - b);
  for (let i = 0; i < numMarkers; i++) {
    if (seqNos[i] !== i + 1) return new Set();
  }
  return new Set(pieces.map((p) => p.segStart));
}

function jpegSegmentId(segStart: number, label: string, counts: Map<string, number>, iccGroupSegStarts: ReadonlySet<number>): string {
  if (label === "APP2 ICC_PROFILE" && iccGroupSegStarts.has(segStart)) return ICC_GROUP_ID;
  return nextId(counts, label);
}

/** グループ化された ICC ピースを1行（バイト数の合計・先頭ピース基準の範囲）へまとめる。UI で同じ id のチェックボックスが複数出るのを防ぐ */
function mergeIccGroup(segments: MetadataSegment[]): MetadataSegment[] {
  const groupSegs = segments.filter((s) => s.id === ICC_GROUP_ID);
  if (groupSegs.length < 2) return segments;
  const first = groupSegs[0];
  const last = groupSegs[groupSegs.length - 1];
  if (!first || !last) return segments;
  const merged: MetadataSegment = {
    id: ICC_GROUP_ID,
    name: "APP2 ICC_PROFILE",
    bytes: groupSegs.reduce((sum, s) => sum + s.bytes, 0),
    start: first.start,
    end: last.end,
    payloadStart: first.payloadStart, // プロファイル名プレビューは先頭ピースの ICC ヘッダーから読む
  };
  const result: MetadataSegment[] = [];
  let inserted = false;
  for (const seg of segments) {
    if (seg.id === ICC_GROUP_ID) {
      if (!inserted) {
        result.push(merged);
        inserted = true;
      }
      continue;
    }
    result.push(seg);
  }
  return result;
}

/**
 * JPEG APP2 ICC_PROFILE の実プロファイルバイト列を返す。分割グループ（`ICC_GROUP_ID`）の場合、
 * `segment.start`〜`segment.end` は各ピースのマーカー・長さ・14byte ICC ヘッダーを挟んで
 * 連続しているだけでプロファイル本体としては連結できないため、バッファを再走査して
 * 全ピースを集め、seqNo 順に「ICC_PROFILE\0 + seqNo + numMarkers」の14byteヘッダーを
 * 剥がしたペイロードだけを連結する。単一ピースならヘッダーを剥がすだけで済む。
 */
export function extractIccProfileBytes(originalArrayBuffer: ArrayBuffer, segment: MetadataSegment): Uint8Array | null {
  if (segment.name !== "APP2 ICC_PROFILE") return null;
  const bytes = new Uint8Array(originalArrayBuffer);
  if (segment.id !== ICC_GROUP_ID) {
    const profileStart = segment.payloadStart + ICC_APP2_HEADER.length + 2;
    if (profileStart > segment.end) return null;
    return bytes.subarray(profileStart, segment.end);
  }
  const view = new DataView(originalArrayBuffer);
  const pieces = collectIccPieces(bytes, view);
  const validStarts = validIccGroupSegStarts(pieces);
  if (validStarts.size === 0) return null;
  const ordered = pieces.filter((p) => validStarts.has(p.segStart)).toSorted((a, b) => a.seqNo - b.seqNo);
  const parts = ordered.map((p) => bytes.subarray(p.payloadStart + ICC_APP2_HEADER.length + 2, p.segEnd));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function scanJpegMetadata(buf: ArrayBuffer): MetadataScanResult {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const iccGroupSegStarts = validIccGroupSegStarts(collectIccPieces(bytes, view));
  const segments: MetadataSegment[] = [];
  const counts = new Map<string, number>();
  const { ok } = walkJpegMarkers(bytes, view, (_marker, segStart, segEnd, label, headerStart) => {
    if (!label) return;
    const payloadStart = headerStart + 2;
    const id = jpegSegmentId(segStart, label, counts, iccGroupSegStarts);
    segments.push({ id, name: label, bytes: segEnd - segStart, start: segStart, end: segEnd, payloadStart });
  });
  const merged = ok ? mergeIccGroup(segments) : [];
  return {
    format: "jpeg",
    segments: merged,
    totalBytes: ok ? merged.reduce((sum, s) => sum + s.bytes, 0) : 0,
    strippable: ok,
  };
}

/** 選ばれたセグメント（id）だけを読み飛ばして JPEG を再構築する（デコードに必要な部分は一切変更しない） */
function stripJpegMetadata(buf: ArrayBuffer, removeIds: ReadonlySet<string>): ArrayBuffer {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const iccGroupSegStarts = validIccGroupSegStarts(collectIccPieces(bytes, view));
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  const counts = new Map<string, number>();
  const { sosOffset, ok } = walkJpegMarkers(bytes, view, (_marker, segStart, segEnd, label) => {
    if (!label) {
      chunks.push(bytes.subarray(segStart, segEnd));
      return;
    }
    const id = jpegSegmentId(segStart, label, counts, iccGroupSegStarts);
    if (!removeIds.has(id)) chunks.push(bytes.subarray(segStart, segEnd));
  });
  if (!ok) return buf; // 構造的に壊れているときは原本をそのまま返す（呼び出し側は scan.strippable === false で判定済み）
  chunks.push(bytes.subarray(sosOffset)); // SOS 以降（スキャンデータ + EOI）はそのまま連結
  return concatUint8Arrays(chunks);
}

// --- PNG ------------------------------------------------------------------

/** 除去対象の PNG 補助チャンク（デコードに不要なもののみ） */
const PNG_STRIP_CHUNK_TYPES = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "iCCP", "tIME"]);

/**
 * PNG チャンク列を IEND まで走査する。`ok: false` はチャンク長がバッファをはみ出す・
 * CRC の 4 byte が途中で切れている・IEND に辿り着けない（=末尾が壊れている）ことを表し、
 * 呼び出し側はこの走査結果を使わず原本を無加工で通す（`Math.min` でオフセットを丸めて
 * 誤った境界のまま処理を続けない）。
 */
function walkPngChunks(
  bytes: Uint8Array,
  view: DataView,
  onChunk: (type: string, start: number, end: number) => void,
): { ok: boolean } {
  let offset = 8; // PNG シグネチャ
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = asciiAt(bytes, offset + 4, 4);
    const end = offset + 8 + length + 4; // len(4) + type(4) + data(length) + CRC(4)
    if (end > bytes.length) return { ok: false };
    onChunk(type, offset, end);
    offset = end;
    if (type === "IEND") return { ok: true };
  }
  return { ok: false }; // ループを抜けた = IEND に辿り着く前にバッファが尽きた
}

function scanPngMetadata(buf: ArrayBuffer): MetadataScanResult {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const segments: MetadataSegment[] = [];
  const counts = new Map<string, number>();
  const { ok } = walkPngChunks(bytes, view, (type, start, end) => {
    if (PNG_STRIP_CHUNK_TYPES.has(type)) {
      segments.push({ id: nextId(counts, type), name: type, bytes: end - start, start, end, payloadStart: start + 8 });
    }
  });
  return {
    format: "png",
    segments: ok ? segments : [],
    totalBytes: ok ? segments.reduce((sum, s) => sum + s.bytes, 0) : 0,
    strippable: ok,
  };
}

function stripPngMetadata(buf: ArrayBuffer, removeIds: ReadonlySet<string>): ArrayBuffer {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)]; // シグネチャ
  const counts = new Map<string, number>();
  const { ok } = walkPngChunks(bytes, view, (type, start, end) => {
    if (!PNG_STRIP_CHUNK_TYPES.has(type)) {
      chunks.push(bytes.subarray(start, end));
      return;
    }
    const id = nextId(counts, type);
    if (!removeIds.has(id)) chunks.push(bytes.subarray(start, end));
  });
  if (!ok) return buf; // 構造的に壊れているときは原本をそのまま返す（呼び出し側は scan.strippable === false で判定済み）
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
  "XMP ": "XMP ", // fourCC は4byte固定のため実際には末尾に空白が入る（"XMP" ではマッチしない）
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
    if (name) segments.push({ id: nextId(counts, name), name, bytes: 8 + paddedSize, start: offset, end: chunkEnd, payloadStart: offset + 8 });
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
  "APP2": "APP2（不明。MPO の索引などを含むことがある）",
  "APP2 MPF": "APP2 MPF（マルチピクチャ索引）",
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
export function bestEffortDecode(bytes: Uint8Array): string {
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
  const data = bytes.subarray(segment.payloadStart, segment.end);
  const text = bestEffortDecode(data);
  return text ? truncatePreview(text) : null;
}

/** PNG tIME: year(2, BE) + month(1) + day(1) + hour(1) + minute(1) + second(1) の7byte固定長 */
function previewPngTime(bytes: Uint8Array, segment: MetadataSegment): string | null {
  const { dataStart, dataEnd } = pngChunkDataRange(segment);
  if (dataEnd - dataStart < 7) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const year = view.getUint16(dataStart, false);
  const [month, day, hour, minute] = [
    byteAt(bytes, dataStart + 2),
    byteAt(bytes, dataStart + 3),
    byteAt(bytes, dataStart + 4),
    byteAt(bytes, dataStart + 5),
  ];
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`;
}

/**
 * セグメントの中身のうち「解凍・重い解釈をせずに安価に読める」ものだけをプレビュー文字列にする。
 * 対象外（APP1 Exif / eXIf は別枠の Exif テーブルで、APP1 XMP / APP2 ICC_PROFILE / WebP の
 * EXIF・XMP・ICCP はメタデータカードのセクション本文で個別に詳細表示するためここでは扱わない）や
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
      case "tIME":
        return previewPngTime(bytes, segment);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
