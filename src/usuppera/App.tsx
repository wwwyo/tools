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
      <span className="font-mincho text-[2.4rem] font-bold leading-none">{rank}</span>
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
          <h1 className="m-0 mb-2 font-mincho text-[2rem] font-bold tracking-[0.08em]">薄っぺらな戯</h1>
          <p className="m-0 text-[0.88rem] text-muted">
            LLM が日本語で使いがちな、もっともらしい定型句を辞書だけで検知します。
          </p>
        </div>
      </header>

      <div className="relative overflow-hidden rounded border border-border">
        <div
          ref={backdropRef}
          aria-hidden="true"
          className="lined-textarea pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3 pb-0 text-base text-ink"
        >
          {backdropNodes}
          {"\n"}
        </div>
        <textarea
          className="relative block min-h-[222px] w-full resize-y border-0 bg-transparent px-4 pt-3 pb-0 text-base text-transparent caret-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-red focus-visible:outline-offset-2"
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
          className="cursor-pointer rounded border border-border bg-card-bg px-3.5 py-1.5 text-[0.85rem] text-ink hover:border-red hover:text-red focus-visible:outline-2 focus-visible:outline-red focus-visible:outline-offset-2"
          onClick={() => {
            setText(SAMPLE_TEXT);
            setScoredText(SAMPLE_TEXT);
          }}
        >
          サンプル文を試す
        </button>
        <button
          type="button"
          className="cursor-pointer rounded border border-red bg-card-bg px-3.5 py-1.5 text-[0.85rem] font-bold text-red hover:border-red hover:text-red focus-visible:outline-2 focus-visible:outline-red focus-visible:outline-offset-2"
          onClick={() => setScoredText(text)}
        >
          採点する
        </button>
      </div>

      <div className="mt-7">
        {scoredText.length === 0 ? null : (
          <>
            {result.isShort ? (
              <div className="mb-6 rounded border border-border bg-card-bg p-4 text-[0.9rem] text-muted">
                文章が短すぎます（100文字以上を推奨）
                <br />
                検知数 {result.matchCount} / 単語数 {wordCount}
              </div>
            ) : (
              <div className="relative mb-6 flex items-center gap-5 rounded border border-border bg-card-bg pt-5 pr-[120px] pb-5 pl-5 max-[480px]:flex-col max-[480px]:items-start max-[480px]:pr-[100px]">
                <div className="flex-1">
                  <div className="font-mincho text-[1.1rem] font-bold tracking-[0.05em] text-red">
                    ランク {result.rank}
                  </div>
                  <div className="mt-1 text-[0.9rem] text-muted">{result.comment}</div>
                  <div className="mt-1.5 font-mono text-[0.8rem] text-muted">
                    検知数 {result.matchCount} / 単語数 {wordCount}
                  </div>
                </div>
                <RankStamp rank={result.rank ?? "-"} />
              </div>
            )}

            <h2 className="mt-0 mb-2.5 font-mincho text-base tracking-[0.05em]">ぺらっぺらな表現</h2>
            {detectedItems.length > 0 ? (
              <ul className="m-0 list-none p-0">
                {detectedItems.map(([phrase, count]) => (
                  <li
                    key={phrase}
                    className="flex justify-between border-t border-border py-1 text-[0.88rem] first:border-t-0"
                  >
                    <span>{phrase}</span>
                    <span className="font-mono text-muted">×{count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 font-mono text-[0.8rem] text-muted">該当する表現は見つかりませんでした。</p>
            )}
          </>
        )}
      </div>

      <footer className="mt-12 border-t border-border pt-4 text-[0.78rem] text-muted">
        決定論的な辞書マッチのみで動作。テキストはどこにも送信されません。
      </footer>
    </div>
  );
}
