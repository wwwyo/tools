/**
 * UltraHDR (gain map 付き JPEG) コンテナの組み立て。
 *
 * ブラウザ API に依存しないバイト列操作だけで完結させてあり、bun でも単体テストできる。
 * 入力はベース JPEG / ゲインマップ JPEG の生バイト列とメタデータ、出力は
 * それらを合成した 1 本の UltraHDR JPEG のバイト列。
 */

const MARKER_APP0 = 0xe0;
const MARKER_APP1 = 0xe1;
const MARKER_APP2 = 0xe2;

/** APP1 XMP セグメントの識別子（Adobe XMP の慣例） */
const XMP_APP1_ID = "http://ns.adobe.com/xap/1.0/\0";
/** APP2 MPF セグメントの識別子（CIPA DC-007 Multi-Picture Format） */
const MPF_APP2_ID = "MPF\0";

export type UltraHdrParams = {
  /** log2(最大ゲイン)。ヘッドルームの stop 数と同じ値（例: 2 stop なら 2） */
  readonly maxGainLog2: number;
};

/** JPEG バイト列が SOI (FFD8) で始まっているかを検証する */
function assertJpegSoi(jpeg: Uint8Array): void {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("input is not a JPEG (missing SOI marker)");
  }
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  const high = bytes[offset];
  const low = bytes[offset + 1];
  if (high === undefined || low === undefined) {
    throw new Error(`unexpected end of buffer while reading uint16 at ${offset}`);
  }
  return (high << 8) | low;
}

function writeUint16BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}

function writeUint32BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >> 24) & 0xff;
  out[offset + 1] = (value >> 16) & 0xff;
  out[offset + 2] = (value >> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

/**
 * 新規セグメントを挿入すべきオフセットを返す。SOI の直後、ただし JFIF (APP0) が
 * あればその後ろにする（APP0 が先頭に無いと弾くデコーダがあるため）。
 */
function findInsertionOffset(jpeg: Uint8Array): number {
  assertJpegSoi(jpeg);
  let offset = 2;
  if (jpeg[offset] === 0xff && jpeg[offset + 1] === MARKER_APP0) {
    const length = readUint16BE(jpeg, offset + 2);
    offset += 2 + length;
  }
  return offset;
}

/** 指定オフセットにセグメント列を挿入した新しいバイト列を返す */
function insertSegments(jpeg: Uint8Array, offset: number, segments: readonly Uint8Array[]): Uint8Array {
  return concatBytes([jpeg.subarray(0, offset), ...segments, jpeg.subarray(offset)]);
}

/** APP1 XMP セグメント（マーカー + 長さ + 識別子 + パケット本体）を組み立てる */
function buildApp1XmpSegment(xmpPacket: string): Uint8Array {
  const idBytes = new TextEncoder().encode(XMP_APP1_ID);
  const packetBytes = new TextEncoder().encode(xmpPacket);
  const length = 2 + idBytes.length + packetBytes.length;
  if (length > 0xffff) {
    throw new Error(`XMP segment too large: ${length} bytes`);
  }
  const segment = new Uint8Array(2 + length);
  segment[0] = 0xff;
  segment[1] = MARKER_APP1;
  writeUint16BE(segment, 2, length);
  segment.set(idBytes, 4);
  segment.set(packetBytes, 4 + idBytes.length);
  return segment;
}

/** プライマリ JPEG に載せる XMP パケット（Container:Directory で gain map の在処を宣言する） */
function buildPrimaryXmpPacket(gainMapByteLength: number): string {
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"',
    '    hdrgm:Version="1.0"/>',
    '  <rdf:Description rdf:about=""',
    '    xmlns:Container="http://ns.google.com/photos/1.0/container/"',
    '    xmlns:Item="http://ns.google.com/photos/1.0/container/item/">',
    "   <Container:Directory>",
    "    <rdf:Seq>",
    '     <rdf:li rdf:parseType="Resource">',
    '      <Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/>',
    "     </rdf:li>",
    '     <rdf:li rdf:parseType="Resource">',
    `      <Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMapByteLength}"/>`,
    "     </rdf:li>",
    "    </rdf:Seq>",
    "   </Container:Directory>",
    "  </rdf:Description>",
    " </rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("\n");
}

/** ゲインマップ JPEG に載せる XMP パケット（hdrgm の合成パラメータ本体） */
function buildGainMapXmpPacket(maxGainLog2: number): string {
  const max = maxGainLog2.toFixed(6);
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"',
    '    hdrgm:Version="1.0"',
    '    hdrgm:GainMapMin="0.0"',
    `    hdrgm:GainMapMax="${max}"`,
    '    hdrgm:Gamma="1.0"',
    '    hdrgm:OffsetSDR="0.015625"',
    '    hdrgm:OffsetHDR="0.015625"',
    '    hdrgm:HDRCapacityMin="0.0"',
    `    hdrgm:HDRCapacityMax="${max}"`,
    '    hdrgm:BaseRenditionIsHDR="False"/>',
    " </rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("\n");
}

/**
 * MPF (Multi-Picture Format) の Individual Image Attribute 定数。
 * 値そのものは実写の UltraHDR サンプル（MDN ultra-hdr.jpg）の MPF セグメントから採取した。
 * ブラウザの gain map デコーダは XMP の Container:Directory を主に見るため MPF は
 * 互換性のための副次情報だが、構造はカメラ機器の慣例に合わせておく。
 */
const MPF_ATTR_PRIMARY = 0x00030000;
const MPF_ATTR_DEPENDENT = 0x00000000;

const MPF_TAG_VERSION = 0xb000;
const MPF_TAG_NUMBER_OF_IMAGES = 0xb001;
const MPF_TAG_MP_ENTRY = 0xb002;

/** APP2 MPF セグメントのうち、値に依存せず常に固定になる部分のバイト長 */
const MPF_TIFF_HEADER_SIZE = 8;
const MPF_IFD_ENTRY_COUNT = 3;
const MPF_IFD_SIZE = 2 + MPF_IFD_ENTRY_COUNT * 12 + 4;
const MPF_MP_ENTRY_SIZE = 16;
const MPF_MP_ENTRIES_SIZE = MPF_MP_ENTRY_SIZE * 2;

/**
 * APP2 MPF セグメントを組み立てる。
 *
 * オフセットの基点は TIFF ヘッダ先頭（"MPF\0" の直後、エンディアンマーカー "MM" の位置）。
 * 1 枚目 (primary) はこのセグメントを含む画像自身なのでデータオフセットは 0 固定、
 * 2 枚目 (gain map) は呼び出し側があらかじめ計算したオフセットをそのまま書き込む。
 * サイズ・オフセットの数値だけを差し替えれば済むよう、内容の並びは固定サイズにしてある。
 */
function buildApp2MpfSegment(params: {
  readonly primarySize: number;
  readonly gainMapSize: number;
  readonly gainMapDataOffset: number;
}): Uint8Array {
  const idBytes = new TextEncoder().encode(MPF_APP2_ID);
  const contentSize = idBytes.length + MPF_TIFF_HEADER_SIZE + MPF_IFD_SIZE + MPF_MP_ENTRIES_SIZE;
  const length = 2 + contentSize; // 長さフィールド自身(2byte)を含む、マーカー(2byte)は含まない
  if (length > 0xffff) {
    throw new Error(`MPF segment too large: ${length} bytes`);
  }

  const segment = new Uint8Array(2 + length);
  segment[0] = 0xff;
  segment[1] = MARKER_APP2;
  writeUint16BE(segment, 2, length);
  segment.set(idBytes, 4);

  const tiffStart = 4 + idBytes.length;
  // TIFF ヘッダ: ビッグエンディアン "MM" + マジックナンバー 0x002A + IFD オフセット。
  // 実サンプルがビッグエンディアンだったのでそれに合わせる（当初案のリトルエンディアンから変更）
  segment[tiffStart] = 0x4d;
  segment[tiffStart + 1] = 0x4d;
  writeUint16BE(segment, tiffStart + 2, 0x002a);
  const ifdOffset = MPF_TIFF_HEADER_SIZE;
  writeUint32BE(segment, tiffStart + 4, ifdOffset);

  const ifdStart = tiffStart + ifdOffset;
  writeUint16BE(segment, ifdStart, MPF_IFD_ENTRY_COUNT);

  let entryStart = ifdStart + 2;
  writeUint16BE(segment, entryStart, MPF_TAG_VERSION);
  writeUint16BE(segment, entryStart + 2, 7); // type: UNDEFINED
  writeUint32BE(segment, entryStart + 4, 4); // count: 4 bytes
  segment.set(new TextEncoder().encode("0100"), entryStart + 8); // MPFVersion "0100" (inline, ちょうど4byte)
  entryStart += 12;

  writeUint16BE(segment, entryStart, MPF_TAG_NUMBER_OF_IMAGES);
  writeUint16BE(segment, entryStart + 2, 4); // type: LONG
  writeUint32BE(segment, entryStart + 4, 1); // count: 1
  writeUint32BE(segment, entryStart + 8, 2); // NumberOfImages = 2
  entryStart += 12;

  // TIFF ヘッダ基点でのオフセット。IFD 自体が ifdOffset から始まるため、その直後に置くには
  // ifdOffset を足す必要がある（MPF_IFD_SIZE だけだと IFD の途中に重なってしまう）
  const mpEntriesOffset = ifdOffset + MPF_IFD_SIZE;
  writeUint16BE(segment, entryStart, MPF_TAG_MP_ENTRY);
  writeUint16BE(segment, entryStart + 2, 7); // type: UNDEFINED
  writeUint32BE(segment, entryStart + 4, MPF_MP_ENTRIES_SIZE); // count: 32 bytes (16 * 2 entries)
  writeUint32BE(segment, entryStart + 8, mpEntriesOffset); // 4byte超なのでオフセット格納
  entryStart += 12;

  writeUint32BE(segment, entryStart, 0); // next IFD offset なし
  entryStart += 4;

  const mpEntriesStart = tiffStart + mpEntriesOffset;
  // entry0: primary image
  writeUint32BE(segment, mpEntriesStart, MPF_ATTR_PRIMARY);
  writeUint32BE(segment, mpEntriesStart + 4, params.primarySize);
  writeUint32BE(segment, mpEntriesStart + 8, 0); // primary 自身が格納先なのでオフセットは常に 0
  writeUint16BE(segment, mpEntriesStart + 12, 0);
  writeUint16BE(segment, mpEntriesStart + 14, 0);

  // entry1: gain map image
  const secondEntryStart = mpEntriesStart + MPF_MP_ENTRY_SIZE;
  writeUint32BE(segment, secondEntryStart, MPF_ATTR_DEPENDENT);
  writeUint32BE(segment, secondEntryStart + 4, params.gainMapSize);
  writeUint32BE(segment, secondEntryStart + 8, params.gainMapDataOffset);
  writeUint16BE(segment, secondEntryStart + 12, 0);
  writeUint16BE(segment, secondEntryStart + 14, 0);

  return segment;
}

/**
 * ベース JPEG とゲインマップ JPEG から UltraHDR JPEG を組み立てる。
 *
 * 手順は必ずゲインマップ側を先に確定させる: プライマリ側の XMP Item:Length と
 * MPF の size/offset は「XMP 挿入済みゲインマップの最終バイト長」を指すため、
 * 順序を入れ替えるとこれらの値がずれる。
 */
export function assembleUltraHdrJpeg(baseJpeg: Uint8Array, gainMapJpeg: Uint8Array, params: UltraHdrParams): Uint8Array {
  assertJpegSoi(baseJpeg);
  assertJpegSoi(gainMapJpeg);

  const gainMapXmpSegment = buildApp1XmpSegment(buildGainMapXmpPacket(params.maxGainLog2));
  const gainMapInsertOffset = findInsertionOffset(gainMapJpeg);
  const gainMapWithXmp = insertSegments(gainMapJpeg, gainMapInsertOffset, [gainMapXmpSegment]);

  const primaryXmpSegment = buildApp1XmpSegment(buildPrimaryXmpPacket(gainMapWithXmp.length));
  const primaryInsertOffset = findInsertionOffset(baseJpeg);

  // MPF セグメントは内容のバイト長が値に依存せず固定なので、値が決まる前に長さだけ先に確定できる
  const mpfSegmentLength = buildApp2MpfSegment({ primarySize: 0, gainMapSize: 0, gainMapDataOffset: 0 }).length;
  const tiffStart = primaryInsertOffset + primaryXmpSegment.length + 4 + 4; // マーカー+長さ(4) + "MPF\0"(4)
  const primaryTotalLength = baseJpeg.length + primaryXmpSegment.length + mpfSegmentLength;
  const gainMapDataOffset = primaryTotalLength - tiffStart;

  const mpfSegment = buildApp2MpfSegment({
    primarySize: primaryTotalLength,
    gainMapSize: gainMapWithXmp.length,
    gainMapDataOffset,
  });

  const primaryWithMeta = insertSegments(baseJpeg, primaryInsertOffset, [primaryXmpSegment, mpfSegment]);

  return concatBytes([primaryWithMeta, gainMapWithXmp]);
}
