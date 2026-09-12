/**
 * XMP パケット（Adobe XMP, RDF/XML）から代表的なプロパティだけを拾う軽量パーサー。
 *
 * XMP は任意のスキーマ・任意の入れ子を持てる汎用 RDF だが、このツールでは
 * 「よく使われる撮影・編集情報を一覧で見せる」ことが目的で、汎用 RDF パーサーは要らない。
 * DOMParser（main thread では使える）を使わず正規表現で拾うのは、この用途に対して
 * 過剰な依存にしないため。属性形式（`xmp:CreatorTool="..."`）・要素形式
 * （`<xmp:CreatorTool>...</xmp:CreatorTool>`）の両方に対応する。
 */

export interface XmpInfo {
  creatorTool: string | null;
  createDate: string | null;
  modifyDate: string | null;
  creators: string[];
  description: string | null;
  subjects: string[];
  photoshopDateCreated: string | null;
  /** exif:* 名前空間のプロパティ数（個々の値は多岐にわたるため件数だけ見せる） */
  exifCount: number;
  /** tiff:* 名前空間のプロパティ数 */
  tiffCount: number;
  /** 上記の既知プロパティが1つも見つからなかったときの「プロパティ N 件」用カウント（全タグ数の概算） */
  unknownPropertyCount: number;
  /** 生 XML の先頭 2000 文字（未知プロパティ用のフォールバック表示） */
  rawXmlPreview: string;
}

const RAW_PREVIEW_MAX_CHARS = 2000;

/** 属性形式 `prop="value"` を探す */
function readAttribute(xml: string, prop: string): string | null {
  const re = new RegExp(`${prop}\\s*=\\s*"([^"]*)"`);
  return re.exec(xml)?.[1]?.trim() ?? null;
}

/** 要素形式 `<prop>value</prop>` を探す（rdf:parseType="Resource" の入れ子は考慮しない簡易版） */
function readElement(xml: string, prop: string): string | null {
  const re = new RegExp(`<${prop}[^>]*>([^<]*)</${prop}>`);
  return re.exec(xml)?.[1]?.trim() ?? null;
}

/** 属性・要素どちらの形式で書かれていても値を読む。空文字は「無い」扱いにする */
function readProperty(xml: string, prop: string): string | null {
  const value = readAttribute(xml, prop) ?? readElement(xml, prop);
  return value ? value : null;
}

/** `<dc:creator><rdf:Seq><rdf:li>...</rdf:li>...</rdf:Seq></dc:creator>` のような rdf:li 列挙を読む */
function readLiList(xml: string, prop: string): string[] {
  const containerRe = new RegExp(`<${prop}[^>]*>([\\s\\S]*?)</${prop}>`);
  const container = containerRe.exec(xml)?.[1];
  if (!container) return [];
  const items: string[] = [];
  const liRe = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g;
  let match: RegExpExecArray | null = liRe.exec(container);
  while (match) {
    const text = match[1]?.trim();
    if (text) items.push(text);
    match = liRe.exec(container);
  }
  return items;
}

/** `dc:description` は rdf:Alt（言語別 rdf:li）で包まれるのが通例なので、最初の rdf:li だけ読む */
function readFirstLi(xml: string, prop: string): string | null {
  const list = readLiList(xml, prop);
  return list[0] ?? null;
}

/** `${ns}:XxxYyy` 形式のプロパティ名（属性・要素どちらも）の異なり数を数える */
function countNamespaceProperties(xml: string, ns: string): number {
  const seen = new Set<string>();
  const attrRe = new RegExp(`\\b${ns}:([A-Za-z][A-Za-z0-9]*)\\s*=`, "g");
  const elemRe = new RegExp(`<${ns}:([A-Za-z][A-Za-z0-9]*)[ >]`, "g");
  for (const re of [attrRe, elemRe]) {
    let match: RegExpExecArray | null = re.exec(xml);
    while (match) {
      const name = match[1];
      if (name) seen.add(name);
      match = re.exec(xml);
    }
  }
  return seen.size;
}

/** XMP パケット（`<x:xmpmeta>...` を含む XML 文字列全体）から代表プロパティを読む */
export function parseXmpPacket(xml: string): XmpInfo {
  const creatorTool = readProperty(xml, "xmp:CreatorTool");
  const createDate = readProperty(xml, "xmp:CreateDate");
  const modifyDate = readProperty(xml, "xmp:ModifyDate");
  const creators = readLiList(xml, "dc:creator");
  const description = readFirstLi(xml, "dc:description");
  const subjects = readLiList(xml, "dc:subject");
  const photoshopDateCreated = readProperty(xml, "photoshop:DateCreated");
  const exifCount = countNamespaceProperties(xml, "exif");
  const tiffCount = countNamespaceProperties(xml, "tiff");

  const knownFound =
    creatorTool != null ||
    createDate != null ||
    modifyDate != null ||
    creators.length > 0 ||
    description != null ||
    subjects.length > 0 ||
    photoshopDateCreated != null ||
    exifCount > 0 ||
    tiffCount > 0;
  // 既知プロパティが1つも見つからなかったときのフォールバック件数。dc/xmp/photoshop 以外の
  // 名前空間もまとめて「プロパティ N 件」として概算するため、属性形式・要素形式の両方を数える
  const unknownPropertyCount = knownFound ? 0 : countAllProperties(xml);

  return {
    creatorTool,
    createDate,
    modifyDate,
    creators,
    description,
    subjects,
    photoshopDateCreated,
    exifCount,
    tiffCount,
    unknownPropertyCount,
    rawXmlPreview: xml.slice(0, RAW_PREVIEW_MAX_CHARS),
  };
}

/** `ns:Name` 形式の全プロパティ（名前空間を問わない）の異なり数を数える。unknownPropertyCount 専用 */
function countAllProperties(xml: string): number {
  const seen = new Set<string>();
  const attrRe = /\b([A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]*)\s*=/g;
  const elemRe = /<([A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]*)[ >]/g;
  for (const re of [attrRe, elemRe]) {
    let match: RegExpExecArray | null = re.exec(xml);
    while (match) {
      const name = match[1];
      if (name && name !== "rdf:li" && name !== "rdf:Seq" && name !== "rdf:Alt" && name !== "rdf:Bag") seen.add(name);
      match = re.exec(xml);
    }
  }
  return seen.size;
}
