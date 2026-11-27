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

// 正距円筒上に、球面で丸く見えるクレーターを描く（高緯度ほど横に引き伸ばす）
function drawCraters(color: CanvasRenderingContext2D, height: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const rand = mulberry32(seed);
  const count = 900;
  for (let i = 0; i < count; i++) {
    // 小さいクレーターほど多い
    const r = Math.pow(rand(), 3.2) * 34 + 1.5;
    const lat = Math.asin(rand() * 2 - 1);
    const cx = rand() * w;
    const cy = (0.5 - lat / Math.PI) * h;
    const stretch = 1 / Math.max(Math.cos(lat), 0.15);
    for (const dx of [0, -w, w]) {
      for (const [ctx, floor, rim] of [
        [color, 'rgba(40,44,52,0.28)', 'rgba(235,240,250,0.22)'],
        [height, 'rgba(0,0,0,0.55)', 'rgba(255,255,255,0.45)'],
      ] as const) {
        ctx.save();
        ctx.translate(cx + dx, cy);
        ctx.scale(stretch, 1);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = floor;
        ctx.fill();
        ctx.lineWidth = Math.max(1, r * 0.22);
        ctx.strokeStyle = rim;
        ctx.stroke();
        ctx.restore();
      }
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
    const dark = maria > 0.52 ? Math.min((maria - 0.52) * 4, 0.45) : 0;
    const v = 0.62 + (grain - 0.5) * 0.35 - dark;
    return [Math.round(v * 205), Math.round(v * 214), Math.round(v * 232)];
  });
  const bump = paintSphere(width, h, (x, y, z) => {
    const v = fbm(x * 7, y * 7, z * 7, 5, seed + 9);
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

// 字幕を VR 空間に置くための canvas。文字は折り返して最大 3 行
export function drawCaption(canvas: HTMLCanvasElement, chapter: string, text: string) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (!text) return;
  ctx.fillStyle = 'rgba(6, 8, 14, 0.72)';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, 24);
  ctx.fill();
  ctx.fillStyle = '#9fb6d9';
  ctx.font = '28px sans-serif';
  ctx.fillText(chapter, 32, 48);
  ctx.fillStyle = '#eef2f8';
  ctx.font = '40px serif';
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > width - 64) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, 32, 108 + i * 54));
}
