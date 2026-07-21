import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createElement, Fragment, type ComponentType, type ReactNode } from 'react';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { renderOgPng } from './src/og/render';
import type { OgColors } from './src/og/template';

const __dirname = dirname(fileURLToPath(import.meta.url));

// og:image / og:url は絶対 URL でないとクローラが解決できないため、相対パスにはできない
const SITE_URL = 'https://tools.wwwyo.dev';

// ヘッダーの GitHub リンクの起点。ツールページでは配下の src/<appdir> へ差し替える
const REPO_URL = 'https://github.com/wwwyo/tools';

// src/og/ は OGP のデモページで、ツールではない（一覧にも出さないし OGP 自体も生成しない）
const NON_TOOL_DIRS = new Set(['og']);

// src/index.html と src/<appdir>/index.html をエントリとして自動検出する
function discoverHtmlEntries(): Record<string, string> {
  const srcDir = join(__dirname, 'src');
  const input: Record<string, string> = { index: join(srcDir, 'index.html') };
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const html = join(srcDir, entry.name, 'index.html');
    if (existsSync(html)) input[entry.name] = html;
  }
  return input;
}

type ToolMeta = { dir: string; title: string; description: string };

// src/<appdir>/index.html の <title> / <meta name="description"> から一覧を組み立てる
function discoverTools(): ToolMeta[] {
  const srcDir = join(__dirname, 'src');
  const tools: ToolMeta[] = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || NON_TOOL_DIRS.has(entry.name)) continue;
    const htmlPath = join(srcDir, entry.name, 'index.html');
    if (!existsSync(htmlPath)) continue;
    const html = readFileSync(htmlPath, 'utf-8');
    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
    tools.push({
      dir: entry.name,
      title: titleMatch?.[1] ?? entry.name,
      description: descMatch?.[1] ?? '',
    });
  }
  return tools;
}

function toolListNumber(index: number): string {
  return `No.${String(index + 1).padStart(3, '0')}`;
}

// 掲載日は index.html の初回コミット日。未コミットのツールは日付なしで返す
// （今日の日付にフォールバックすると commit 前後で表示が変わってしまう）
function toolPublishedAt(dir: string): string | undefined {
  const out = execSync(`git log --diff-filter=A --format=%as -- src/${dir}/index.html`, {
    cwd: __dirname,
    encoding: 'utf-8',
  }).trim();
  return out.split('\n').at(-1) || undefined;
}

// 全エントリの <body> 直後に共通ヘッダーを差し込む
function headerPlugin(): Plugin {
  return {
    name: 'header',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // dev で src/header.html を編集→リロードした結果を即反映させるためキャッシュしない
        const header = readFileSync(join(__dirname, 'src', 'header.html'), 'utf-8');
        // トップページのみ data-header-title の <a> を h1 化する。ツールページは各自の h1 と競合するため素のリンクのまま
        // dev は `/goteki/`、build は `/goteki/index.html` で来るので両方から appdir を取る
        const appdir = ctx.path.replace(/\/index\.html$/, '').replace(/^\/|\/$/g, '');
        const withTitle = appdir
          ? header
          : header.replace(/(<a[^>]*data-header-title[^>]*>.*?<\/a>)/s, '<h1 class="m-0">$1</h1>');
        // 開いているツールの source を直接開かせる。トップは repo root
        const injected = appdir
          ? withTitle.replace(REPO_URL, `${REPO_URL}/tree/main/src/${appdir}`)
          : withTitle;
        return html.replace(/(<body[^>]*>)/, `$1\n${injected}`);
      },
    },
  };
}

// 全エントリの <head> へ favicon を差し込む（ツール側に書かせない）
function faviconPlugin(): Plugin {
  return {
    name: 'favicon',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const links = [
          '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">',
          '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
        ].join('\n');
        return html.replace(/(<\/head>)/, `${links}\n$1`);
      },
    },
  };
}

// src/index.html のツール一覧を <!-- TOOL_LIST --> プレースホルダに差し込む
function toolListPlugin(): Plugin {
  return {
    name: 'tool-list',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (ctx.path !== '/index.html') return html;
        // 並び替えはトップページの表示だけ。discoverOgCards() の番号はアルファベット順のまま
        // にして、既存 OG 画像の No. がずれないようにする
        const tools = discoverTools()
          .map((tool) => ({ ...tool, publishedAt: toolPublishedAt(tool.dir) }))
          .sort((a, b) => {
            if (a.publishedAt !== b.publishedAt) {
              if (!a.publishedAt) return 1;
              if (!b.publishedAt) return -1;
              return b.publishedAt.localeCompare(a.publishedAt);
            }
            return a.dir.localeCompare(b.dir);
          });
        const items = tools
          .map(
            (tool) => `  <li>
    <a class="group block text-inherit no-underline focus-visible:rounded-[2px] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4" href="/${tool.dir}/">
      <img class="mb-3 w-full rounded-sm border border-[rgba(31,27,22,0.16)]" src="/og/${tool.dir}.png" width="1200" height="630" loading="lazy" alt="">${
        tool.publishedAt
          ? `\n      <time class="mb-1.5 block font-mono text-xs tracking-[0.08em] text-primary" datetime="${tool.publishedAt}">${tool.publishedAt}</time>`
          : ''
      }
      <span class="font-serif text-lg font-bold text-foreground">${escapeHtml(tool.title)}</span>
      <p class="mt-1 mb-0 text-sm text-muted-foreground">${escapeHtml(tool.description)}</p>
    </a>
  </li>`,
          )
          .join('\n');
        return html.replace('<!-- TOOL_LIST -->', items);
      },
    },
  };
}

// トップページの説明文。src/index.html には description meta を書かせていない（自明な
// 定型文をツール側に書かせるのは避ける方針）ため、OGP 用にここへ直接持つ
const SITE_DESCRIPTION = 'ペラいち Tools';

// トップページのカードに添える GitHub アバター。favicon と同じ画像を使い回す。
// satori はローカルパスも公開パスも読めないので data URL にして渡す
const SITE_ICON_PATH = join(__dirname, 'src', 'public', 'apple-touch-icon.png');

function siteIconDataUrl(): string {
  return `data:image/png;base64,${readFileSync(SITE_ICON_PATH).toString('base64')}`;
}

type OgCard = { name: string; number?: string; title: string; description: string };

// OGP を持つページの一覧。name はそのまま /og/<name>.png になる。
// dev middleware / build / デモページ / meta 注入がすべてこの 1 つを見ることで、
// トップページの特別扱いが各所に散らないようにする
function discoverOgCards(): OgCard[] {
  const tools = discoverTools().map((tool, i) => ({
    name: tool.dir,
    number: toolListNumber(i),
    title: tool.title,
    description: tool.description,
  }));
  return [{ name: 'index', title: 'tools', description: SITE_DESCRIPTION }, ...tools];
}

// src/<dir>/og.tsx があるツールだけ satori 用の preview 要素を返す。無ければ undefined
// (= テキストのみのカードにフォールバック)。og.tsx を持つことをツールの必須要件にはしない。
//
// `bun run dev` の直接実行では bun ランタイムが .tsx を native import できるため
// `import(pathToFileURL(...).href)` がそのまま動く。しかし `vite build` は rolldown 経由で
// プラグインを Node の ESM ローダー上で実行するため、そちらは .tsx を解釈できず
// ERR_UNKNOWN_FILE_EXTENSION で落ちる（bun run build で確認済み）。dev/build 双方で同じ経路
// にするため、常に esbuild でトランスパイルしてから data: URL 経由で import するフォールバック
// 方式に統一する。og.tsx 側は外部 import を持たない前提（bare specifier はデータ URL からだと
// 解決できない）なので、JSX ランタイムだけは import 文を発生させない classic jsx transform +
// globalThis 経由の橋渡しで解決する
function installOgJsxGlobals(): void {
  const globals = globalThis as unknown as {
    __ogJsx?: typeof createElement;
    __ogJsxFragment?: typeof Fragment;
  };
  globals.__ogJsx = createElement;
  globals.__ogJsxFragment = Fragment;
}

// dev で og.tsx を編集 → リロードした結果を即反映させたいのでソースをキャッシュしない。
// og.tsx は default export の preview に加え、任意で `ogColors` を export できる
async function loadOgModule(
  dir: string,
): Promise<{ preview?: ReactNode; colors?: Partial<OgColors> }> {
  const ogPath = join(__dirname, 'src', dir, 'og.tsx');
  if (!existsSync(ogPath)) return {};
  const source = readFileSync(ogPath, 'utf-8');
  const { code } = await transformWithEsbuild(source, ogPath, {
    jsx: 'transform',
    jsxFactory: '__ogJsx',
    jsxFragment: '__ogJsxFragment',
    format: 'esm',
  });
  installOgJsxGlobals();
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as {
    default: ComponentType;
    ogColors?: Partial<OgColors>;
  };
  return { preview: createElement(mod.default), colors: mod.ogColors };
}

// カード 1 枚を satori に渡す形にする。アイコンはトップページにだけ添える
async function ogMetaFor(card: OgCard) {
  const { preview, colors } = await loadOgModule(card.name);
  return {
    ...card,
    preview,
    colors,
    iconSrc: card.name === 'index' ? siteIconDataUrl() : undefined,
  };
}

// ctx.path ("/usuppera/index.html" や "/index.html") を discoverOgCards() の name に対応させる
function ogCardNameFromPath(path: string): string | null {
  if (path === '/index.html') return 'index';
  const m = path.match(/^\/([^/]+)\/index\.html$/);
  return m?.[1] ?? null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// OGP 画像 (satori + resvg で PNG 化) の生成と meta 注入を行う
// - dev: /og/<dir>.png へのリクエストを都度レンダリングして返す（キャッシュしない。調整中の即時反映を優先）
// - build: 全ツール + トップページ分の PNG を dist/og/ に emit する
// - 全エントリの <head> に og:image 等の meta タグを注入する
function ogPlugin(): Plugin {
  return {
    name: 'og',
    resolveId(id) {
      if (id === 'virtual:og-cards') return '\0virtual:og-cards';
      return undefined;
    },
    load(id) {
      if (id !== '\0virtual:og-cards') return undefined;
      return `export const ogCards = ${JSON.stringify(discoverOgCards())};`;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/og\/([^/]+)\.png$/);
        if (!match) return next();
        const card = discoverOgCards().find((c) => c.name === match[1]);
        if (!card) return next();
        res.setHeader('Content-Type', 'image/png');
        res.end(await renderOgPng(await ogMetaFor(card)));
      });
    },
    async generateBundle() {
      await Promise.all(
        discoverOgCards().map(async (card) => {
          this.emitFile({
            type: 'asset',
            fileName: `og/${card.name}.png`,
            source: await renderOgPng(await ogMetaFor(card)),
          });
        }),
      );
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const name = ogCardNameFromPath(ctx.path);
        const card = name ? discoverOgCards().find((c) => c.name === name) : undefined;
        if (!card) return html;
        const url = card.name === 'index' ? SITE_URL : `${SITE_URL}/${card.name}/`;
        const tags = [
          `<meta property="og:title" content="${escapeHtml(card.title)}">`,
          `<meta property="og:description" content="${escapeHtml(card.description)}">`,
          `<meta property="og:type" content="website">`,
          `<meta property="og:url" content="${url}">`,
          `<meta property="og:image" content="${SITE_URL}/og/${card.name}.png">`,
          `<meta property="og:image:width" content="1200">`,
          `<meta property="og:image:height" content="630">`,
          `<meta name="twitter:card" content="summary_large_image">`,
        ].join('\n');
        return html.replace(/(<\/head>)/, `${tags}\n$1`);
      },
    },
  };
}

export default defineConfig({
  root: 'src',
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  plugins: [
    faviconPlugin(),
    headerPlugin(),
    toolListPlugin(),
    ogPlugin(),
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: discoverHtmlEntries(),
    },
  },
});
