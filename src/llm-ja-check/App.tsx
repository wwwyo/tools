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

function SealMark() {
  return (
    <svg className="seal-mark" viewBox="0 0 64 64" role="img" aria-label="校正の角印">
      <rect x="4" y="4" width="56" height="56" fill="none" stroke="var(--red)" strokeWidth="3" />
      <rect x="9" y="9" width="46" height="46" fill="none" stroke="var(--red)" strokeWidth="1.5" />
      <text
        x="32"
        y="40"
        textAnchor="middle"
        fontSize="30"
        fill="var(--red)"
        fontFamily='"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif'
      >
        校
      </text>
    </svg>
  );
}

function HankoStamp({ score, rank }: { score: number; rank: string }) {
  return (
    <div className="hanko-stamp" key={score}>
      <svg viewBox="0 0 120 120" role="img" aria-label={`検印 ランク${rank} スコア${score}`}>
        <circle cx="60" cy="60" r="54" fill="none" stroke="var(--red)" strokeWidth="4" />
        <circle cx="60" cy="60" r="46" fill="none" stroke="var(--red)" strokeWidth="1.5" />
        <text
          x="60"
          y="62"
          textAnchor="middle"
          fontSize="40"
          fill="var(--red)"
          fontFamily='"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif'
        >
          {rank}
        </text>
        <text x="60" y="90" textAnchor="middle" fontSize="16" fill="var(--red)" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
          {score}
        </text>
      </svg>
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
        <SealMark />
        <div className="header-text">
          <h1>LLM 日本語っぽさチェッカー</h1>
          <p className="lead">
            テキストを貼り付けると、LLM がよく使う定型句・過剰表現を辞書ベースで検知してスコア化します。
          </p>
        </div>
      </header>

      <div className="paper-card">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ここに原稿を貼り付けてください"
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
                <HankoStamp score={result.score ?? 0} rank={result.rank ?? "-"} />
                <div className="score-meta">
                  <div className="score-rank">ランク {result.rank}</div>
                  <div className="score-comment">{result.comment}</div>
                  <div className="score-sub">
                    検知数 {result.matchCount} / 文字数 {result.charLength}
                  </div>
                </div>
              </div>
            )}

            <h2>校正紙</h2>
            <ul className="legend">
              {LEGEND.map((l) => (
                <li key={l.category} className={l.markerClass}>
                  <span className="legend-sample">見本</span>
                  {l.label}
                </li>
              ))}
            </ul>
            <div className="highlighted-box">{highlightedNodes.length > 0 ? highlightedNodes : "(空)"}</div>

            <h2>検知リスト</h2>
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
