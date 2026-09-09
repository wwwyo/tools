/**
 * 画像ファイルの検品に使う純粋関数群。
 *
 * ブラウザは拡張子と MIME をそのまま信じて画像を扱うため、拡張子を書き換えただけの
 * ファイルや壊れたヘッダーを見抜けない。ここでは先頭バイトを直接読み、拡張子とは
 * 独立に「実際が何のフォーマットか」を判定する。
 */

/** ファイル形式のスニッフ結果 */
export interface FormatSniffResult {
  format: string;
  mime: string;
}

/** 画像1枚分の検品メタデータ */
export interface ImageMeta {
  fileName: string;
  ext: string;
  sniffedFormat: string;
  extFormat: string;
  mismatch: boolean;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  megapixels: string;
  ratioInt: string;
  ratioDec: string;
  lastModified: string;
  hasAlpha: boolean | null;
  bitInfo: string;
  exifOrientation: string;
}

/** バイト数を人間可読な単位（B/KB/MB/GB）に整形する */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  const digits = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[i]}`;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** 幅と高さから既約比（例: "16:9"）を求める */
export function reduceRatio(width: number, height: number): string {
  const d = gcd(width, height);
  return `${Math.round(width / d)}:${Math.round(height / d)}`;
}

function formatDate(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "不明";
  }
}

/** ファイル名から拡張子（小文字、ドット無し）を取り出す */
export function extOf(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return m?.[1]?.toLowerCase() ?? "";
}

/** ファイル名から拡張子を除いたベース名を取り出す */
export function basenameNoExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name || "image";
}

function byteAt(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

function matchesMagic(bytes: Uint8Array, offset: number, magic: number[]): boolean {
  return magic.every((b, i) => byteAt(bytes, offset + i) === b);
}

function asciiAt(bytes: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(byteAt(bytes, offset + i));
  return s;
}

/**
 * 先頭バイト（マジックナンバー）から実際の画像形式を判定する。
 * 拡張子は信用せず、常にこの結果を「実形式」として扱う。
 */
export function sniffFormat(buf: ArrayBuffer): FormatSniffResult {
  try {
    const bytes = new Uint8Array(buf);
    if (matchesMagic(bytes, 0, [0xff, 0xd8, 0xff])) return { format: "JPEG", mime: "image/jpeg" };
    if (matchesMagic(bytes, 0, [0x89, 0x50, 0x4e, 0x47])) return { format: "PNG", mime: "image/png" };
    if (matchesMagic(bytes, 0, [0x47, 0x49, 0x46])) return { format: "GIF", mime: "image/gif" };
    if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") {
      return { format: "WebP", mime: "image/webp" };
    }
    if (asciiAt(bytes, 4, 4) === "ftyp") {
      const brand = asciiAt(bytes, 8, 4).toLowerCase();
      if (brand.includes("avif")) return { format: "AVIF", mime: "image/avif" };
      if (brand.includes("heic") || brand.includes("heix") || brand.includes("mif1")) {
        return { format: "HEIC", mime: "image/heic" };
      }
    }
    return { format: "不明", mime: "" };
  } catch {
    return { format: "不明", mime: "" };
  }
}

const PNG_COLOR_TYPE_NAMES: Record<number, string> = {
  0: "グレースケール",
  2: "RGB",
  3: "パレット",
  4: "グレースケール+α",
  6: "RGBA",
};

/** PNG の IHDR チャンクからビット深度・カラータイプを読む */
export function parsePngBitDepth(buf: ArrayBuffer): string | null {
  try {
    const view = new DataView(buf);
    // 8 byte signature の直後の IHDR チャンク: 4 len + 4 "IHDR" + 4 width + 4 height + 1 bitdepth + 1 colortype
    const offset = 8;
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    if (type !== "IHDR") return null;
    const bitDepth = view.getUint8(offset + 8 + 8);
    const colorType = view.getUint8(offset + 8 + 9);
    return `${bitDepth}bit (${PNG_COLOR_TYPE_NAMES[colorType] ?? "不明"})`;
  } catch {
    return null;
  }
}

/** JPEG の Exif セグメント（APP1）から Orientation タグ（0x0112）を読む */
export function parseJpegExifOrientation(buf: ArrayBuffer): number | null {
  try {
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    const length = view.byteLength;
    while (offset < length - 1) {
      const marker = view.getUint16(offset);
      if (marker === 0xffe1) {
        const segStart = offset + 4;
        // "Exif\0\0"
        if (view.getUint32(segStart) !== 0x45786966) return null;
        const tiffOffset = segStart + 6;
        const little = view.getUint16(tiffOffset) === 0x4949;
        const firstIfdOffset = view.getUint32(tiffOffset + 4, little);
        const ifdOffset = tiffOffset + firstIfdOffset;
        const entryCount = view.getUint16(ifdOffset, little);
        for (let i = 0; i < entryCount; i++) {
          const entryOffset = ifdOffset + 2 + i * 12;
          const tag = view.getUint16(entryOffset, little);
          if (tag === 0x0112) {
            return view.getUint16(entryOffset + 8, little);
          }
        }
        return null;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      if (marker === 0xffd8 || marker === 0xffd9) {
        offset += 2;
      } else {
        const segLen = view.getUint16(offset + 2);
        offset += 2 + segLen;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 画像を縮小してから走査し、アルファチャンネルに 255 未満の画素があるかを調べる。
 * 原寸で走査すると大きな画像で重いため、200px 程度まで縮めてから見る。
 */
export function detectTransparency(img: HTMLImageElement): Promise<boolean | null> {
  return new Promise((resolve) => {
    try {
      const maxSide = 200;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) {
        if ((data[i] ?? 255) < 255) {
          resolve(true);
          return;
        }
      }
      resolve(false);
    } catch {
      resolve(null);
    }
  });
}

/** URL（object URL など）から HTMLImageElement をデコードする */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
    img.src = url;
  });
}

const EXT_TO_FORMAT: Record<string, string> = {
  jpg: "JPEG",
  jpeg: "JPEG",
  png: "PNG",
  gif: "GIF",
  webp: "WebP",
  avif: "AVIF",
  heic: "HEIC",
  heif: "HEIC",
};

/**
 * ファイルと読み込み済み画像から検品テーブル一式を組み立てる。
 * 拡張子とマジックナンバーの不一致検知がこのツールの核なので、両者を独立に求めてから比較する。
 */
export async function extractMetadata(file: File, img: HTMLImageElement): Promise<ImageMeta> {
  // EXIF の APP1 セグメントは 16bit 長で最大 64KiB になりうるため、先頭 32 byte では
  // Orientation タグまで届かず常に「なし」になる。フォーマット判定・IHDR は 32 byte で足りるが、
  // 同じバッファを使い回すためここでまとめて 64KiB 読む
  const headerBuf = await file.slice(0, 65536).arrayBuffer();
  const sniff = sniffFormat(headerBuf);
  const ext = extOf(file.name);
  const extFormat = EXT_TO_FORMAT[ext] ?? (ext ? ext.toUpperCase() : "不明");
  const mismatch = sniff.format !== "不明" && extFormat !== "不明" && sniff.format !== extFormat;

  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const megapixels = ((width * height) / 1_000_000).toFixed(2);
  const ratioInt = reduceRatio(width, height);
  const ratioDec = (width / height).toFixed(2);

  let bitInfo = "不明";
  if (sniff.format === "PNG") {
    bitInfo = parsePngBitDepth(headerBuf) ?? "不明";
  } else if (sniff.format === "JPEG") {
    bitInfo = "8bit";
  }

  let exifOrientation = "なし";
  if (sniff.format === "JPEG") {
    const o = parseJpegExifOrientation(headerBuf);
    exifOrientation = o != null ? String(o) : "なし";
  }

  const hasAlpha = await detectTransparency(img);

  return {
    fileName: file.name,
    ext: ext || "(なし)",
    sniffedFormat: sniff.format,
    extFormat,
    mismatch,
    mime: file.type || "(不明)",
    bytes: file.size,
    width,
    height,
    megapixels,
    ratioInt,
    ratioDec,
    lastModified: formatDate(file.lastModified),
    hasAlpha,
    bitInfo,
    exifOrientation,
  };
}
