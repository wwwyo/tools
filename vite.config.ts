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
    <a class="group block px-1 py-[22px] text-inherit no-underline focus-visible:outline-2 focus-visible:outline-red focus-visible:outline-offset-[-2px]" href="/${tool.dir}/">
      <span class="mb-1.5 block font-mono text-[0.72rem] tracking-[0.08em] text-red">${toolListNumber(i)}</span>
      <span class="font-mincho text-[1.3rem] font-bold text-ink border-b border-b-transparent transition-[border-color] duration-150 [transition-timing-function:ease] group-hover:border-b-red group-focus-visible:border-b-red">${tool.title}</span>
      <p class="mt-1.5 mb-0 text-[0.85rem] text-muted">${tool.description}</p>
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
  plugins: [toolListPlugin(), react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: discoverHtmlEntries(),
    },
  },
});
