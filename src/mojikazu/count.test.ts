import { describe, expect, test } from "bun:test";
import {
  countCodePoints,
  countFullwidthEquivalent,
  countGraphemes,
  countGraphemesExcludingNewline,
  countGraphemesExcludingWhitespace,
  countLines,
  countUtf16Length,
  countUtf8Bytes,
} from "./count";

describe("countGraphemes", () => {
  test("空文字列は0", () => {
    expect(countGraphemes("")).toBe(0);
  });

  test("基本的なASCII", () => {
    expect(countGraphemes("abc")).toBe(3);
  });

  test("基本的な日本語", () => {
    expect(countGraphemes("こんにちは")).toBe(5);
  });

  test("ZWJ連結絵文字（家族の絵文字）は1文字", () => {
    // 👨‍👩‍👧‍👦 = man + ZWJ + woman + ZWJ + girl + ZWJ + boy
    const family = "👨‍👩‍👧‍👦";
    expect(countGraphemes(family)).toBe(1);
  });

  test("国旗の絵文字（地域指示記号ペア）は1文字", () => {
    // 🇯🇵 = Regional Indicator Symbol Letter J + Regional Indicator Symbol Letter P
    const flag = "🇯🇵";
    expect(countGraphemes(flag)).toBe(1);
  });

  test("肌色修飾子付き絵文字は1文字", () => {
    // 👍🏽 = THUMBS UP SIGN + EMOJI MODIFIER FITZPATRICK TYPE-4
    const thumbsUp = "👍🏽";
    expect(countGraphemes(thumbsUp)).toBe(1);
  });

  test("異体字セレクタ付き絵文字は1文字", () => {
    // ❤️ = HEAVY BLACK HEART + VARIATION SELECTOR-16
    const heart = "❤️";
    expect(countGraphemes(heart)).toBe(1);
  });

  test("結合文字（か + 濁点結合文字 = か゚）は1文字", () => {
    // "か" + U+309A COMBINING KATAKANA-HIRAGANA SEMI-VOICED SOUND MARK
    const kaHandakuten = "か゚";
    expect(countGraphemes(kaHandakuten)).toBe(1);
  });

  test("結合文字（eの分解形 e + 結合アクセント = é）は1文字", () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT
    const eAcute = "é";
    expect(countGraphemes(eAcute)).toBe(1);
  });

  test("サロゲートペア（𠮷 JIS漢字）は1文字", () => {
    // 𠮷 = U+20BB7、.length では2、Array.from では1になる
    const kichi = "𠮷";
    expect(kichi.length).toBe(2);
    expect(Array.from(kichi).length).toBe(1);
    expect(countGraphemes(kichi)).toBe(1);
  });

  test("字体セレクタ（IVS）付き漢字は1文字", () => {
    // "葛" + U+E0100 VARIATION SELECTOR-17（IVS）
    const kuzuIvs = "葛\u{E0100}";
    expect(countGraphemes(kuzuIvs)).toBe(1);
  });

  test("複数のgrapheme混在", () => {
    expect(countGraphemes("a👨‍👩‍👧‍👦b🇯🇵c")).toBe(5);
  });
});

describe("countGraphemesExcludingWhitespace", () => {
  test("空白・改行を除く", () => {
    expect(countGraphemesExcludingWhitespace("a b\nc\td")).toBe(4);
  });

  test("全角スペースも除く", () => {
    expect(countGraphemesExcludingWhitespace("あ　い")).toBe(2);
  });

  test("空白のみの文字列は0", () => {
    expect(countGraphemesExcludingWhitespace(" \n\t  ")).toBe(0);
  });
});

describe("countGraphemesExcludingNewline", () => {
  test("改行のみを除き空白は数える", () => {
    expect(countGraphemesExcludingNewline("a b\nc\td")).toBe(6);
  });

  test("改行が無ければ元の文字数と同じ", () => {
    expect(countGraphemesExcludingNewline("abc")).toBe(3);
  });

  test("CRLFも1文字分の改行として除かれる", () => {
    expect(countGraphemesExcludingNewline("a\r\nb")).toBe(2);
  });
});

describe("countLines", () => {
  test("空文字列は0行", () => {
    expect(countLines("")).toBe(0);
  });

  test("改行なしの1行は1行", () => {
    expect(countLines("abc")).toBe(1);
  });

  test("末尾の改行は空行として数えない", () => {
    expect(countLines("abc\n")).toBe(1);
  });

  test("2行", () => {
    expect(countLines("abc\ndef")).toBe(2);
  });

  test("中間の空行は数える", () => {
    expect(countLines("abc\n\ndef")).toBe(3);
  });

  test("末尾の空行は1つだけ無視される", () => {
    expect(countLines("abc\n\n")).toBe(2);
  });

  test("改行のみの文字列は末尾改行として無視され0行", () => {
    expect(countLines("\n")).toBe(0);
  });

  test("改行2つは2行（1つは行区切り、末尾の1つは無視）", () => {
    expect(countLines("\n\n")).toBe(2);
  });

  test("CRLFも改行として扱う", () => {
    expect(countLines("abc\r\ndef")).toBe(2);
  });
});

describe("reference counts", () => {
  test("countCodePoints はサロゲートペアを1として数える", () => {
    expect(countCodePoints("𠮷")).toBe(1);
  });

  test("countUtf16Length はサロゲートペアを2として数える", () => {
    expect(countUtf16Length("𠮷")).toBe(2);
  });

  test("countUtf8Bytes はASCIIで1バイト、日本語で3バイト", () => {
    expect(countUtf8Bytes("a")).toBe(1);
    expect(countUtf8Bytes("あ")).toBe(3);
  });

  test("countFullwidthEquivalent は半角ASCIIを0.5、日本語を1として合算する", () => {
    expect(countFullwidthEquivalent("ab")).toBe(1);
    expect(countFullwidthEquivalent("あい")).toBe(2);
    expect(countFullwidthEquivalent("aあ")).toBe(1.5);
  });

  test("countFullwidthEquivalent は半角カタカナを0.5として数える", () => {
    expect(countFullwidthEquivalent("ｱｲｳ")).toBe(1.5);
  });
});

describe("Intl.Segmenter非対応環境でのfallback", () => {
  test("Intl.Segmenterが無い場合はArray.fromによるコードポイント単位分割になる", () => {
    const originalSegmenter = Intl.Segmenter;
    // Intl.Segmenter は読み取り専用プロパティのため、直接代入ではなく
    // defineProperty で一時的に取り除く
    Object.defineProperty(Intl, "Segmenter", {
      value: undefined,
      configurable: true,
    });
    try {
      // フォールバック時はコードポイント単位になるため、ZWJ連結絵文字は
      // 複数grapheme（構成コードポイント数）に分かれてカウントされる
      const family = "👨‍👩‍👧‍👦";
      expect(countGraphemes(family)).toBe(Array.from(family).length);
      expect(countGraphemes(family)).toBeGreaterThan(1);

      // サロゲートペアの結合はコードポイント単位分割でも機能する
      expect(countGraphemes("𠮷")).toBe(1);
    } finally {
      Object.defineProperty(Intl, "Segmenter", {
        value: originalSegmenter,
        configurable: true,
      });
    }
  });
});
