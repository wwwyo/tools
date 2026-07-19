import { useMemo, useRef, useState, type ReactNode } from "react";
import { analyze, CATEGORY_ORDER, SAMPLE_TEXT, type Match } from "./dictionary";
import "./styles.css";

function buildHighlightedNodes(text: string, nonOverlapping: Match[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const m of nonOverlapping) {
    if (cursor < m.start) {
      nodes.push(<span key={`text-${cursor}`}>{text.slice(cursor, m.start)}</span>);
    }
    const segment = text.slice(m.start, m.end);
    nodes.push(
      <mark
        key={`mark-${m.start}-${m.end}`}
        className="detected"
        title={`${m.categoryLabel} / 減点: ${m.weight}`}
      >
        {segment}
      </mark>,
    );
    cursor = m.end;
  }
  if (cursor < text.length) {
    nodes.push(<span key={`text-${cursor}`}>{text.slice(cursor)}</span>);
  }
  return nodes;
}

const wordSegmenter = new Intl.Segmenter("ja", { granularity: "word" });

/** Intl.Segmenter による決定論的な単語数カウント（記号・空白は除く） */
function countWords(text: string): number {
  let count = 0;
  for (const seg of wordSegmenter.segment(text)) {
    if (seg.isWordLike) count++;
  }
  return count;
}

function RankStamp({ rank }: { rank: string }) {
  return (
    <div className="rank-stamp" key={rank} aria-hidden="true">
      <span className="font-serif text-4xl font-bold leading-none">{rank}</span>
    </div>
  );
}

export function App() {
  const [text, setText] = useState("");
  const [scoredText, setScoredText] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const result = useMemo(() => analyze(scoredText), [scoredText]);
  const wordCount = useMemo(() => countWords(scoredText), [scoredText]);

  const highlightedNodes = useMemo(
    () => buildHighlightedNodes(scoredText, result.nonOverlapping),
    [scoredText, result.nonOverlapping],
  );

  // 採点済みテキストと現在の入力が一致している間だけマーク付き表示を使う。
  // 編集して text が scoredText からズレたら素のテキストに戻す。
  const backdropNodes: ReactNode = text === scoredText && scoredText !== "" ? highlightedNodes : text;

  const detectedItems = useMemo(() => {
    const merged = new Map<string, number>();
    for (const cat of CATEGORY_ORDER) {
      for (const [phrase, count] of result.byCategory[cat].items) {
        merged.set(phrase, (merged.get(phrase) ?? 0) + count);
      }
    }
    return Array.from(merged.entries());
  }, [result.byCategory]);

  return (
    <div className="mx-auto max-w-[760px] px-4 pt-8 pb-16 leading-[1.8] max-[480px]:px-3 max-[480px]:pt-5 max-[480px]:pb-12">
      <header className="mb-7">
        <div>
          <h1 className="m-0 mb-2 font-serif text-3xl font-bold tracking-[0.08em]">薄っぺらな戯</h1>
          <p className="m-0 text-sm text-muted-foreground">
            LLM が日本語で使いがちな、もっともらしい定型句を辞書だけで検知します。
          </p>
        </div>
      </header>

      <div className="relative overflow-hidden">
        <div
          ref={backdropRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 py-0 text-base text-foreground"
        >
          {/* 罫線はスクロールする中身側に敷く。空のときも min-h-full で下端まで届く */}
          <div className="lined-textarea min-h-full">
            {backdropNodes}
            {"\n"}
          </div>
        </div>
        <textarea
          className="relative block min-h-[240px] w-full resize-y border-0 bg-transparent px-4 py-0 text-base leading-[40px] text-transparent caret-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onScroll={(e) => {
            if (backdropRef.current) {
              backdropRef.current.scrollTop = e.currentTarget.scrollTop;
            }
          }}
          placeholder="ここに文章を貼り付けてください"
        />
      </div>
      <div className="mt-2 flex justify-between">
        <button
          type="button"
          className="cursor-pointer rounded border border-border bg-muted px-3.5 py-1.5 text-sm text-foreground hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          onClick={() => {
            setText(SAMPLE_TEXT);
            setScoredText(SAMPLE_TEXT);
          }}
        >
          サンプル文を試す
        </button>
        <button
          type="button"
          className="cursor-pointer rounded border border-primary bg-muted px-3.5 py-1.5 text-sm font-bold text-primary hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          onClick={() => setScoredText(text)}
        >
          採点する
        </button>
      </div>

      <div className="mt-7">
        {scoredText.length === 0 ? null : (
          <>
            {result.isShort ? (
              <div className="mb-6 rounded border border-border bg-muted p-4 text-sm text-muted-foreground">
                文章が短すぎます（100文字以上を推奨）
                <br />
                検知数 {result.matchCount} / 単語数 {wordCount}
              </div>
            ) : (
              <div className="relative mb-6 flex items-center gap-5 rounded border border-border bg-muted pt-5 pr-[120px] pb-5 pl-5 max-[480px]:flex-col max-[480px]:items-start max-[480px]:pr-[100px]">
                <div className="flex-1">
                  <div className="font-serif text-lg font-bold tracking-[0.05em] text-primary">
                    ランク {result.rank}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">{result.comment}</div>
                  <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                    検知数 {result.matchCount} / 単語数 {wordCount}
                  </div>
                </div>
                <RankStamp rank={result.rank ?? "-"} />
              </div>
            )}

            <h2 className="mt-0 mb-2.5 font-serif text-base tracking-[0.05em]">ぺらっぺらな表現</h2>
            {detectedItems.length > 0 ? (
              <ul className="m-0 list-none p-0">
                {detectedItems.map(([phrase, count]) => (
                  <li
                    key={phrase}
                    className="flex justify-between border-t border-border py-1 text-sm first:border-t-0"
                  >
                    <span>{phrase}</span>
                    <span className="font-mono text-muted-foreground">×{count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 font-mono text-xs text-muted-foreground">該当する表現は見つかりませんでした。</p>
            )}
          </>
        )}
      </div>

      <footer className="mt-12 border-t border-border pt-4 text-xs text-muted-foreground">
        決定論的な辞書マッチのみで動作。テキストはどこにも送信されません。
      </footer>
    </div>
  );
}
