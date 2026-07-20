import "../global.css";
import "./styles.css";
import { formatColor, type ColorFormat } from "./colorFormat";
import { extractTopColors, getResizedImageData, type ColorResult } from "./colorQuantize";

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("app element not found");
}

appEl.innerHTML = `
  <svg width="0" height="0" class="absolute" aria-hidden="true" focusable="false">
    <!-- 滴ごとに feTurbulence の seed を変えるため、filter は renderBlobs() が動的生成して詰める。
         SVG フィルタの既定は linearRGB で、通すと色が眠くなるため sRGB は各 filter 側で固定する -->
    <defs id="ink-filter-defs"></defs>
  </svg>

  <div id="blob-layer" class="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true"></div>
  <div class="pointer-events-none fixed inset-0 z-10 bg-white/50" aria-hidden="true"></div>

  <main class="relative z-20 mx-auto flex max-w-xl flex-col px-5 py-10">
    <div class="flex flex-col gap-6">
      <header class="flex flex-col gap-1.5">
        <h1 class="font-serif text-2xl font-bold">五滴</h1>
        <p class="text-sm text-muted-foreground">画像を貼り付けると、使用色の面積比 Top 5 を五滴抽出します。</p>
      </header>

      <div
        id="dropzone"
        tabindex="0"
        class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded border border-dashed border-border px-4 py-10 text-center transition-colors focus-visible:outline-2 focus-visible:outline-ring"
      >
        <p class="text-sm text-foreground">
          ここに画像をドラッグ&ドロップ / クリックで選択 / <kbd class="rounded border border-border bg-muted px-1 py-0.5 text-xs">Cmd+V</kbd> で貼り付け
        </p>
        <p class="text-xs text-muted-foreground">Canvas 上で解析するのみで、画像は外部に送信されません</p>
      </div>
      <div class="-mt-4 flex justify-end">
        <button
          type="button"
          id="sample-button"
          class="rounded border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >サンプル画像で試す</button>
      </div>
      <input id="file-input" type="file" accept="image/*" class="hidden" />

      <p id="error" class="hidden text-sm text-destructive" role="alert"></p>

      <section id="preview-section" class="hidden flex-col gap-2">
        <h2 class="text-sm font-bold text-muted-foreground">プレビュー</h2>
        <img id="preview-image" alt="貼り付けた画像のプレビュー" class="max-h-64 w-auto rounded border border-border object-contain" />
      </section>

      <section id="result-section" class="hidden flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-bold text-muted-foreground">使用色 Top 5（面積比順）</h2>
          <div class="flex items-center gap-2">
            <div
              id="format-toggle"
              role="group"
              aria-label="カラーコード表記切り替え"
              class="flex overflow-hidden rounded border border-border text-xs"
            >
              <button type="button" data-format="hex" class="format-toggle-btn px-2 py-1 transition-colors">HEX</button>
              <button type="button" data-format="rgb" class="format-toggle-btn border-l border-border px-2 py-1 transition-colors">RGB</button>
              <button type="button" data-format="cmyk" class="format-toggle-btn border-l border-border px-2 py-1 transition-colors">CMYK</button>
            </div>
            <button
              type="button"
              id="copy-all-button"
              class="shrink-0 rounded border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >一括copy</button>
          </div>
        </div>
        <ul id="color-list" class="flex flex-col gap-2"></ul>
      </section>
    </div>
  </main>
`;

const blobLayerEl = document.getElementById("blob-layer") as HTMLDivElement;
const inkFilterDefsEl = document.getElementById("ink-filter-defs") as unknown as SVGDefsElement;
const dropzoneEl = document.getElementById("dropzone") as HTMLDivElement;
const sampleButtonEl = document.getElementById("sample-button") as HTMLButtonElement;
const fileInputEl = document.getElementById("file-input") as HTMLInputElement;
const errorEl = document.getElementById("error") as HTMLParagraphElement;
const previewSectionEl = document.getElementById("preview-section") as HTMLElement;
const previewImageEl = document.getElementById("preview-image") as HTMLImageElement;
const resultSectionEl = document.getElementById("result-section") as HTMLElement;
const colorListEl = document.getElementById("color-list") as HTMLUListElement;
const formatToggleEl = document.getElementById("format-toggle") as HTMLDivElement;
const copyAllButtonEl = document.getElementById("copy-all-button") as HTMLButtonElement;

let currentFormat: ColorFormat = "hex";
let currentColors: ColorResult[] = [];

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError(): void {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

/** clipboard API が使えない環境（権限なし等）では textarea + execCommand にフォールバックする */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }
}

/** Fisher-Yates で配列をシャッフルした新しい配列を返す */
function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = temp;
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 配列の中央値を返す */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
  return sorted[mid] as number;
}

/** 紙の繊維角に対する滴ごとの局所的なブレ幅（度） */
const FIBER_ANGLE_JITTER_DEG = 7;

/**
 * Washburn 曲線（sqrt カーブ）を近似する keyframe オフセット。
 * sqrt(p) が 0.2 刻みで等間隔になるよう選んでおり、曲率の大きい序盤ほどサンプルが密になる。
 */
const WASHBURN_SAMPLE_OFFSETS = [0.04, 0.16, 0.36, 0.64, 1] as const;

/**
 * Washburn 則 r^2 = r0^2 + Kt に沿って、進捗 progress（0〜1）における半径を返す。
 * 毛細管浸透は距離が時間の平方根に比例するため、序盤は速く、後半は緩やかになる。
 */
function washburnRadius(progress: number, initialRadius: number, finalRadius: number): number {
  return Math.sqrt(initialRadius ** 2 + (finalRadius ** 2 - initialRadius ** 2) * progress);
}

/** 濡れ前線（--ink-front）の初期半径（%）。着弾直後にごく小さく既に濡れている状態を表す */
const FRONT_INITIAL_PERCENT_RANGE: readonly [number, number] = [9, 15];
/** --ink-front の最終値。closest-side ellipse の縁いっぱいまで広がる */
const FRONT_FINAL_PERCENT = 100;

/** コア（--ink-core）の初期半径（%） */
const CORE_INITIAL_PERCENT = 8;
/** コアの最終半径（%）の範囲。前線よりずっと小さい位置で頭打ちになる */
const CORE_FINAL_PERCENT_RANGE: readonly [number, number] = [32, 38];
/**
 * コアが実質的に拡大をやめる Washburn 進捗。この値で progress 軸を圧縮してから
 * washburnRadius に渡すことで、washburnRadius 自体は変更せず
 * 「序盤で速く立ち上がり、以降ほぼ横ばい」という前線とは異なる頭打ち挙動を作る。
 */
const CORE_SATURATION_PROGRESS = 0.3;

/**
 * 縁の alpha（--ink-edge-alpha）。着弾直後はやや高く、広がりきると同じ顔料がより広い面積を覆うため薄くなる。
 * 薄くしすぎると濡れ前線の境界が消えて水彩・霧のようになるため、終端は 0.4 で止めている
 */
const EDGE_ALPHA_START = 0.62;
const EDGE_ALPHA_END = 0.4;

/** グラデーション中間 stop の alpha。前線・コアの進み方に関わらず固定（アニメーションしない） */
const MID_STOP_ALPHA = 0.72;

/** progress における --ink-core の目標値（%）。CORE_SATURATION_PROGRESS 以降は finalCorePercent で頭打ち */
function coreRadiusAt(progress: number, finalCorePercent: number): number {
  const saturatedProgress = Math.min(1, progress / CORE_SATURATION_PROGRESS);
  return washburnRadius(saturatedProgress, CORE_INITIAL_PERCENT, finalCorePercent);
}

/**
 * progress における --ink-edge-alpha の目標値。washburnRadius(progress, 0, 1) は sqrt(progress) と
 * 等価な 0→1 の正規化カーブで、前線が広がるのと同じ速度で縁の alpha を減衰させるために流用する。
 */
function edgeAlphaAt(progress: number): number {
  return EDGE_ALPHA_START + (EDGE_ALPHA_END - EDGE_ALPHA_START) * washburnRadius(progress, 0, 1);
}

/**
 * 五滴の到着タイミングを burst 状に生成する（先頭は 0）。
 * 70% の確率で 35〜150ms の短い間隔（連続着弾）、30% の確率で 280〜620ms の長い間隔を積み上げ、
 * index * 160ms の等間隔で機械的に見えていた着弾リズムを崩す。
 */
function generateBurstDelays(count: number): number[] {
  const delays = [0];
  for (let i = 1; i < count; i++) {
    const gap = Math.random() < 0.7 ? randomBetween(35, 150) : randomBetween(280, 620);
    delays.push((delays[i - 1] as number) + gap);
  }
  return delays;
}

/**
 * 単一要素の --ink-front / --ink-core / --ink-edge-alpha / opacity を Washburn 曲線の
 * サンプル点から1本の keyframes にまとめて生成する。4つを animate() で分けず1本にまとめるのは、
 * 同一要素上に複数の Animation が並走してタイミングがずれたり再計算が増えたりするのを避けるため。
 * offset 0〜0.04 は物理時間そのものではなく、着弾の立ち上がりを知覚的に圧縮した演出。
 * TypeScript の Keyframe 型はインデックスシグネチャ `[property: string]: string | number | ...`
 * を持つため、`"--ink-front"` のようなカスタムプロパティキーもそのまま型が通る。
 */
function buildInkKeyframes(
  initialFrontPercent: number,
  finalCorePercent: number,
  opacity: number,
): Keyframe[] {
  const keyframes: Keyframe[] = [
    {
      offset: 0,
      opacity: 0,
      "--ink-front": `${initialFrontPercent}%`,
      "--ink-core": `${CORE_INITIAL_PERCENT}%`,
      "--ink-edge-alpha": String(EDGE_ALPHA_START),
    },
  ];
  for (const p of WASHBURN_SAMPLE_OFFSETS) {
    keyframes.push({
      offset: p,
      opacity,
      "--ink-front": `${washburnRadius(p, initialFrontPercent, FRONT_FINAL_PERCENT)}%`,
      "--ink-core": `${coreRadiusAt(p, finalCorePercent)}%`,
      "--ink-edge-alpha": String(edgeAlphaAt(p)),
    });
  }
  return keyframes;
}

let inkFilterIdCounter = 0;

/** 層の直径に対する displacement 量の比。合計 (COARSE + FINE) / 2 が縁の最大変位率になる */
const COARSE_DISPLACE_RATIO = 0.3;
const FINE_DISPLACE_RATIO = 0.07;

/**
 * 滴1つ分の、seed の異なる SVG filter を defs へ追加し、id を返す（1滴 = 1 filter）。
 * baseFrequency は軸別指定にして紙の繊維方向の異方性を出す（1段目=大きなうねり、2段目=縁の毛羽立ち）。
 *
 * displacement の scale は px 固定にせず要素の直径 layerSize に比例させる。固定値だと、
 * 小さい滴では変位が直径に対して過大になって形が崩れ、大きい滴ではほとんど滲まないため。
 * filter 領域の余白は各辺 25% で、最大変位率 (0.3 + 0.07) / 2 = 18.5% を上回るので縁が矩形に切れない。
 * color-interpolation-filters を外すと色が眠くなるため必ず sRGB を指定する。
 */
function appendInkFilter(defsEl: SVGDefsElement, layerSize: number): string {
  const id = `ink-bleed-${inkFilterIdCounter++}`;
  const coarseSeed = Math.floor(Math.random() * 1000);
  const fineSeed = Math.floor(Math.random() * 1000);
  const coarseScale = layerSize * COARSE_DISPLACE_RATIO;
  const fineScale = layerSize * FINE_DISPLACE_RATIO;
  defsEl.insertAdjacentHTML(
    "beforeend",
    `<filter id="${id}" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.010 0.026" numOctaves="3" seed="${coarseSeed}" result="coarse" />
      <feDisplacementMap in="SourceGraphic" in2="coarse" scale="${coarseScale.toFixed(1)}" result="warped" />
      <feTurbulence type="fractalNoise" baseFrequency="0.038 0.065" numOctaves="2" seed="${fineSeed}" result="fine" />
      <feDisplacementMap in="warped" in2="fine" scale="${fineScale.toFixed(1)}" />
    </filter>`,
  );
  return id;
}

/**
 * 1滴分の radial-gradient を組み立てる。closest-side ellipse なので要素の width/height の比率が
 * そのまま楕円の異方性になる（transform scale は使わない）。
 * 中心のコア（--ink-core）と外側の前線（--ink-front）を別々の stop 位置として動かす。
 * 全 stop を --ink-front に比例させるとコアも一緒に拡大してしまい、
 * 濃度分布が丸ごと拡大する自己相似ズーム（2層構成が輪に見えていた問題の根） に戻ってしまうため、
 * コアの stop だけ --ink-core を参照させて別々に頭打ちさせる。
 * 中間 stop の alpha は固定値、縁側の alpha だけ --ink-edge-alpha で
 * 「広がるほど同じ顔料がより広い面積を覆って薄くなる」変化をつける。
 */
function buildInkBackground(color: ColorResult): string {
  const rgb = `${color.r} ${color.g} ${color.b}`;
  return (
    `radial-gradient(closest-side ellipse, ` +
    `rgb(${rgb} / 1) 0%, ` +
    `rgb(${rgb} / 1) var(--ink-core), ` +
    `rgb(${rgb} / ${MID_STOP_ALPHA}) calc((var(--ink-core) + var(--ink-front)) / 2), ` +
    // 最後の有色 stop を前線の直近（94%）まで寄せ、透明までを短い帯で落として濡れ前線の境界を立てる。
    // ここを緩めると縁が延々と薄れて水彩のようになる
    `rgb(${rgb} / var(--ink-edge-alpha)) calc(var(--ink-front) * 0.94), ` +
    `transparent var(--ink-front))`
  );
}

/**
 * 抽出色を背景レイヤーに「白い紙に滲んだインク」として散らす。
 * 各インクの面積は ratio に比例させ（直径 ∝ sqrt(ratio)）、1滴 = 子要素を持たない div 1個で表現する。
 * 同じ色相の2層を multiply で重ねると重なり領域だけ濃くなり境界が輪として見えてしまうため、
 * 層を分けず、radial-gradient の stop 位置（--ink-front / --ink-core）を
 * Web Animations API で動かして「濡れ前線だけが紙の上を進む」ことを単一レイヤーで表現する。
 * 要素サイズは最初から最終サイズ（異方性込み）で固定し、transform による scale 拡大は行わない
 * （scale 拡大だと SVG フィルタのノイズも一緒に伸び縮みし、紙目が滴と一緒に伸びる不自然さが出るため）。
 * 個体差は無相関な乱数ではなく、五滴で共有する紙の繊維角 paperFiberAngle を軸に、
 * 滴ごとの局所角度・異方性・duration・到着タイミングを相関させて生成する。
 * 位置は層化ランダム（色数分の縦スライスに分割し、シャッフルした列に1色ずつ割り当てる）で決め、
 * 少数色でも横方向に偏らず全体へ分散させる。
 */
function renderBlobs(colors: ColorResult[]): void {
  blobLayerEl.innerHTML = "";
  inkFilterDefsEl.innerHTML = "";

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const maxRatio = Math.max(...colors.map((color) => color.ratio), 1);
  const sumRatio = colors.reduce((sum, color) => sum + color.ratio, 0) || 1;
  // レイアウト前などで viewport が 0 と報告されるとインクが不可視になるためフォールバックする
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;
  const viewportArea = viewportWidth * viewportHeight;
  // top5 の合計面積がビューポート面積の 40〜60% 程度になるスケール感を狙う
  const targetAreaFraction = 0.4 + Math.random() * 0.2;
  const targetArea = viewportArea * targetAreaFraction;
  // area_i = (pi/4) * scale^2 * ratio_i を合計が targetArea になるよう scale を逆算する
  const scale = Math.sqrt((targetArea * 4) / (Math.PI * sumRatio));
  const sizes = colors.map((color) => scale * Math.sqrt(color.ratio));
  const medianSize = median(sizes) || 1;

  const colWidth = 100 / colors.length;
  const columnOrder = shuffled(colors.map((_, index) => index));
  const delayOrder = shuffled(generateBurstDelays(colors.length));
  // 紙の繊維方向は五滴で共有する1本の軸として決め、滴ごとにその周りで少しだけブレさせる
  const paperFiberAngle = randomBetween(-18, 18);

  colors.forEach((color, index) => {
    const size = sizes[index] as number;
    const opacity = 0.5 + (color.ratio / maxRatio) * 0.3;
    const column = columnOrder[index] as number;
    const left = column * colWidth + Math.random() * colWidth;
    const top = Math.random() * 100;
    const localFiberAngle =
      paperFiberAngle + randomBetween(-FIBER_ANGLE_JITTER_DEG, FIBER_ANGLE_JITTER_DEG);
    // 面積をほぼ保存した楕円化（finalX * finalY ≈ 1）で、紙目方向にだけ伸びる異方性を作る。
    // closest-side ellipse は要素の boundingbox に合わせた楕円になるため、
    // width/height をこの比率で最終サイズに固定するだけで異方性が出る（transform scale は使わない）
    const anisotropy = randomBetween(0.05, 0.18);
    const finalScaleX = 1 + anisotropy;
    const finalScaleY = 1 / finalScaleX;
    const width = size * finalScaleX;
    const height = size * finalScaleY;
    const initialFrontPercent = randomBetween(...FRONT_INITIAL_PERCENT_RANGE);
    const finalCorePercent = randomBetween(...CORE_FINAL_PERCENT_RANGE);
    // 支配色（大滴）だけが極端に遅くならないよう、物理的な指数2を1.25へ圧縮している
    const duration = clamp(
      (3200 * (size / medianSize) ** 1.25) / randomBetween(0.82, 1.2),
      1800,
      5600,
    );
    const delay = delayOrder[index] as number;

    const inkEl = document.createElement("div");
    inkEl.className = "absolute mix-blend-multiply";
    inkEl.style.width = `${width}px`;
    inkEl.style.height = `${height}px`;
    inkEl.style.left = `${left}%`;
    inkEl.style.top = `${top}%`;
    // 位置決めと繊維角の回転のみ transform で担う（拡大は --ink-front / --ink-core 側で行う）
    inkEl.style.transform = `translate(-50%, -50%) rotate(${localFiberAngle}deg)`;
    inkEl.style.background = buildInkBackground(color);
    // 異方性で width と height が異なるため、大きい方の辺を渡す。
    // 想定するアニソトロピー幅（anisotropy 0.05〜0.18）では、小さい方の辺の余白 25% を
    // 実用上下回らない（最悪ケースでも数%の超過に収まり縁は既にほぼ透明なため視認できない）。
    // 逆に小さい方の辺を渡すと大きい辺側の変位が過小になり滲みが弱く見える
    const filterLayerSize = Math.max(width, height);
    inkEl.style.filter = `url(#${appendInkFilter(inkFilterDefsEl, filterLayerSize)})`;

    if (prefersReducedMotion) {
      // WAAPI を使わず、アニメーション完了後（offset 1）相当の状態を直接適用する
      inkEl.style.opacity = String(opacity);
      inkEl.style.setProperty("--ink-front", `${FRONT_FINAL_PERCENT}%`);
      inkEl.style.setProperty("--ink-core", `${finalCorePercent}%`);
      inkEl.style.setProperty("--ink-edge-alpha", String(EDGE_ALPHA_END));
    } else {
      inkEl.animate(buildInkKeyframes(initialFrontPercent, finalCorePercent, opacity), {
        duration,
        delay,
        fill: "both",
      });
    }

    blobLayerEl.append(inkEl);
  });
}

function updateFormatToggleUi(): void {
  const buttons = formatToggleEl.querySelectorAll<HTMLButtonElement>(".format-toggle-btn");
  for (const buttonEl of buttons) {
    const isActive = buttonEl.dataset.format === currentFormat;
    buttonEl.classList.toggle("bg-foreground", isActive);
    buttonEl.classList.toggle("text-white", isActive);
    buttonEl.classList.toggle("text-muted-foreground", !isActive);
  }
}

function renderColors(colors: ColorResult[]): void {
  currentColors = colors;
  colorListEl.innerHTML = "";

  for (const color of colors) {
    const itemEl = document.createElement("li");
    itemEl.className =
      "flex items-center gap-3 rounded border border-border px-3 py-2.5";

    const swatchEl = document.createElement("span");
    swatchEl.className = "h-12 w-12 shrink-0 rounded border border-border";
    swatchEl.style.backgroundColor = color.hex;

    const infoEl = document.createElement("div");
    infoEl.className = "flex flex-1 flex-col gap-0.5";

    const codeEl = document.createElement("span");
    codeEl.className = "font-mono text-sm text-foreground";
    codeEl.textContent = formatColor(color, currentFormat);

    const ratioEl = document.createElement("span");
    ratioEl.className = "text-xs text-muted-foreground";
    ratioEl.textContent = `${color.ratio.toFixed(1)}%`;

    infoEl.append(codeEl, ratioEl);

    const copyButtonEl = document.createElement("button");
    copyButtonEl.type = "button";
    copyButtonEl.className =
      "shrink-0 rounded border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring";
    copyButtonEl.textContent = "copy";
    copyButtonEl.addEventListener("click", () => {
      void copyText(formatColor(color, currentFormat)).then((ok) => {
        copyButtonEl.textContent = ok ? "copied" : "failed";
        setTimeout(() => {
          copyButtonEl.textContent = "copy";
        }, 1200);
      });
    });

    itemEl.append(swatchEl, infoEl, copyButtonEl);
    colorListEl.append(itemEl);
  }

  updateFormatToggleUi();

  resultSectionEl.classList.remove("hidden");
  resultSectionEl.classList.add("flex");
}

copyAllButtonEl.addEventListener("click", () => {
  if (currentColors.length === 0) return;
  const text = currentColors.map((color) => formatColor(color, currentFormat)).join("\n");
  void copyText(text).then((ok) => {
    copyAllButtonEl.textContent = ok ? "copied" : "failed";
    setTimeout(() => {
      copyAllButtonEl.textContent = "一括copy";
    }, 1200);
  });
});

formatToggleEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const buttonEl = target.closest<HTMLButtonElement>(".format-toggle-btn");
  if (!buttonEl?.dataset.format) return;

  currentFormat = buttonEl.dataset.format as ColorFormat;
  if (currentColors.length > 0) {
    renderColors(currentColors);
  } else {
    updateFormatToggleUi();
  }
});

/**
 * 「サンプル画像で試す」用に、面積比に差のある5色の夕焼け風イラストを
 * Canvas 上で描画し File 化する（外部画像は使わない）。
 * 空の上段・下段・海・太陽・山のシルエットの5領域をベタ塗りし、
 * それぞれの面積比が top5 抽出で意味を持つよう大小を付ける。
 */
function createSampleImageFile(): Promise<File> {
  const width = 480;
  const height = 320;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("Canvas コンテキストの取得に失敗しました"));
  }

  const horizonY = height * 0.6;
  const skyBandY = height * 0.4;

  // 空・上段（面積最大）
  ctx.fillStyle = "#ff8c69";
  ctx.fillRect(0, 0, width, skyBandY);

  // 空・下段（夕焼けの帯）
  ctx.fillStyle = "#ffd27a";
  ctx.fillRect(0, skyBandY, width, horizonY - skyBandY);

  // 海（面積大）
  ctx.fillStyle = "#1e3a5f";
  ctx.fillRect(0, horizonY, width, height - horizonY);

  // 太陽（面積小）
  ctx.fillStyle = "#fff2b2";
  ctx.beginPath();
  ctx.arc(width * 0.7, horizonY - height * 0.02, height * 0.09, 0, Math.PI * 2);
  ctx.fill();

  // 山のシルエット（面積小〜中）
  ctx.fillStyle = "#141414";
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, horizonY + height * 0.02);
  ctx.lineTo(width * 0.22, horizonY - height * 0.08);
  ctx.lineTo(width * 0.4, horizonY + height * 0.03);
  ctx.lineTo(width * 0.6, horizonY - height * 0.12);
  ctx.lineTo(width * 0.85, horizonY + height * 0.02);
  ctx.lineTo(width, horizonY - height * 0.04);
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("サンプル画像の生成に失敗しました"));
        return;
      }
      resolve(new File([blob], "sample.png", { type: "image/png" }));
    }, "image/png");
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
    image.src = url;
  });
}

async function handleFile(file: File): Promise<void> {
  clearError();

  if (!file.type.startsWith("image/")) {
    showError("画像ファイルを指定してください");
    return;
  }

  try {
    const image = await loadImage(file);
    previewImageEl.src = image.src;
    previewSectionEl.classList.remove("hidden");
    previewSectionEl.classList.add("flex");

    const imageData = getResizedImageData(image);
    const colors = extractTopColors(imageData, 5);
    if (colors.length === 0) {
      showError("色を抽出できませんでした（透明な画像の可能性があります）");
      return;
    }
    renderColors(colors);
    renderBlobs(colors);
  } catch (error) {
    showError(error instanceof Error ? error.message : "画像の処理に失敗しました");
  }
}

dropzoneEl.addEventListener("click", () => {
  fileInputEl.click();
});

sampleButtonEl.addEventListener("click", () => {
  void createSampleImageFile()
    .then((file) => handleFile(file))
    .catch((error) => {
      showError(error instanceof Error ? error.message : "サンプル画像の生成に失敗しました");
    });
});

dropzoneEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInputEl.click();
  }
});

fileInputEl.addEventListener("change", () => {
  const file = fileInputEl.files?.[0];
  if (file) void handleFile(file);
  fileInputEl.value = "";
});

dropzoneEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzoneEl.classList.add("border-primary");
});

dropzoneEl.addEventListener("dragleave", () => {
  dropzoneEl.classList.remove("border-primary");
});

dropzoneEl.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzoneEl.classList.remove("border-primary");
  const file = event.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});

document.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) void handleFile(file);
      return;
    }
  }
});
