# Vite build

- `vite.config.ts` の plugin から `src/<appdir>/og.tsx` を動的に読むときは、Bun の直接 `import()` が dev で成功しても build では Node の ESM loader 上で失敗するため、`transformWithEsbuild` で classic JSX に変換して `data:` URL から import し、`og.tsx` 内では外部 import を使わない。
- `new URL("./foo.worker.ts", import.meta.url)` で作る module worker が内部でさらに動的 `import()`（wasm を積むライブラリなど、`@jsquash/avif` がその例）を行う場合、`worker.format` の既定値 `'iife'` では動的 import をチャンク分割できず、そのライブラリが `new URL('*.wasm', import.meta.url)` で自身の wasm を相対解決する箇所が壊れる（`optimizeDeps.exclude` で回避している dev の pre-bundle 問題と同根で、import.meta.url が意図しない場所を指してしまう）。`vite.config.ts` のトップレベル `worker: { format: 'es' }` にすると worker が ES module としてビルドされ、import.meta.url が保たれる。

