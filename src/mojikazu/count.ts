/**
 * テキストを grapheme cluster（人が「1文字」と知覚する単位）の配列に分割する。
 *
 * `.length` は UTF-16 コード単位数（サロゲートペアが2としてカウントされる）、
 * `Array.from(text)` はコードポイント単位（結合文字や ZWJ 絵文字が複数要素に割れる）
 * であり、どちらも人間の「1文字」とはずれる。`Intl.Segmenter` の grapheme
 * granularity は Unicode の extended grapheme cluster 境界規則（UAX #29）に従うため、
 * 結合文字・異体字セレクタ・ZWJ 連結絵文字・国旗（地域指示記号ペア）などをまとめて
 * 1 grapheme として扱える。
 */
function toGraphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (entry) => entry.segment);
  }
  // Intl.Segmenter 非対応環境向けの fallback。コードポイント単位の分割になるため、
  // 結合文字列や ZWJ 連結絵文字は複数 grapheme に分かれてしまい精度が落ちる。
  return Array.from(text);
}

/** grapheme が空白または改行かどうか（Unicode の空白判定を JS の \s に委ねる） */
function isWhitespaceGrapheme(grapheme: string): boolean {
  return /^\s$/u.test(grapheme);
}

/** grapheme が改行（LF / CR / CRLF）かどうか */
function isNewlineGrapheme(grapheme: string): boolean {
  return grapheme === "\n" || grapheme === "\r" || grapheme === "\r\n";
}

/** grapheme cluster 数（絵文字・結合文字・サロゲートペアを1文字として数える） */
export function countGraphemes(text: string): number {
  return toGraphemes(text).length;
}

/** 空白・改行を除いた grapheme cluster 数 */
export function countGraphemesExcludingWhitespace(text: string): number {
  return toGraphemes(text).filter(
    (g) => !isWhitespaceGrapheme(g) && !isNewlineGrapheme(g),
  ).length;
}

/** 改行のみを除いた grapheme cluster 数（空白は数える） */
export function countGraphemesExcludingNewline(text: string): number {
  return toGraphemes(text).filter((g) => !isNewlineGrapheme(g)).length;
}

/**
 * 行数を数える。末尾の改行は「行区切り」であって「次の空行の始まり」ではないため
 * 空行として数えない（エディタ的な慣習に合わせる）。空文字列は0行。
 *
 * 実装: 末尾が改行なら1つだけ取り除いてから "\n" で分割する。CRLF は先に LF へ
 * 正規化してから判定する（"\r\n" を1つの改行として扱うため）。
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  const normalized = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const withoutTrailingNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  if (withoutTrailingNewline === "") return 0;
  return withoutTrailingNewline.split("\n").length;
}

/** コードポイント数（サロゲートペアは1、結合文字・ZWJ絵文字は複数として数える） */
export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/** UTF-16 長（JS 文字列の `.length` と同じ。サロゲートペアは2として数える） */
export function countUtf16Length(text: string): number {
  return text.length;
}

/** UTF-8 バイト数 */
export function countUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * grapheme の先頭コードポイントが半角（1文字 = 0.5 換算）かどうかを判定する。
 *
 * 厳密な East Asian Width（UAX #11）の Wide/Fullwidth 判定には広いコードポイント
 * 範囲表が要る。ここでは「半角英数記号・半角カタカナ以外はすべて全角として扱う」
 * 簡易判定にしている（ASCII 範囲 U+0000–U+007E と半角カタカナ U+FF61–U+FF9F のみ
 * 0.5、それ以外は 1）。ギリシャ文字・キリル文字など East Asian Width 上は
 * Narrow/Ambiguous でも、この簡易判定では全角 1 扱いになる。
 */
function isHalfWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x7e) ||
    (codePoint >= 0xff61 && codePoint <= 0xff9f)
  );
}

/** 全角換算文字数（半角=0.5、全角=1として合算。判定基準は isHalfWidthCodePoint 参照） */
export function countFullwidthEquivalent(text: string): number {
  return toGraphemes(text).reduce((sum, grapheme) => {
    const codePoint = grapheme.codePointAt(0) ?? 0;
    return sum + (isHalfWidthCodePoint(codePoint) ? 0.5 : 1);
  }, 0);
}

/** テキストの全集計値 */
export type TextCounts = {
  graphemes: number;
  graphemesExcludingWhitespace: number;
  graphemesExcludingNewline: number;
  lines: number;
  codePoints: number;
  utf16Length: number;
  utf8Bytes: number;
  fullwidthEquivalent: number;
};

/** テキストの全集計値をまとめて計算する */
export function countAll(text: string): TextCounts {
  return {
    graphemes: countGraphemes(text),
    graphemesExcludingWhitespace: countGraphemesExcludingWhitespace(text),
    graphemesExcludingNewline: countGraphemesExcludingNewline(text),
    lines: countLines(text),
    codePoints: countCodePoints(text),
    utf16Length: countUtf16Length(text),
    utf8Bytes: countUtf8Bytes(text),
    fullwidthEquivalent: countFullwidthEquivalent(text),
  };
}
