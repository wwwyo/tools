import { useMemo, useState, type ReactNode } from "react";
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
      <span>{rank}</span>
    </div>
  );
}

export function App() {
  const [text, setText] = useState("");
  const [scoredText, setScoredText] = useState("");
  const result = useMemo(() => analyze(scoredText), [scoredText]);
  const wordCount = useMemo(() => countWords(scoredText), [scoredText]);

  const highlightedNodes = useMemo(
    () => buildHighlightedNodes(scoredText, result.nonOverlapping),
    [scoredText, result.nonOverlapping],
  );

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
    <div className="page">
      <header className="header">
        <div className="header-text">
          <h1>薄っぺらな嘘</h1>
          <p className="lead">
            LLM が日本語で使いがちな、もっともらしい定型句を辞書だけで検知します。
          </p>
        </div>
      </header>

      <div className="paper-card">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ここに文章を貼り付けてください"
        />
      </div>
      <div className="toolbar">
        <button
          type="button"
          onClick={() => {
            setText(SAMPLE_TEXT);
            setScoredText(SAMPLE_TEXT);
          }}
        >
          サンプル文を試す
        </button>
        <button type="button" className="score-button" onClick={() => setScoredText(text)}>
          採点する
        </button>
      </div>

      <div className="results">
        {scoredText.length === 0 ? null : (
          <>
            {result.isShort ? (
              <div className="short-notice">
                文章が短すぎます（100文字以上を推奨）
                <br />
                検知数 {result.matchCount} / 単語数 {wordCount}
              </div>
            ) : (
              <div className="score-card">
                <div className="score-meta">
                  <div className="score-rank">ランク {result.rank}</div>
                  <div className="score-comment">{result.comment}</div>
                  <div className="score-sub">
                    検知数 {result.matchCount} / 単語数 {wordCount}
                  </div>
                </div>
                <RankStamp rank={result.rank ?? "-"} />
              </div>
            )}

            <h2>ハイライト</h2>
            <div className="highlighted-box">{highlightedNodes.length > 0 ? highlightedNodes : "(空)"}</div>

            <h2>検出された表現</h2>
            {detectedItems.length > 0 ? (
              <ul className="detect-list">
                {detectedItems.map(([phrase, count]) => (
                  <li key={phrase}>
                    <span className="detect-phrase">{phrase}</span>
                    <span className="detect-count">×{count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="score-sub">該当する表現は見つかりませんでした。</p>
            )}
          </>
        )}
      </div>

      <footer>決定論的な辞書マッチのみで動作。テキストはどこにも送信されません。</footer>
    </div>
  );
}
