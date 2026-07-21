# WebGPU HDR

- SDR / HDR の比較では SDR 側を `bgra8unorm`、HDR 側を `rgba16float` + `toneMapping.mode: "extended"` にし、`rgba16float` + `"standard"` のコンポジタ依存ではなくレンダーターゲット書き込み時に SDR 側の 1.0 超を確実にクランプする。
- `colorSpace: "srgb"` の canvas では raw `bgra8unorm` と `rgba16float` は 0.5 を同じ nonlinear sRGB コード値 128 として表示し、`bgra8unorm-srgb` view は 188 になるため、両者を揃える目的で `-srgb` view を使わない。
- `rgba16float` + `colorSpace: "srgb"` の 1.0 超は extended sRGB のコード値であって線形輝度倍率ではないため、UI で「輝度倍率」と説明するなら出力前に extended sRGB OETF を適用する。
- canvas の色変換を切り分けるときはシェーダから一律 0.5 を出力し、2D canvas へ `drawImage` して 128（nonlinear sRGB）か 188（linear 0.5 の sRGB 符号化）かを実測する。
