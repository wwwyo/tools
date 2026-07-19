# Vite build

- `vite.config.ts` の plugin から `src/<appdir>/og.tsx` を動的に読むときは、Bun の直接 `import()` が dev で成功しても build では Node の ESM loader 上で失敗するため、`transformWithEsbuild` で classic JSX に変換して `data:` URL から import し、`og.tsx` 内では外部 import を使わない。

