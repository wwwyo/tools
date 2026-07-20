// ------------------------------------------------------------------
// 検知辞書
// 3層構成: 記号・書式層(kigo) / フレーズ辞書層(hype/teikei/template/kotonakare/jouchou/setsuzoku) / 統計層
// pattern は string（部分一致・literalに正規表現エスケープして使用）
// または RegExp（okurigana/助詞ゆれを吸収するため）。
// weight は「1回マッチしたときの減点相当ポイント」。
//
// 出典:
// - https://github.com/textlint-ja/textlint-rule-preset-ai-writing
// - https://github.com/gonta223/humanizer-ja
// - https://github.com/mrtomdev/truthlens
// ------------------------------------------------------------------

export type Category = "kigo" | "hype" | "teikei" | "template" | "kotonakare" | "jouchou" | "setsuzoku";

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

export interface StatSignal {
  key: "burstiness" | "endingRepetition" | "openerUniformity";
  label: string;
  detail: string;
  penalty: number;
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
  statSignals: StatSignal[];
  statPenalty: number;
}

const KIGO_LABEL = "記号・書式の癖";
const HYPE_LABEL = "ハイプ・誇張";
const TEIKEI_LABEL = "定型評価語";
const TEMPLATE_LABEL = "テンプレ導入・結び";
const KOTONAKARE_LABEL = "事なかれ・両論併記";
const JOUCHOU_LABEL = "冗長・機械的構文";
const SETSUZOKU_LABEL = "接続詞の連打";

export const DICTIONARY: DictionaryEntry[] = [
  // 1. 記号・書式層
  { category: "kigo", categoryLabel: KIGO_LABEL, pattern: /[—―]/g, weight: 10, label: "em ダッシュ（—）" },
  {
    category: "kigo",
    categoryLabel: KIGO_LABEL,
    // コロンは太字の内側（**速度:**）と外側（**速度**:）の両方の書き方がある
    pattern: /\*\*[^*\n]{1,30}\*\*[:：]|\*\*[^*\n:：]{1,29}[:：]\*\*/g,
    weight: 12,
    label: "太字ラベル+コロン箇条書き",
  },
  {
    category: "kigo",
    categoryLabel: KIGO_LABEL,
    pattern: /\*\*[^*\n]{1,30}\*\*/g,
    weight: 8,
    label: "Markdown 太字の残骸",
  },
  {
    category: "kigo",
    categoryLabel: KIGO_LABEL,
    // \p{Emoji} は 0-9 や # も含んでしまうため Extended_Pictographic を使う。
    // ©®™ も Extended_Pictographic に含まれるが絵文字装飾ではないので除外。
    // 行頭空白は改行を跨がないよう [^\S\n] に限定する
    pattern: /(^|\n)[^\S\n]*(?:[-・*][^\S\n]*)?(?![©®™])\p{Extended_Pictographic}/gu,
    weight: 10,
    label: "絵文字プレフィックス",
  },
  { category: "kigo", categoryLabel: KIGO_LABEL, pattern: /：[ \t]/g, weight: 6, label: "全角コロン+半角スペース" },
  {
    category: "kigo",
    categoryLabel: KIGO_LABEL,
    // 隣接文字を消費すると「A／B／C」の2本目が取れないため lookaround にする
    pattern: /(?<=[^\s／])／(?=[^\s／])/gu,
    weight: 5,
    label: "全角スラッシュ並列",
  },
  {
    category: "kigo",
    categoryLabel: KIGO_LABEL,
    pattern: /(^|\n)(?:ステップ|STEP|Step)[^\S\r\n]*[0-9０-９]+/g,
    weight: 8,
    label: "ステップN形式",
  },

  // 2-1. hype（ハイプ・誇張）
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "革命的", weight: 9 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "ゲームチェンジャー", weight: 9 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "世界初の", weight: 8 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "究極の", weight: 8 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "完璧な", weight: 7 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "最先端", weight: 7 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "魔法のよう", weight: 9 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "奇跡的", weight: 8 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "驚異的", weight: 8 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "パラダイムシフト", weight: 9 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "次世代の", weight: 7 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "業界を再定義", weight: 9 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "未来を変える", weight: 8 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "可能性を解き放", weight: 9 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "潜在能力を引き出", weight: 8 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "根本的に変革", weight: 8 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "フロンティアを開拓", weight: 9 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "新たな基準を", weight: 7 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "圧倒的", weight: 7 },
  { category: "hype", categoryLabel: HYPE_LABEL, pattern: "飛躍的に", weight: 7 },

  // 2-2. teikei（定型評価語）
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: "浮き彫りにし", weight: 10 },
  {
    category: "teikei",
    categoryLabel: TEIKEI_LABEL,
    pattern: /今後の(?:展開|動向|発展)(?:が|に)(?:注目|期待)/g,
    weight: 10,
  },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: "注目に値する", weight: 8 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /重要な示唆を/g, weight: 9 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /を示しており/g, weight: 7 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /を物語って/g, weight: 8 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /重要な役割を果た/g, weight: 8 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /鍵を握って/g, weight: 7 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: "鍵となる", weight: 7 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /本質を(?:突いて|捉えて)/g, weight: 7 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: "計り知れない", weight: 8 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /多角的に/g, weight: 7 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /に他ならな/g, weight: 8 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: /言うまでもな/g, weight: 7 },
  { category: "teikei", categoryLabel: TEIKEI_LABEL, pattern: "唯一無二", weight: 7 },

  // 2-3. template（テンプレ導入・結び）
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: "本記事では", weight: 10 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: "この記事では", weight: 10 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: "いかがでしたか", weight: 11 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /結論から言うと/g, weight: 8 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /以下の\d+つの/g, weight: 9 },
  {
    category: "template",
    categoryLabel: TEMPLATE_LABEL,
    pattern: /[3３三]つの(?:観点|ポイント|理由|方法)/g,
    weight: 8,
  },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /見ていきましょう/g, weight: 10 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /解説していきます/g, weight: 10 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /注目を集めて/g, weight: 8 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /ぜひ参考にして/g, weight: 10 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /最後までお読みいただき/g, weight: 11 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /今後ますます/g, weight: 8 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /徹底解説/g, weight: 9 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /まとめると/g, weight: 7 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /締めくくりに/g, weight: 7 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /期待されます/g, weight: 8 },
  { category: "template", categoryLabel: TEMPLATE_LABEL, pattern: /重要になると考えられ/g, weight: 9 },

  // 2-4. kotonakare（事なかれ・両論併記）
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /一概には言えません/g, weight: 9 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: "ケースバイケース", weight: 9 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /場合によります/g, weight: 8 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /状況に応じて(?:異なり|変わり)/g, weight: 8 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /メリットもあれば/g, weight: 9 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /賛否が分かれ/g, weight: 7 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /と言えるでしょう/g, weight: 8 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /ではないでしょうか/g, weight: 8 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /かもしれません。/g, weight: 4 },
  { category: "kotonakare", categoryLabel: KOTONAKARE_LABEL, pattern: /バランスが(?:重要|大切)/g, weight: 8 },

  // 2-5. jouchou（冗長・機械的構文）
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /することができます/g, weight: 5 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /する必要があります/g, weight: 4 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /まず最初に/g, weight: 5 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /と考えられます/g, weight: 4 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /と言われています/g, weight: 4 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /ここで重要なのは/g, weight: 7 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /理解しておく必要があ/g, weight: 7 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /注意すべき点として/g, weight: 6 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /することが重要です/g, weight: 6 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /することが求められ/g, weight: 6 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /行うことが可能です/g, weight: 6 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /を実現します/g, weight: 5 },
  { category: "jouchou", categoryLabel: JOUCHOU_LABEL, pattern: /を提供します/g, weight: 5 },

  // 2-6. setsuzoku（接続詞の連打、行頭のみ）
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)さらに、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)また、/g, weight: 1 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)一方で、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)加えて、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)しかしながら、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)このように、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)そして、/g, weight: 1 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)したがって、/g, weight: 2 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)つまり、/g, weight: 1 },
  { category: "setsuzoku", categoryLabel: SETSUZOKU_LABEL, pattern: /(^|\n)とりわけ、/g, weight: 2 },
];

export const CATEGORY_ORDER: Category[] = [
  "kigo",
  "hype",
  "teikei",
  "template",
  "kotonakare",
  "jouchou",
  "setsuzoku",
];

export const SAMPLE_TEXT =
  "近年、AIの活用が注目を集めています——特にビジネスの現場で。本記事では、以下の3つの観点から解説していきます。\n\n" +
  "**効率化:** 業務プロセスを最適化することができます。\n" +
  "**創造性:** 新たなアイデアの可能性を解き放ちます。\n" +
  "**分析力:** データの本質を捉えて重要な示唆を与えます。\n\n" +
  "この結果は、AIが革命的なゲームチェンジャーであることを浮き彫りにしており、今後の展開が注目されます。" +
  "ただし、導入の是非は一概には言えません。ケースバイケースで判断することが重要です。" +
  "まとめると、AIの活用は今後ますます重要になると考えられます。いかがでしたか。ぜひ参考にしてみてください。";

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
  // 開始位置でソートし、先に始まる区間を代表マッチとして採用する。
  // 意味的な重複排除ではなく、ハイライトのネスト防止と保守的な減点
  // （全件加算より必ず少なくなる）のための位置ベースの排他。
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
// 1. 重複除去後のマッチの weight を合算して rawWeightSum を得る。
// 2. 400文字ブロックに正規化: normalizedDeduction = rawWeightSum * (400 / contentLength)
//    短文では標本が少なく辞書1件の影響が過大になるため、400文字未満は増幅しない。
// 3. score = clamp(100 - round(normalizedDeduction) - statPenalty, 0, 100)
export function computeScore(rawWeightSum: number, contentLength: number, statPenalty: number): number {
  const normalizedDeduction = rawWeightSum * (400 / Math.max(contentLength, 400));
  const score = Math.max(0, Math.min(100, 100 - Math.round(normalizedDeduction) - statPenalty));
  return score;
}

export function rankFromScore(score: number): { rank: string; comment: string } {
  // 検知ゼロ相当の満点近辺は「人間でも多少は踏む」の逆張りで S 扱い
  if (score >= 97) return { rank: "S", comment: "逆に怪しいです" };
  if (score >= 75) return { rank: "A", comment: "良いです" };
  if (score >= 55) return { rank: "C", comment: "ペラいです" };
  if (score >= 30) return { rank: "D", comment: "うすっぺらです" };
  return { rank: "E", comment: "ペラッペラです" };
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

// 統計層: 文分割。空要素・5文字未満の断片は除外する。
// 箇条書き記号や引用の閉じ括弧が文頭に残ると、文体ではなくレイアウトを
// 測ってしまう（記号は kigo 層の担当）ため、先頭から剥がしてから統計を取る。
function splitSentences(text: string): string[] {
  // 絵文字は ZWJ シーケンス・variation selector の残骸が文頭反復として
  // 数えられないよう、構成要素ごと剥がす
  const marker =
    /^(?:(?:[-・*>#」』）]|\[[ xX]\]|[0-9０-９]+[.．)）]|[（(][0-9０-９]+[)）]|\p{Extended_Pictographic}|[\u200D\uFE0F])[^\S\n]*)+/u;
  return text
    .split(/(?<=[。！？])|\n+/)
    .map((s) => s.trim().replace(marker, ""))
    .filter((s) => s.length >= 5);
}

// 文長の変動係数（CV = 標準偏差 / 平均）が低いほど、機械的に均一な文章とみなす。
function computeBurstiness(sentences: string[]): StatSignal | null {
  const lengths = sentences.map((s) => s.length);
  const mean = lengths.reduce((sum, l) => sum + l, 0) / lengths.length;
  const variance = lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length;
  const cv = mean === 0 ? 0 : Math.sqrt(variance) / mean;

  let penalty = 0;
  if (cv < 0.3) penalty = 15;
  else if (cv < 0.4) penalty = 10;
  else if (cv < 0.5) penalty = 5;
  if (penalty === 0) return null;

  return {
    key: "burstiness",
    label: "文長が均一",
    detail: `文長のばらつき CV ${cv.toFixed(2)}（人間の文章はばらつきが大きい、CV 0.6 以上が目安）`,
    penalty,
  };
}

// 文末の単調さ: 各文の句読点を除いた末尾3文字の最頻値の占有率。
function computeEndingRepetition(sentences: string[]): StatSignal | null {
  const endings = sentences.map((s) => s.replace(/[。！？]+$/, "").slice(-3));
  const counts = new Map<string, number>();
  for (const ending of endings) {
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
  }
  let topEnding = "";
  let maxCount = 0;
  for (const [ending, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      topEnding = ending;
    }
  }
  const r = maxCount / sentences.length;

  let penalty = 0;
  if (r >= 0.8) penalty = 12;
  else if (r >= 0.65) penalty = 8;
  else if (r >= 0.5) penalty = 4;
  if (penalty === 0) return null;

  return {
    key: "endingRepetition",
    label: "文末が単調",
    detail: `「${topEnding}」が全体の${Math.round(r * 100)}%`,
    penalty,
  };
}

// 文頭の均一さ: 各文の先頭2文字の異なり率。
function computeOpenerUniformity(sentences: string[]): StatSignal | null {
  const openers = sentences.map((s) => s.slice(0, 2));
  const unique = new Set(openers).size;
  const u = unique / sentences.length;

  let penalty = 0;
  if (u < 0.5) penalty = 8;
  else if (u < 0.65) penalty = 4;
  if (penalty === 0) return null;

  return {
    key: "openerUniformity",
    label: "文頭が画一的",
    detail: `文頭2文字の異なり率 ${u.toFixed(2)}（人間の文章は 0.65 以上が目安）`,
    penalty,
  };
}

// 有効文数が5未満の短い入力では、分散の推定自体が不安定になるためスキップする。
function computeStatSignals(text: string): StatSignal[] {
  const sentences = splitSentences(text);
  if (sentences.length < 5) return [];

  const signals: StatSignal[] = [];
  const burstiness = computeBurstiness(sentences);
  if (burstiness) signals.push(burstiness);
  const endingRepetition = computeEndingRepetition(sentences);
  if (endingRepetition) signals.push(endingRepetition);
  const openerUniformity = computeOpenerUniformity(sentences);
  if (openerUniformity) signals.push(openerUniformity);
  return signals;
}

// テキストを解析し、UI が必要とする結果一式をまとめて返す純粋関数。
export function analyze(text: string): Result {
  const { nonOverlapping } = findMatches(text);
  // 同一区間に複数パターンが重なるケース（太字+コロン等）で減点が二重になるため、
  // スコアも一覧も重複除去後のマッチで数える。
  const rawWeightSum = nonOverlapping.reduce((sum, m) => sum + m.weight, 0);
  const charLength = text.length;
  // 空白・改行の水増しでスコアを薄められないよう、判定と正規化は実効文字数で行う
  const contentLength = text.replace(/\s/g, "").length;
  const matchCount = nonOverlapping.length;
  const isShort = contentLength < 100;

  const statSignals = computeStatSignals(text);
  // 3指標は「同型の箇条書き」のような同一原因で同時に発火しやすく、単純加算だと三重罰になる
  const statPenalty = Math.min(
    20,
    statSignals.reduce((sum, s) => sum + s.penalty, 0),
  );

  let score: number | null = null;
  let rank: string | null = null;
  let comment: string | null = null;
  if (!isShort && contentLength > 0) {
    score = computeScore(rawWeightSum, contentLength, statPenalty);
    const r = rankFromScore(score);
    rank = r.rank;
    comment = r.comment;
  }

  const byCategory = groupByCategory(nonOverlapping);

  return {
    charLength,
    matchCount,
    isShort,
    score,
    rank,
    comment,
    nonOverlapping,
    byCategory,
    statSignals,
    statPenalty,
  };
}
