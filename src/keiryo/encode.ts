/**
 * 縮小・再エンコードと、動作確認用サンプル画像の生成。
 * 決定論的な処理は全てページ内 Canvas で完結し、画像を外部へは送らない。
 */

/** このツールが出力形式として提供するもの。PNG は非可逆圧縮の設定項目（品質）が意味を持たないため対象外 */
export type OutputFormat = "jpeg" | "webp";

const FORMAT_MIME: Record<OutputFormat, string> = {
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const FORMAT_EXT: Record<OutputFormat, string> = {
  jpeg: "jpg",
  webp: "webp",
};

export function extensionFor(format: OutputFormat): string {
  return FORMAT_EXT[format];
}

/** 再エンコード結果。fellBack は WebP 非対応ブラウザで JPEG へ自動的に切り替わったことを示す */
export interface EncodeResult {
  blob: Blob;
  width: number;
  height: number;
  format: OutputFormat;
  fellBack: boolean;
}

/** 長辺の上限（px）から出力寸法を求める。cap が null、または画像が既に cap 以下ならアップスケールせず原寸を返す */
export function computeTargetDims(
  naturalWidth: number,
  naturalHeight: number,
  longEdgeCap: number | null,
): { width: number; height: number } {
  if (!longEdgeCap) return { width: naturalWidth, height: naturalHeight };
  const longEdge = Math.max(naturalWidth, naturalHeight);
  if (longEdge <= longEdgeCap) return { width: naturalWidth, height: naturalHeight };
  const scale = longEdgeCap / longEdge;
  return { width: Math.round(naturalWidth * scale), height: Math.round(naturalHeight * scale) };
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

/**
 * 画像を指定の長辺上限まで縮小し、指定形式・品質で再エンコードする。
 * WebP を要求してもブラウザが対応していないと toBlob は無言で PNG 等を返すことがあるため、
 * 返ってきた blob.type を確認し、期待外なら JPEG で撮り直して fellBack を立てる。
 */
export async function encodeImage(
  img: HTMLImageElement,
  opts: { format: OutputFormat; quality: number; longEdgeCap: number | null },
): Promise<EncodeResult> {
  const dims = computeTargetDims(img.naturalWidth, img.naturalHeight, opts.longEdgeCap);
  const canvas = document.createElement("canvas");
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context を取得できませんでした");
  ctx.drawImage(img, 0, 0, dims.width, dims.height);

  const mime = FORMAT_MIME[opts.format];
  const blob = await canvasToBlob(canvas, mime, opts.quality);
  if (!blob) throw new Error("エンコードに失敗しました");

  if (opts.format === "webp" && blob.type !== "image/webp") {
    const jpegBlob = await canvasToBlob(canvas, "image/jpeg", opts.quality);
    if (!jpegBlob) throw new Error("エンコードに失敗しました");
    return { blob: jpegBlob, width: dims.width, height: dims.height, format: "jpeg", fellBack: true };
  }

  return { blob, width: dims.width, height: dims.height, format: opts.format, fellBack: false };
}

/**
 * 動作確認用のサンプル画像（夕焼けの風景）をその場で生成する。
 * ノイズや雲の粒をランダム生成しているのは、実写に近い「グラデーションだけではない」データを
 * 圧縮させて縮小・品質ラダーの効果差が体感できるようにするため。
 */
export function generateSampleFile(): Promise<File> {
  return new Promise((resolve, reject) => {
    const w = 1600;
    const h = 1067;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("canvas 2d context を取得できませんでした"));
      return;
    }

    const horizon = h * 0.55;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, "#9fc6e8");
    sky.addColorStop(0.6, "#cfe6f2");
    sky.addColorStop(1, "#f2ead3");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);

    const ground = ctx.createLinearGradient(0, horizon, 0, h);
    ground.addColorStop(0, "#7f9a5a");
    ground.addColorStop(1, "#4d6636");
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, w, h - horizon);

    ctx.fillStyle = "rgba(255, 245, 200, 0.9)";
    ctx.beginPath();
    ctx.arc(w * 0.78, horizon * 0.35, 70, 0, Math.PI * 2);
    ctx.fill();

    for (let c = 0; c < 14; c++) {
      const cx = Math.random() * w;
      const cy = Math.random() * horizon * 0.7;
      const rx = 60 + Math.random() * 140;
      const ry = 14 + Math.random() * 24;
      ctx.fillStyle = `rgba(255,255,255,${(0.25 + Math.random() * 0.35).toFixed(2)})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let t = 0; t < 40; t++) {
      const tx = Math.random() * w;
      const ty = horizon - Math.random() * 20;
      const tr = 6 + Math.random() * 18;
      ctx.fillStyle = `rgba(50, 70, 40, ${(0.4 + Math.random() * 0.4).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(tx, ty, tr, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let g = 0; g < 60; g++) {
      const gx = Math.random() * w;
      const gy = horizon + Math.random() * (h - horizon);
      const gr = 3 + Math.random() * 10;
      ctx.fillStyle = `rgba(0,0,0,${(0.03 + Math.random() * 0.06).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(gx, gy, gr, 0, Math.PI * 2);
      ctx.fill();
    }

    // ピクセル単位のノイズで写真らしい粒状感を足す
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let p = 0; p < d.length; p += 4) {
      if (Math.random() < 0.15) {
        const n = (Math.random() - 0.5) * 18;
        d[p] = Math.min(255, Math.max(0, (d[p] ?? 0) + n));
        d[p + 1] = Math.min(255, Math.max(0, (d[p + 1] ?? 0) + n));
        d[p + 2] = Math.min(255, Math.max(0, (d[p + 2] ?? 0) + n));
      }
    }
    ctx.putImageData(imgData, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("サンプル画像の生成に失敗しました"));
        return;
      }
      resolve(new File([blob], "sample-photo.jpg", { type: "image/jpeg", lastModified: Date.now() }));
    }, "image/jpeg", 0.92);
  });
}
