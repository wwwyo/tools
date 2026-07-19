import type { ReactNode } from 'react';

// OGP カード (1200x630)。satori はブラウザと同じ CSS を解釈しないため inline style のみで組む。
// 同じコンポーネントを src/og/main.tsx（デモページ、通常の React 描画）からも使うため、
// Tailwind class や CSS ファイルへの依存は禁止（AGENTS.md のツール独立性とも矛盾しないよう
// この定数群は src/og/ 内に閉じ、global.css には手を入れない）。
export type OgMeta = {
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

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

// preview 付きレイアウトの左右比率。左はテキスト、右は preview を余白なく敷き詰める
const TEXT_COLUMN_WIDTH = CARD_WIDTH * 0.4;
const PREVIEW_COLUMN_WIDTH = CARD_WIDTH * 0.6;

// テキスト側の外周余白。preview 側には掛けない（右端・上下端まで敷き詰めるため）。
// 二段組では左カラムが 480px しかなく、余白を広く取ると description の末尾 1〜2 文字だけが
// 次行に落ちるため、二段組のときだけ詰める
const TEXT_PADDING_X = 90;
const TEXT_PADDING_X_COMPACT = 68;
const TEXT_PADDING_Y = 80;

// preview 付きは左カラムの幅が半分以下になり、素のテキストサイズのままだと折り返しで
// 末尾 1 文字だけが次行に落ちるなど読みにくくなるため、二段組のときだけ縮小する
function TextBlock({
  title,
  description,
  compact,
}: Omit<OgMeta, 'preview'> & { compact: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
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
          fontSize: compact ? 24 : 32,
          color: COLORS.mutedForeground,
          marginTop: 28,
        }}
      >
        {description}
      </span>
    </div>
  );
}

export function OgTemplate({ title, description, preview }: OgMeta) {
  if (!preview) {
    // preview の無いトップページは従来どおりテキストのみを中央に置く
    return (
      <div
        style={{
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          backgroundColor: COLORS.background,
          color: COLORS.foreground,
          fontFamily: FONT_FAMILY,
          padding: `${TEXT_PADDING_Y}px ${TEXT_PADDING_X}px`,
        }}
      >
        <TextBlock title={title} description={description} compact={false} />
      </div>
    );
  }

  return (
    <div
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        display: 'flex',
        flexDirection: 'row',
        backgroundColor: COLORS.background,
        color: COLORS.foreground,
        fontFamily: FONT_FAMILY,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          width: TEXT_COLUMN_WIDTH,
          flexShrink: 0,
          padding: `${TEXT_PADDING_Y}px 0 ${TEXT_PADDING_Y}px ${TEXT_PADDING_X_COMPACT}px`,
        }}
      >
        <TextBlock title={title} description={description} compact />
      </div>
      {/* 右 60% を余白なく敷き詰める。preview 側の内容が枠より大きい場合だけ clip する */}
      <div
        style={{
          display: 'flex',
          width: PREVIEW_COLUMN_WIDTH,
          height: CARD_HEIGHT,
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        {preview}
      </div>
    </div>
  );
}
