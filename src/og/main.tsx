import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import '../global.css';
import { OgTemplate } from './template';
// vite-env.d.ts で型宣言した virtual module。ogPlugin が実際に生成するカード一覧をそのまま受け取る
import { ogCards } from 'virtual:og-cards';

// 1200x630 は画面に収まらないのでスケールダウンして並べる
const SCALE = 0.4;
const CARD_WIDTH = 1200 * SCALE;
const CARD_HEIGHT = 630 * SCALE;

// デモページはブラウザで動くので、build 時に動的 import する vite.config.ts 側とは別に
// glob で src/<dir>/og.tsx を集めて React 描画側の preview に使う（og.tsx が無いツールもある
// ので eager import の結果が空でも構わない）
const ogPreviewModules = import.meta.glob<{ default: ComponentType }>('../*/og.tsx', {
  eager: true,
});

function findOgPreview(cardName: string): ComponentType | undefined {
  return ogPreviewModules[`../${cardName}/og.tsx`]?.default;
}

function App() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32, padding: 32 }}>
      <h1 style={{ margin: 0 }}>OGP デモ</h1>
      <p style={{ margin: 0, color: '#7a7367' }}>
        左: template.tsx を React でそのまま描画 / 右: satori が生成した実際の PNG
        （フォントレンダリングなど satori 特有の差分が出るのでここで見比べる）
      </p>
      {ogCards.map((card) => {
        const Preview = findOgPreview(card.name);
        return (
        <section key={card.name} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>
            {card.name}
            {card.number ? ` (${card.number})` : ''}
          </h2>
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: '#7a7367' }}>React 描画</span>
              <div
                style={{
                  width: CARD_WIDTH,
                  height: CARD_HEIGHT,
                  overflow: 'hidden',
                  border: '1px solid rgba(31,27,22,0.16)',
                }}
              >
                <div style={{ transform: `scale(${SCALE})`, transformOrigin: 'top left' }}>
                  <OgTemplate
                    title={card.title}
                    description={card.description}
                    preview={Preview ? <Preview /> : undefined}
                  />
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: '#7a7367' }}>satori 生成 PNG</span>
              <img
                src={`/og/${card.name}.png`}
                width={CARD_WIDTH}
                height={CARD_HEIGHT}
                style={{ border: '1px solid rgba(31,27,22,0.16)' }}
                alt={`${card.name} の OGP 画像`}
              />
            </div>
          </div>
        </section>
        );
      })}
    </div>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('root element not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
