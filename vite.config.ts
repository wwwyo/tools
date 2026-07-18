import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-discover HTML entry points in src/
function discoverHtmlEntries(): Record<string, string> {
  const srcDir = join(__dirname, 'src');
  const htmlFiles = readdirSync(srcDir).filter(file => file.endsWith('.html'));

  const input: Record<string, string> = {};
  for (const file of htmlFiles) {
    const name = file.replace('.html', '');
    input[name] = join(srcDir, file);
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
