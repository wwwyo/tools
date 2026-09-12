# Vite build

- `vite.config.ts` の plugin から `src/<appdir>/og.tsx` を動的に読むときは、Bun の直接 `import()` が dev で成功しても build では Node の ESM loader 上で失敗するため、`transformWithEsbuild` で classic JSX に変換して `data:` URL から import し、`og.tsx` 内では外部 import を使わない。
- `new URL("./foo.worker.ts", import.meta.url)` で作る module worker の中で動的 `import()` を書くと、`worker.format` の既定値 `'iife'` ではチャンク分割できず build が落ちる（`worker: { format: 'es' }` が要る）。ライブラリ自身が内部で動的 import する分（`@jsquash/avif` がコーデックの JS を `import()` で読む等）は `iife` でもそのまま build できるので、自分のコード側を静的 import にしておけば `worker.format` を触らずに済む。

