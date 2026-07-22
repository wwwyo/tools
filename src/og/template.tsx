import type { ReactNode } from 'react';

// OGP カード (1200x630)。satori はブラウザと同じ CSS を解釈しないため inline style のみで組む。
// 同じコンポーネントを src/og/main.tsx（デモページ、通常の React 描画）からも使うため、
// Tailwind class や CSS ファイルへの依存は禁止（AGENTS.md のツール独立性とも矛盾しないよう
// この定数群は src/og/ 内に閉じ、global.css には手を入れない）。
export type OgColors = {
  background: string;
  foreground: string;
  primary: string;
  mutedForeground: string;
};

export type OgMeta = {
  title: string;
  description: string;
  // ツールが src/<appdir>/og.tsx を持つ場合のみ渡される画面ミニチュア。無ければ
  // テキストのみの従来レイアウトを維持する
  preview?: ReactNode;
  // トップページにだけ添えるアイコンの src。satori はローカルパスを読めないので
  // 画像生成側は data URL、ブラウザで描画するデモページは公開パスを渡す
  iconSrc?: string;
  // og.tsx が `ogColors` を export しているツールだけ、カード外枠の配色を上書きする。
  // ツール固有テーマの preview を敷いたとき、左のテキスト側だけ既定色のままだと
  // カード中央に配色の継ぎ目が出るため
  colors?: Partial<OgColors>;
};

// src/index.html の :root と同じ配色。global.css へは足さずここでローカル定数として持つ
const DEFAULT_COLORS: OgColors = {
  background: '#fbfaf6',
  foreground: '#1f1b16',
  primary: '#c73e2e',
  mutedForeground: '#7a7367',
};

const FONT_FAMILY = 'Sawarabi Gothic';

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

const ICON_SIZE = 200;

// preview 付きは左カラムの幅が半分以下になり、素のテキストサイズのままだと折り返しで
// 末尾 1 文字だけが次行に落ちるなど読みにくくなるため、二段組のときだけ縮小する
function TextBlock({
  title,
  description,
  compact,
  colors,
}: Pick<OgMeta, 'title' | 'description'> & { compact: boolean; colors: OgColors }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Sawarabi Gothic は 400 しか持たず、satori はブラウザと違って合成太字を作らない。
          fontWeight を指定しても効かないので書かない */}
      <span
        style={{
          display: 'flex',
          fontSize: compact ? 56 : 72,
          lineHeight: 1.3,
          color: colors.foreground,
        }}
      >
        {title}
      </span>
      {/* 文の途中で「HDR変 / 換。」のような不格好な折り返しが起きるため、
          「。」区切りの文単位で行を分ける（一文だけの description は従来どおり1行） */}
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          fontSize: compact ? 24 : 32,
          color: colors.mutedForeground,
          marginTop: 28,
        }}
      >
        {description.split(/(?<=。)/).filter((sentence) => sentence !== '').map((sentence, index) => (
          <span key={index} style={{ display: 'flex' }}>
            {sentence}
          </span>
        ))}
      </span>
    </div>
  );
}

export function OgTemplate({ title, description, preview, iconSrc, colors: overrides }: OgMeta) {
  const colors: OgColors = { ...DEFAULT_COLORS, ...overrides };
  if (!preview) {
    // preview の無いトップページも左右の分割は preview 付きと揃える。アイコンは
    // preview が入るのと同じ右カラムの中央に置く
    return (
      <div
        style={{
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          display: 'flex',
          flexDirection: 'row',
          backgroundColor: colors.background,
          color: colors.foreground,
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
            padding: `${TEXT_PADDING_Y}px 0 ${TEXT_PADDING_Y}px ${TEXT_PADDING_X}px`,
          }}
        >
          <TextBlock title={title} description={description} compact={false} colors={colors} />
        </div>
        <div
          style={{
            display: 'flex',
            width: PREVIEW_COLUMN_WIDTH,
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {iconSrc ? (
            <img src={iconSrc} width={ICON_SIZE} height={ICON_SIZE} style={{ borderRadius: ICON_SIZE / 2 }} />
          ) : null}
        </div>
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
        backgroundColor: colors.background,
        color: colors.foreground,
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
        <TextBlock title={title} description={description} compact colors={colors} />
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
