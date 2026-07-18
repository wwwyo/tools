// ------------------------------------------------------------------
// 検知辞書
// カテゴリごとに { pattern, label, weight } のエントリを持つ。
// pattern は string（部分一致・literalに正規表現エスケープして使用）
// または RegExp（okurigana/助詞ゆれを吸収するため）。
// weight は「1回マッチしたときの減点相当ポイント」。
// ------------------------------------------------------------------

export type Category = "teikeiku" | "kyocho" | "kango" | "enkyoku" | "setsuzoku";

export interface DictionaryEntry {
  category: Category;
  categoryLabel: string;
  pattern: string | RegExp;
  weight: number;
  label?: string;
}

export interface Match {
  start: number;
  end: number;
  category: Category;
  categoryLabel: string;
  label: string;
  weight: number;
}

export interface CategoryGroup {
  label: string;
  items: Map<string, number>;
}

export interface Result {
  charLength: number;
  matchCount: number;
  isShort: boolean;
  score: number | null;
  rank: string | null;
  comment: string | null;
  nonOverlapping: Match[];
  byCategory: Record<Category, CategoryGroup>;
}

export const DICTIONARY: DictionaryEntry[] = [
  // 1. 常套句・定型句（重め: 8-12）
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "いかがでしたか", weight: 10 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /と言えるでしょう/g, weight: 9 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /ではないでしょうか/g, weight: 9 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "結論として", weight: 8 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "本記事では", weight: 9 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "まとめると", weight: 8 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /見ていきましょう/g, weight: 10 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /解説していきます/g, weight: 10 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "注目すべきは", weight: 9 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /押さえておきましょう/g, weight: 9 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "について詳しく", weight: 8 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "この記事では", weight: 9 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /最後までお読みいただき/g, weight: 11 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /ぜひ参考にしてみてください/g, weight: 10 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "今回は", weight: 8 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /徹底解説/g, weight: 9 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /詳しく見ていきます/g, weight: 9 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "総括すると", weight: 8 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: /以上を踏まえ/g, weight: 8 },
  { category: "teikeiku", categoryLabel: "常套句・定型句", pattern: "総じて", weight: 8 },

  // 2. 過剰な強調・形容（中: 4-6）
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "非常に", weight: 5 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "極めて", weight: 5 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "圧倒的", weight: 6 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "劇的に", weight: 6 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "飛躍的に", weight: 6 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "魅力的", weight: 5 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "画期的", weight: 6 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "革新的", weight: 5 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: /驚くべき/g, weight: 6 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "絶大な", weight: 5 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "非常に重要", weight: 6 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "とても重要", weight: 4 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "圧巻の", weight: 5 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "唯一無二", weight: 5 },
  { category: "kyocho", categoryLabel: "過剰な強調・形容", pattern: "計り知れない", weight: 5 },

  // 3. LLM 頻出漢語・抽象語（中〜重: 5-8）
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "活用", weight: 5 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "包括的", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "効率的", weight: 5 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "最適化", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "洞察", weight: 7 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "深掘り", weight: 7 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "網羅的", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "多岐にわたる", weight: 7 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: /重要な役割を果た/g, weight: 8 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "鍵となる", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "不可欠", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: /注目を集め/g, weight: 7 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "を実現", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "を提供", weight: 5 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "シームレス", weight: 7 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "エコシステム", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "ベストプラクティス", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "持続可能", weight: 5 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "多様性に富んだ", weight: 7 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "利便性の向上", weight: 6 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "可能性を秘めて", weight: 7 },
  { category: "kango", categoryLabel: "LLM 頻出漢語・抽象語", pattern: "多角的", weight: 6 },

  // 4. 冗長・婉曲構文（中: 3-5）
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /することができます/g, weight: 4 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /と考えられます/g, weight: 4 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /と言われています/g, weight: 4 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /となっています/g, weight: 3 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /していきます/g, weight: 4 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /することが重要です/g, weight: 5 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /することが求められます/g, weight: 5 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /と思われます/g, weight: 3 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /と言えます/g, weight: 4 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /していただければと思います/g, weight: 5 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /する必要があります/g, weight: 3 },
  { category: "enkyoku", categoryLabel: "冗長・婉曲構文", pattern: /と捉えることができます/g, weight: 5 },

  // 5. 接続詞の多用（軽め: 1-2、頻度で積み上がる）
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)さらに、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)また、/g, weight: 1 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)一方で、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)加えて、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)そして、/g, weight: 1 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)したがって、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)このように、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)つまり、/g, weight: 1 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)なお、/g, weight: 1 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)ただし、/g, weight: 1 },
  { category: "setsuzoku", categoryLabel: "接続詞の多用", pattern: /(^|\n)それゆえ、/g, weight: 2 },
];

export const CATEGORY_ORDER: Category[] = ["teikeiku", "kyocho", "kango", "enkyoku", "setsuzoku"];

export const SAMPLE_TEXT =
  "本記事では、最新のAI活用について詳しく解説していきます。近年、業務効率化のためにAIを活用する企業が非常に増えており、その重要な役割を果たす存在として注目を集めています。" +
  "さらに、包括的なデータ分析を行うことで、洞察を深掘りすることができます。一方で、導入には課題も存在すると考えられます。" +
  "また、シームレスな連携を実現するエコシステムの構築が鍵となると言えるでしょう。まとめると、AIの活用は今後さらに不可欠なものとなっていくのではないでしょうか。いかがでしたか。ぜひ参考にしてみてください。";

// 与えられたテキストに対して辞書全エントリをマッチさせ、
// 全マッチ区間（開始・終了位置、カテゴリ、ラベル、weight）のフラットな配列を返す。
export function findMatches(text: string): { all: Match[]; nonOverlapping: Match[] } {
  const matches: Match[] = [];
  for (const entry of DICTIONARY) {
    let regex: RegExp;
    if (entry.pattern instanceof RegExp) {
      // lastIndex を毎回リセットするため複製
      regex = new RegExp(
        entry.pattern.source,
        entry.pattern.flags.includes("g") ? entry.pattern.flags : entry.pattern.flags + "g",
      );
    } else {
      const escaped = entry.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(escaped, "g");
    }
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      // 接続詞パターンは (^|\n) を含むため、実際の語句部分だけをハイライトしたい。
      // マッチ文字列内で読点付きの語句を探すか、そのまま使う。
      let start = m.index;
      let matchedStr = m[0];
      // グループ1が改行や行頭の空文字の場合、その分だけstartをずらす
      if (m[1] !== undefined) {
        start += m[1].length;
        matchedStr = matchedStr.slice(m[1].length);
      }
      if (matchedStr.length === 0) {
        // 無限ループ防止
        regex.lastIndex++;
        continue;
      }
      matches.push({
        start: start,
        end: start + matchedStr.length,
        category: entry.category,
        categoryLabel: entry.categoryLabel,
        label: entry.label || matchedStr,
        weight: entry.weight,
      });
      if (regex.lastIndex === m.index) {
        regex.lastIndex++;
      }
    }
  }
  // 開始位置でソート。重複区間はそのまま許容せず、先勝ちで除外して
  // ハイライトのネストや破損を防ぐ。
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlapping: Match[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      nonOverlapping.push(m);
      lastEnd = m.end;
    }
  }
  return { all: matches, nonOverlapping: nonOverlapping };
}

// スコア計算
// 1. 全マッチ（重複除去前、= 出現回数ベース）の weight を合算して rawWeightSum を得る。
// 2. 400文字ブロックに正規化: normalizedDeduction = rawWeightSum * (400 / charLength)
// 3. score = clamp(100 - round(normalizedDeduction), 0, 100)
export function computeScore(rawWeightSum: number, charLength: number): number {
  const normalizedDeduction = rawWeightSum * (400 / charLength);
  const score = Math.max(0, Math.min(100, 100 - Math.round(normalizedDeduction)));
  return score;
}

export function rankFromScore(score: number): { rank: string; comment: string } {
  if (score >= 90) return { rank: "S", comment: "人間の文章です" };
  if (score >= 75) return { rank: "A", comment: "自然な文章、たまに顔を出すAI感" };
  if (score >= 55) return { rank: "B", comment: "AIっぽさがそこそこ香ります" };
  if (score >= 35) return { rank: "C", comment: "だいぶAI、推敲の余地あり" };
  return { rank: "D", comment: "ほぼAIの香り" };
}

export function groupByCategory(allMatches: Match[]): Record<Category, CategoryGroup> {
  // カテゴリごとに、フレーズ(label文字列)ごとの出現回数を集計
  const byCategory = {} as Record<Category, CategoryGroup>;
  for (const cat of CATEGORY_ORDER) {
    byCategory[cat] = { label: "", items: new Map<string, number>() };
  }
  for (const m of allMatches) {
    byCategory[m.category].label = m.categoryLabel;
    const key = m.label;
    const cur = byCategory[m.category].items.get(key) || 0;
    byCategory[m.category].items.set(key, cur + 1);
  }
  return byCategory;
}

// テキストを解析し、UI が必要とする結果一式をまとめて返す純粋関数。
export function analyze(text: string): Result {
  const { all, nonOverlapping } = findMatches(text);
  const rawWeightSum = all.reduce((sum, m) => sum + m.weight, 0);
  const charLength = text.length;
  const matchCount = all.length;
  const isShort = charLength < 100;

  let score: number | null = null;
  let rank: string | null = null;
  let comment: string | null = null;
  if (!isShort && charLength > 0) {
    score = computeScore(rawWeightSum, charLength);
    const r = rankFromScore(score);
    rank = r.rank;
    comment = r.comment;
  }

  const byCategory = groupByCategory(all);

  return {
    charLength,
    matchCount,
    isShort,
    score,
    rank,
    comment,
    nonOverlapping,
    byCategory,
  };
}
