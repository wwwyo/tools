import type { ReactNode } from 'react';

// OGP カード (1200x630)。satori はブラウザと同じ CSS を解釈しないため inline style のみで組む。
// 同じコンポーネントを src/og/main.tsx（デモページ、通常の React 描画）からも使うため、
// Tailwind class や CSS ファイルへの依存は禁止（AGENTS.md のツール独立性とも矛盾しないよう
// この定数群は src/og/ 内に閉じ、global.css には手を入れない）。
export type OgMeta = {
  // トップページは一覧の中の 1 件ではないので number を持たない。その場合サイト名の
  // 署名もタイトルと重複するため出さない
  number?: string;
  title: string;
  description: string;
  // ツールが src/<appdir>/og.tsx を持つ場合のみ渡される画面ミニチュア。無ければ
  // テキストのみの従来レイアウトを維持する
  preview?: ReactNode;
};

// src/index.html の :root と同じ配色。global.css へは足さずここでローカル定数として持つ
const COLORS = {
  background: '#fbfaf6',
  foreground: '#1f1b16',
  primary: '#c73e2e',
  mutedForeground: '#7a7367',
} as const;

const FONT_FAMILY = 'Sawarabi Mincho';

// preview 枠のサイズ。1200x630 のうちテキスト側に十分な幅を残しつつ、ミニチュアが
// 判別できる大きさを確保する
const PREVIEW_WIDTH = 460;
const PREVIEW_HEIGHT = 440;

// preview 付きは左カラムの幅が半分以下になり、素のテキストサイズのままだと折り返しで
// 末尾 1 文字だけが次行に落ちるなど読みにくくなるため、二段組のときだけ縮小する
function TextBlock({
  number,
  title,
  description,
  compact,
}: Omit<OgMeta, 'preview'> & { compact: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {number ? (
        <span
          style={{
            display: 'flex',
            fontSize: 28,
            letterSpacing: 4,
            color: COLORS.primary,
            marginBottom: 20,
          }}
        >
          {number}
        </span>
      ) : null}
      <span
        style={{
          display: 'flex',
          fontSize: compact ? 56 : 72,
          fontWeight: 700,
          lineHeight: 1.3,
          color: COLORS.foreground,
        }}
      >
        {title}
      </span>
      <span
        style={{
          display: 'flex',
          fontSize: compact ? 26 : 32,
          color: COLORS.mutedForeground,
          marginTop: 28,
        }}
      >
        {description}
      </span>
    </div>
  );
}

export function OgTemplate({ number, title, description, preview }: OgMeta) {
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: COLORS.background,
        color: COLORS.foreground,
        fontFamily: FONT_FAMILY,
        padding: '80px 90px',
      }}
    >
      {preview ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 56 }}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <TextBlock number={number} title={title} description={description} compact />
          </div>
          {/* 「画面のミニチュア」だと分かるよう枠線と余白を付け、はみ出しは clip する */}
          <div
            style={{
              display: 'flex',
              width: PREVIEW_WIDTH,
              height: PREVIEW_HEIGHT,
              flexShrink: 0,
              overflow: 'hidden',
              border: `2px solid ${COLORS.mutedForeground}`,
              borderRadius: 12,
              backgroundColor: '#ffffff',
            }}
          >
            {preview}
          </div>
        </div>
      ) : (
        <TextBlock number={number} title={title} description={description} compact={false} />
      )}
      {number ? (
        <span
          style={{
            display: 'flex',
            fontSize: 24,
            color: COLORS.mutedForeground,
            letterSpacing: 2,
          }}
        >
          tools
        </span>
      ) : null}
    </div>
  );
}
