/** 抽出色（ColorResult）を表示用の文字列表記へ変換するロジック */

import type { ColorResult } from "./colorQuantize";

export type ColorFormat = "hex" | "rgb" | "cmyk";

type Cmyk = {
  c: number; // 0-100
  m: number; // 0-100
  y: number; // 0-100
  k: number; // 0-100
};

/** 標準的な RGB→CMYK 単純変換（減法混色近似）。整数%に丸める */
function rgbToCmyk(r: number, g: number, b: number): Cmyk {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const k = 1 - Math.max(rNorm, gNorm, bNorm);

  if (k >= 1) {
    return { c: 0, m: 0, y: 0, k: 100 };
  }

  const c = (1 - rNorm - k) / (1 - k);
  const m = (1 - gNorm - k) / (1 - k);
  const y = (1 - bNorm - k) / (1 - k);

  return {
    c: Math.round(c * 100),
    m: Math.round(m * 100),
    y: Math.round(y * 100),
    k: Math.round(k * 100),
  };
}

/** 選択中の表記（hex / rgb / cmyk）で色コード文字列を組み立てる */
export function formatColor(color: ColorResult, format: ColorFormat): string {
  switch (format) {
    case "hex":
      return color.hex;
    case "rgb":
      return `rgb(${color.r}, ${color.g}, ${color.b})`;
    case "cmyk": {
      const { c, m, y, k } = rgbToCmyk(color.r, color.g, color.b);
      return `cmyk(${c}%, ${m}%, ${y}%, ${k}%)`;
    }
    default:
      return format satisfies never;
  }
}
