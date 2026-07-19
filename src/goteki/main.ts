import "../global.css";
import { formatColor, type ColorFormat } from "./colorFormat";
import { extractTopColors, getResizedImageData, type ColorResult } from "./colorQuantize";

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("app element not found");
}

appEl.innerHTML = `
  <svg width="0" height="0" class="absolute" aria-hidden="true" focusable="false">
    <filter id="ink-bleed" x="-50%" y="-50%" width="200%" height="200%">
      <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="4" seed="7" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="120" />
    </filter>
  </svg>

  <div id="blob-layer" class="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true"></div>
  <div class="pointer-events-none fixed inset-0 z-10 bg-white/60" aria-hidden="true"></div>

  <main class="relative z-20 mx-auto flex max-w-xl flex-col px-5 py-10">
    <div class="flex flex-col gap-6">
      <header class="flex flex-col gap-1.5">
        <h1 class="font-mincho text-2xl font-bold">五滴</h1>
        <p class="text-sm text-muted">画像を貼り付けると、使用色の面積比 top5 を五滴抽出します。</p>
      </header>

      <div
        id="dropzone"
        tabindex="0"
        class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded border border-dashed border-border px-4 py-10 text-center transition-colors focus-visible:outline-2 focus-visible:outline-red"
      >
        <p class="text-sm text-ink">
          ここに画像をドラッグ&ドロップ / クリックで選択 / <kbd class="rounded border border-border bg-paper px-1 py-0.5 text-xs">Cmd+V</kbd> で貼り付け
        </p>
        <p class="text-xs text-muted">Canvas 上で解析するのみで、画像は外部に送信されません</p>
      </div>
      <div class="-mt-4 flex justify-end">
        <button
          type="button"
          id="sample-button"
          class="rounded border border-border px-2.5 py-1 text-xs text-ink transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-red"
        >サンプル画像で試す</button>
      </div>
      <input id="file-input" type="file" accept="image/*" class="hidden" />

      <p id="error" class="hidden text-sm text-red" role="alert"></p>

      <section id="preview-section" class="hidden flex-col gap-2">
        <h2 class="text-sm font-bold text-muted">プレビュー</h2>
        <img id="preview-image" alt="貼り付けた画像のプレビュー" class="max-h-64 w-auto rounded border border-border object-contain" />
      </section>

      <section id="result-section" class="hidden flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-bold text-muted">使用色 top5（面積比順）</h2>
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
              class="shrink-0 rounded border border-border px-2.5 py-1 text-xs text-ink transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-red"
            >一括copy</button>
          </div>
        </div>
        <ul id="color-list" class="flex flex-col gap-2"></ul>
      </section>
    </div>
  </main>
`;

const blobLayerEl = document.getElementById("blob-layer") as HTMLDivElement;
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

/** 各コーナーが不揃いな border-radius を生成し、有機的なインクの輪郭を作る */
function randomInkRadius(): string {
  const corner = () => `${30 + Math.random() * 40}%`;
  return `${corner()} ${corner()} ${corner()} ${corner()} / ${corner()} ${corner()} ${corner()} ${corner()}`;
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

/**
 * 抽出色を背景レイヤーに「白い紙に滲んだインク」として散らす。
 * 各インクの面積は ratio に比例させ（直径 ∝ sqrt(ratio)）、
 * SVG フィルタ（feTurbulence + feDisplacementMap）で縁を不規則に滲ませる。
 * 位置は層化ランダム（色数分の縦スライスに分割し、シャッフルした列に1色ずつ割り当てる）で決め、
 * 少数色でも横方向に偏らず全体へ分散させる。
 */
function renderBlobs(colors: ColorResult[]): void {
  blobLayerEl.innerHTML = "";

  const maxRatio = Math.max(...colors.map((color) => color.ratio), 1);
  const sumRatio = colors.reduce((sum, color) => sum + color.ratio, 0) || 1;
  // レイアウト前などで viewport が 0 と報告されるとインクが不可視になるためフォールバックする
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;
  const viewportArea = viewportWidth * viewportHeight;
  // top5 の合計面積がビューポート面積の 25〜35% 程度になるスケール感を狙う
  const targetAreaFraction = 0.25 + Math.random() * 0.1;
  const targetArea = viewportArea * targetAreaFraction;
  // area_i = (pi/4) * scale^2 * ratio_i を合計が targetArea になるよう scale を逆算する
  const scale = Math.sqrt((targetArea * 4) / (Math.PI * sumRatio));

  const colWidth = 100 / colors.length;
  const columnOrder = shuffled(colors.map((_, index) => index));

  colors.forEach((color, index) => {
    const inkEl = document.createElement("div");
    const size = scale * Math.sqrt(color.ratio);
    const opacity = 0.5 + (color.ratio / maxRatio) * 0.3;
    const column = columnOrder[index] as number;
    const left = column * colWidth + Math.random() * colWidth;
    const top = Math.random() * 100;

    inkEl.className = "absolute opacity-0 mix-blend-multiply transition-all duration-700 ease-out";
    inkEl.style.width = `${size}px`;
    inkEl.style.height = `${size}px`;
    inkEl.style.left = `${left}%`;
    inkEl.style.top = `${top}%`;
    inkEl.style.borderRadius = randomInkRadius();
    inkEl.style.transform = "translate(-50%, -50%) scale(0.6)";
    inkEl.style.background = `radial-gradient(circle, ${color.hex} 0%, ${color.hex} 60%, ${color.hex}00 75%)`;
    // 柔らかさは全面ガラスの backdrop-blur に任せ、ここでは縁の滲み（displacement）だけかける
    inkEl.style.filter = "url(#ink-bleed)";

    blobLayerEl.append(inkEl);

    // 追加直後は opacity-0 / scale(0.6) のまま描画させ、次フレームで目標値へ遷移させてインクが広がる感を出す
    requestAnimationFrame(() => {
      inkEl.style.opacity = String(opacity);
      inkEl.style.transform = "translate(-50%, -50%) scale(1)";
    });
  });
}

function updateFormatToggleUi(): void {
  const buttons = formatToggleEl.querySelectorAll<HTMLButtonElement>(".format-toggle-btn");
  for (const buttonEl of buttons) {
    const isActive = buttonEl.dataset.format === currentFormat;
    buttonEl.classList.toggle("bg-ink", isActive);
    buttonEl.classList.toggle("text-white", isActive);
    buttonEl.classList.toggle("text-muted", !isActive);
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
    codeEl.className = "font-mono text-sm text-ink";
    codeEl.textContent = formatColor(color, currentFormat);

    const ratioEl = document.createElement("span");
    ratioEl.className = "text-xs text-muted";
    ratioEl.textContent = `${color.ratio.toFixed(1)}%`;

    infoEl.append(codeEl, ratioEl);

    const copyButtonEl = document.createElement("button");
    copyButtonEl.type = "button";
    copyButtonEl.className =
      "shrink-0 rounded border border-border px-2.5 py-1 text-xs text-ink transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-red";
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
  dropzoneEl.classList.add("border-red");
});

dropzoneEl.addEventListener("dragleave", () => {
  dropzoneEl.classList.remove("border-red");
});

dropzoneEl.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzoneEl.classList.remove("border-red");
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
