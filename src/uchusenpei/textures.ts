// 月と地球の表面をページ内で手続き生成する（外部の画像に依存しない）。
// 正距円筒（equirectangular）の canvas に描き、球にそのまま貼る。
// 継ぎ目が出ないよう、ノイズは緯度経度ではなく球面上の 3D 座標で引く。

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

function fbm(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, z * freq, seed + i * 17);
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

type PixelFn = (x: number, y: number, z: number, lat: number) => [number, number, number];

function paintSphere(width: number, height: number, fn: PixelFn): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas が使えません');
  const image = ctx.createImageData(width, height);
  for (let py = 0; py < height; py++) {
    const lat = Math.PI / 2 - ((py + 0.5) / height) * Math.PI;
    const cosLat = Math.cos(lat);
    const y = Math.sin(lat);
    for (let px = 0; px < width; px++) {
      const lon = ((px + 0.5) / width) * Math.PI * 2;
      const [r, g, b] = fn(cosLat * Math.cos(lon), y, cosLat * Math.sin(lon), lat);
      const i = (py * width + px) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// 正距円筒上に、球面で丸く見えるクレーターを描く（高緯度ほど横に引き伸ばす）。
// 起伏は高さの図（bump）にだけ描き、お椀形（底が低く、ふちが盛り上がる）にする。影は光の向きから three.js が付ける。
// 色の図には、新しいクレーターのまわりの明るい筋（光条）だけを少し描く
function drawCraters(color: CanvasRenderingContext2D, height: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const rand = mulberry32(seed);
  const count = 1400;
  const stamp = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, stretch: number, stops: [number, string][]) => {
    for (const dx of [0, -w, w]) {
      ctx.save();
      ctx.translate(cx + dx, cy);
      ctx.scale(stretch, 1);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      for (const [at, c] of stops) g.addColorStop(at, c);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };
  for (let i = 0; i < count; i++) {
    // 小さいクレーターほど多い
    const r = Math.pow(rand(), 3.4) * 40 + 1.2;
    const lat = Math.asin(rand() * 2 - 1);
    const cx = rand() * w;
    const cy = (0.5 - lat / Math.PI) * h;
    const stretch = 1 / Math.max(Math.cos(lat), 0.15);
    const depth = 0.35 + rand() * 0.3;
    stamp(height, cx, cy, r * 1.25, stretch, [
      [0, `rgba(0,0,0,${depth})`],
      [0.55, `rgba(0,0,0,${depth * 0.6})`],
      [0.75, `rgba(255,255,255,${depth * 0.5})`],
      [0.85, 'rgba(255,255,255,0)'],
    ]);
    // 大きめのクレーターの一部は新しく、まわりが明るい
    if (r > 6 && rand() < 0.12) {
      stamp(color, cx, cy, r * 4, stretch, [
        [0, 'rgba(240,246,255,0.32)'],
        [0.3, 'rgba(240,246,255,0.12)'],
        [1, 'rgba(240,246,255,0)'],
      ]);
    }
  }
}

export type MoonTextures = { color: HTMLCanvasElement; bump: HTMLCanvasElement };

export function makeMoonTextures(width = 1024): MoonTextures {
  const h = width / 2;
  const seed = 41;
  // 月面は青白く（本文「月面は青白く輝き」）。海（暗い平原）は大きな低周波ノイズで作る
  const color = paintSphere(width, h, (x, y, z) => {
    const maria = fbm(x * 1.6 + 3, y * 1.6, z * 1.6, 3, seed);
    const grain = fbm(x * 9, y * 9, z * 9, 4, seed + 5);
    const dark = maria > 0.5 ? Math.min((maria - 0.5) * 3.5, 0.38) : 0;
    const v = 0.66 + (grain - 0.5) * 0.28 - dark;
    return [Math.round(v * 205), Math.round(v * 214), Math.round(v * 232)];
  });
  // 海は平らに、高地はでこぼこに
  const bump = paintSphere(width, h, (x, y, z) => {
    const maria = fbm(x * 1.6 + 3, y * 1.6, z * 1.6, 3, seed);
    const rough = maria > 0.5 ? 0.35 : 1;
    const v = 0.5 + (fbm(x * 7, y * 7, z * 7, 5, seed + 9) - 0.5) * rough;
    const c = Math.round(v * 255);
    return [c, c, c];
  });
  const colorCtx = color.getContext('2d');
  const bumpCtx = bump.getContext('2d');
  if (colorCtx && bumpCtx) drawCraters(colorCtx, bumpCtx, width, h, seed);
  return { color, bump };
}

export function makeEarthTexture(width = 512): HTMLCanvasElement {
  const seed = 97;
  return paintSphere(width, width / 2, (x, y, z, lat) => {
    const land = fbm(x * 2.2, y * 2.2, z * 2.2, 5, seed);
    const cloud = fbm(x * 4 + 9, y * 6, z * 4, 4, seed + 3);
    const polar = Math.abs(lat) > 1.25;
    let rgb: [number, number, number];
    if (polar) rgb = [235, 240, 245];
    else if (land > 0.53) rgb = land > 0.6 ? [139, 120, 86] : [70, 110, 62];
    else rgb = [22, 58, 120];
    const c = Math.max(0, (cloud - 0.5) * 2.6);
    return [lerp(rgb[0], 250, c), lerp(rgb[1], 250, c), lerp(rgb[2], 252, c)].map((n) =>
      Math.round(Math.min(255, n)),
    ) as [number, number, number];
  });
}

// 字幕を VR 空間に置くための canvas。箱は敷かず、大きな明朝を影で浮かせる。中央揃えで最大 3 行
export function drawCaption(canvas: HTMLCanvasElement, chapter: string, text: string) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (!text) return;
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#9fb6d9';
  ctx.font = '28px "Sawarabi Gothic", sans-serif';
  ctx.fillText(chapter.split('').join(' '), width / 2, 44);
  ctx.fillStyle = '#f4f7fc';
  ctx.font = '60px "Sawarabi Mincho", serif';
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > width - 120) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  // 影を二度重ねて、星の上でも読めるようにする
  for (let pass = 0; pass < 2; pass++) lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, width / 2, 130 + i * 92));
}
