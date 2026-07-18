import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

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

export default defineConfig({
  root: 'src',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: discoverHtmlEntries(),
    },
  },
});
