/** 画像のピクセルを量子化して面積比の大きい代表色を抽出するロジック */

export type ColorResult = {
  hex: string;
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
  ratio: number; // 0-100
};

const ALPHA_THRESHOLD = 128;
/** RGB 各チャンネルを何段階にバケット化するか（値が大きいほど粗い量子化） */
const BUCKET_STEP = 24;
/** 知覚的に近い色とみなして統合する RGB ユークリッド距離のしきい値 */
const MERGE_DISTANCE = 32;

type Bucket = {
  rSum: number;
  gSum: number;
  bSum: number;
  count: number;
};

function toHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

/**
 * ImageData から量子化バケット単位の色ヒストグラムを作る。
 * 各チャンネルを BUCKET_STEP 段階でバケット化し、バケット内の平均色を代表色とする。
 */
function buildBuckets(imageData: ImageData): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  const { data } = imageData;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (r === undefined || g === undefined || b === undefined || a === undefined) continue;
    if (a < ALPHA_THRESHOLD) continue;

    const br = Math.floor(r / BUCKET_STEP);
    const bg = Math.floor(g / BUCKET_STEP);
    const bb = Math.floor(b / BUCKET_STEP);
    const key = `${br}-${bg}-${bb}`;

    const existing = buckets.get(key);
    if (existing) {
      existing.rSum += r;
      existing.gSum += g;
      existing.bSum += b;
      existing.count += 1;
    } else {
      buckets.set(key, { rSum: r, gSum: g, bSum: b, count: 1 });
    }
  }

  return buckets;
}

function distance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * バケット群から面積比 top N の代表色を抽出する。
 * 頻度降順に走査しつつ、知覚的に近い色は既存クラスタへ統合（面積を加算）する。
 */
export function extractTopColors(imageData: ImageData, topN = 5): ColorResult[] {
  const buckets = buildBuckets(imageData);
  const sorted = [...buckets.values()]
    .map((bucket) => ({
      r: bucket.rSum / bucket.count,
      g: bucket.gSum / bucket.count,
      b: bucket.bSum / bucket.count,
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const totalCount = sorted.reduce((sum, entry) => sum + entry.count, 0);
  if (totalCount === 0) return [];

  const clusters: { r: number; g: number; b: number; count: number }[] = [];

  for (const entry of sorted) {
    const near = clusters.find((cluster) => distance(cluster, entry) < MERGE_DISTANCE);
    if (near) {
      near.count += entry.count;
    } else {
      clusters.push({ ...entry });
    }
  }

  return clusters
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((cluster) => ({
      hex: `#${toHex(cluster.r)}${toHex(cluster.g)}${toHex(cluster.b)}`.toUpperCase(),
      r: Math.max(0, Math.min(255, Math.round(cluster.r))),
      g: Math.max(0, Math.min(255, Math.round(cluster.g))),
      b: Math.max(0, Math.min(255, Math.round(cluster.b))),
      ratio: (cluster.count / totalCount) * 100,
    }));
}

/** 画像を長辺 maxSize px に縮小して描画した Canvas から ImageData を取得する */
export function getResizedImageData(image: HTMLImageElement, maxSize = 200): ImageData {
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D context を取得できませんでした");
  }
  ctx.drawImage(image, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
