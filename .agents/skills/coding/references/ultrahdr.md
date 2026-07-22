# UltraHDR JPEG

- 生成した UltraHDR JPEG は自前の MPF/XMP パーサだけで完結させず、macOS ImageIO の `CGImageSourceCopyAuxiliaryDataInfoAtIndex` に `kCGImageAuxiliaryDataTypeISOGainMap` を渡して非 `nil` になることを正規サンプルと比較し、第三者デコーダが gain map として認識することまで検証する。
