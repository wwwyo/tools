import { useMemo, useState, type ReactNode } from "react";
import { analyze, CATEGORY_ORDER, SAMPLE_TEXT, type Category, type Match } from "./dictionary";
import "./styles.css";

const LEGEND: { category: Category; label: string; markerClass: string }[] = [
  { category: "teikeiku", label: "常套句・定型句", markerClass: "legend-teikeiku" },
  { category: "kyocho", label: "過剰な強調・形容", markerClass: "legend-kyocho" },
  { category: "kango", label: "LLM 頻出漢語・抽象語", markerClass: "legend-kango" },
  { category: "enkyoku", label: "冗長・婉曲構文", markerClass: "legend-enkyoku" },
  { category: "setsuzoku", label: "接続詞の多用", markerClass: "legend-setsuzoku" },
];

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
        className={`mark-${m.category}`}
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

function ScoreDisplay({ score, rank }: { score: number; rank: string }) {
  return (
    <div className="score-display" key={score} aria-label={`薄さスコア ${score} ランク${rank}`}>
      <span className="score-number">{score}</span>
    </div>
  );
}

export function App() {
  const [text, setText] = useState("");
  const result = useMemo(() => analyze(text), [text]);

  const highlightedNodes = useMemo(
    () => buildHighlightedNodes(text, result.nonOverlapping),
    [text, result.nonOverlapping],
  );

  const hasAnyDetect = CATEGORY_ORDER.some((cat) => result.byCategory[cat].items.size > 0);

  return (
    <div className="page">
      <header className="header">
        <div className="header-text">
          <p className="power-ruby">プラウジブル・テクスチャー / Plausible Texture</p>
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
          placeholder="ここに文章を貼ると、膜を剥がします"
        />
      </div>
      <div className="toolbar">
        <button type="button" onClick={() => setText(SAMPLE_TEXT)}>
          サンプル文を試す
        </button>
      </div>

      <div className="results">
        {text.length === 0 ? (
          <div className="placeholder">テキストを入力すると、ここに解析結果が表示されます。</div>
        ) : (
          <>
            {result.isShort ? (
              <div className="short-notice">
                文章が短すぎます（100文字以上を推奨）
                <br />
                検知数 {result.matchCount} / 文字数 {result.charLength}
              </div>
            ) : (
              <div className="score-card">
                <ScoreDisplay score={result.score ?? 0} rank={result.rank ?? "-"} />
                <div className="score-meta">
                  <div className="score-rank">ランク {result.rank}</div>
                  <div className="score-comment">{result.comment}</div>
                  <div className="score-sub">
                    検知数 {result.matchCount} / 文字数 {result.charLength}
                  </div>
                </div>
              </div>
            )}

            <h2>剥がれた膜</h2>
            <ul className="legend">
              {LEGEND.map((l) => (
                <li key={l.category} className={l.markerClass}>
                  <span className="legend-sample">見本</span>
                  {l.label}
                </li>
              ))}
            </ul>
            <div className="highlighted-box">{highlightedNodes.length > 0 ? highlightedNodes : "(空)"}</div>

            <h2>検出された定型句</h2>
            {hasAnyDetect ? (
              CATEGORY_ORDER.map((cat) => {
                const group = result.byCategory[cat];
                if (group.items.size === 0) return null;
                return (
                  <div className="detect-group" key={cat}>
                    <h3>{group.label}</h3>
                    <ul className="detect-list">
                      {Array.from(group.items.entries()).map(([phrase, count]) => (
                        <li key={phrase}>
                          <span className="detect-phrase">{phrase}</span>
                          <span className="detect-count">×{count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })
            ) : (
              <p className="score-sub">該当する定型句・過剰表現は見つかりませんでした。</p>
            )}
          </>
        )}
      </div>

      <footer>
        決定論的な辞書マッチのみで動作。テキストはどこにも送信されません。
        <br />
        <a href="https://github.com/wwwyo/tools" target="_blank" rel="noopener">
          github.com/wwwyo/tools
        </a>
      </footer>
    </div>
  );
}
