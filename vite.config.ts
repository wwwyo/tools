import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    if (!entry.isDirectory()) continue;
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
        const injected =
          ctx.path === '/index.html'
            ? header.replace(
                /(<a[^>]*data-header-title[^>]*>.*?<\/a>)/s,
                '<h1 class="m-0">$1</h1>',
              )
            : header;
        return html.replace(/(<body[^>]*>)/, `$1\n${injected}`);
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
        const tools = discoverTools();
        const items = tools
          .map(
            (tool, i) => `  <li class="border-b border-b-[rgba(31,27,22,0.16)]">
    <a class="group block px-1 py-[30px] text-inherit no-underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]" href="/${tool.dir}/">
      <span class="mb-1.5 block font-mono text-xs tracking-[0.08em] text-primary">${toolListNumber(i)}</span>
      <span class="font-serif text-xl font-bold text-foreground">${tool.title}</span>
      <p class="mt-1.5 mb-0 text-sm text-muted-foreground">${tool.description}</p>
    </a>
  </li>`,
          )
          .join('\n');
        return html.replace('<!-- TOOL_LIST -->', items);
      },
    },
  };
}

export default defineConfig({
  root: 'src',
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  plugins: [headerPlugin(), toolListPlugin(), react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: discoverHtmlEntries(),
    },
  },
});
