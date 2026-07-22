/// <reference types="vite/client" />
import "../global.css";
import "./styles.css";
import { loadSdrImageData, computeLumaMap, encodeBaseJpeg, encodeGainMapJpeg, type LumaMap } from "./convert";
import { assembleUltraHdrJpeg } from "./ultrahdr";
import { demosSectionHtml, initDemos, renderSupportList, supportsDrl, detectHdrDisplay } from "./demos";

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("app element not found");
}

appEl.innerHTML = `
  <main class="mx-auto flex max-w-3xl flex-col gap-10 px-5 py-10">
    <header class="flex flex-col gap-1.5">
      <h1 class="hdr-white-text text-2xl font-bold">シロビカリ</h1>
      <p class="text-sm text-muted-foreground">
        画像をめっちゃ光らせる変換をします。HDR 対応のディスプレイでは、通常の「白」より
        明るく光る写真（UltraHDR JPEG）になります。HDR 非対応の環境では普通の JPEG として
        表示されます。
      </p>
    </header>

    <section class="flex flex-col gap-2 rounded border border-border bg-card px-4 py-3">
      <h2 class="text-sm font-bold text-muted-foreground">サポート状況</h2>
      <ul id="support-list" class="flex flex-col gap-1 text-sm"></ul>
    </section>

    <section class="flex flex-col gap-3">
      <div
        id="dropzone"
        tabindex="0"
        role="button"
        aria-label="画像をドラッグ&ドロップまたはクリックして選択"
        class="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded border border-dashed border-border px-4 py-10 text-center transition-colors focus-visible:outline-2 focus-visible:outline-ring"
      >
        <p class="text-sm text-foreground">ここに画像をドラッグ&ドロップ / クリックで選択</p>
        <p class="text-xs text-muted-foreground">JPEG / PNG / WebP</p>
      </div>
      <input id="file-input" type="file" accept="image/jpeg,image/png,image/webp" class="hidden" />
      <p id="error" class="hidden text-sm text-destructive" role="alert"></p>
    </section>

    <section id="params-section" class="hidden flex-col gap-4">
      <label class="flex flex-col gap-1.5 text-sm">
        <span class="flex items-center justify-between text-muted-foreground">
          <span>明るさ</span>
          <span id="headroom-value" class="font-mono text-xs tabular-nums text-foreground">4倍</span>
        </span>
        <input type="range" id="headroom" min="1" max="4" step="0.5" value="2" class="w-full accent-primary" />
      </label>
      <label class="flex flex-col gap-1.5 text-sm">
        <span class="flex items-center justify-between text-muted-foreground">
          <span>光らせる範囲</span>
          <span id="curve-value" class="font-mono text-xs tabular-nums text-foreground">半分くらい</span>
        </span>
        <input type="range" id="curve" min="0" max="1" step="0.05" value="0.5" class="w-full accent-primary" />
        <span class="flex justify-between text-xs text-muted-foreground">
          <span>画像全体</span>
          <span>明るい部分だけ</span>
        </span>
      </label>
    </section>

    <section id="preview-section" class="hidden flex-col gap-3">
      <h2 class="text-sm font-bold text-muted-foreground">プレビュー</h2>
      <div class="flex flex-col gap-6 sm:flex-row">
        <figure class="flex flex-1 flex-col gap-2">
          <img id="original-preview" alt="変換前の元画像" class="drl-standard w-full rounded border border-border" />
          <figcaption class="text-xs text-muted-foreground">元画像（standard 固定）</figcaption>
        </figure>
        <figure class="flex flex-1 flex-col gap-2">
          <img id="converted-preview" alt="HDR に変換した画像" class="drl-no-limit w-full rounded border border-border" />
          <figcaption class="text-xs text-muted-foreground">変換後（no-limit）。HDR 非対応環境では元画像と同じに見えます</figcaption>
        </figure>
      </div>
      <p id="converting-status" class="hidden text-xs text-muted-foreground">変換中…</p>
      <div class="flex justify-end">
        <button
          type="button"
          id="download-button"
          disabled
          class="hdr-white-text hdr-white-border cursor-pointer border px-3 py-1.5 text-sm transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
        >ダウンロード</button>
      </div>
    </section>

    <details id="explainer" class="flex flex-col gap-3 rounded border border-border px-4 py-3">
      <summary class="cursor-pointer text-sm font-bold text-muted-foreground">HDR が明るく見える仕組み</summary>
      <div class="flex flex-col gap-8 pt-2">
        ${demosSectionHtml()}
      </div>
    </details>
  </main>
`;

const supportListEl = document.getElementById("support-list") as HTMLUListElement;
const dropzoneEl = document.getElementById("dropzone") as HTMLDivElement;
const fileInputEl = document.getElementById("file-input") as HTMLInputElement;
const errorEl = document.getElementById("error") as HTMLParagraphElement;
const paramsSectionEl = document.getElementById("params-section") as HTMLElement;
const headroomInputEl = document.getElementById("headroom") as HTMLInputElement;
const headroomValueEl = document.getElementById("headroom-value") as HTMLSpanElement;
const curveInputEl = document.getElementById("curve") as HTMLInputElement;
const curveValueEl = document.getElementById("curve-value") as HTMLSpanElement;
const previewSectionEl = document.getElementById("preview-section") as HTMLElement;
const originalPreviewEl = document.getElementById("original-preview") as HTMLImageElement;
const convertedPreviewEl = document.getElementById("converted-preview") as HTMLImageElement;
const convertingStatusEl = document.getElementById("converting-status") as HTMLParagraphElement;
const downloadButtonEl = document.getElementById("download-button") as HTMLButtonElement;
const explainerEl = document.getElementById("explainer") as HTMLDetailsElement;

function checkSupport(): void {
  const hdrDisplay = detectHdrDisplay();
  const drlSupported = supportsDrl();
  renderSupportList(supportListEl, [
    {
      label: `HDR ディスプレイ: ${hdrDisplay ? "検出" : "非検出"}`,
      ok: hdrDisplay,
      detail: hdrDisplay ? undefined : "SDR ディスプレイでは変換後プレビューの明るさの差が見えません。",
    },
    {
      label: `dynamic-range-limit（CSS）: ${drlSupported ? "対応" : "非対応"}`,
      ok: drlSupported,
      detail: drlSupported ? undefined : "このブラウザではプレビューが常に標準の明るさで表示されます。",
    },
  ]);
}

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError(): void {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * 変換対象ファイル・キャッシュした輝度マップ/ベース JPEG・生成済み Blob URL をまとめて持つ状態。
 * 輝度マップの計算とベース JPEG のエンコードはスライダーの params に依存しない重い処理なので、
 * 画像ロード時に1回だけ行った結果をここにキャッシュし、スライダー変更のたびにはやり直さない。
 */
type ConversionState = {
  file: File | null;
  lumaMap: LumaMap | null;
  baseJpeg: Uint8Array | null;
  originalObjectUrl: string | null;
  convertedObjectUrl: string | null;
};

const state: ConversionState = {
  file: null,
  lumaMap: null,
  baseJpeg: null,
  originalObjectUrl: null,
  convertedObjectUrl: null,
};

function revokeIfSet(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}

async function handleFileSelected(file: File): Promise<void> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    showError("JPEG / PNG / WebP の画像を選択してください。");
    return;
  }
  clearError();

  revokeIfSet(state.originalObjectUrl);
  const objectUrl = URL.createObjectURL(file);
  state.file = file;
  state.originalObjectUrl = objectUrl;
  originalPreviewEl.src = objectUrl;

  paramsSectionEl.classList.remove("hidden");
  paramsSectionEl.classList.add("flex");
  previewSectionEl.classList.remove("hidden");
  previewSectionEl.classList.add("flex");
  downloadButtonEl.disabled = true;

  try {
    const imageData = await loadSdrImageData(file);
    // 輝度走査とベース JPEG エンコードはどちらも params に依存しない重い処理なので、
    // 画像ロード時に1回だけ実行して state にキャッシュし、スライダー変更では使い回す
    state.lumaMap = computeLumaMap(imageData);
    state.baseJpeg = await encodeBaseJpeg(imageData);
    await runConversion();
  } catch (error) {
    console.error(error);
    showError("画像の読み込みに失敗しました。別の画像で試してください。");
  }
}

/**
 * 実際の変換処理本体。呼び出し元の runConversion が in-flight を直列化しているため、
 * ここは常に高々1つしか同時実行されない前提でよい。
 */
async function runConversionOnce(): Promise<void> {
  if (!state.lumaMap || !state.baseJpeg) return;
  convertingStatusEl.classList.remove("hidden");
  downloadButtonEl.disabled = true;

  try {
    const stops = Number.parseFloat(headroomInputEl.value);
    const curve = Number.parseFloat(curveInputEl.value);
    const { gainMapJpeg, maxGainLog2 } = await encodeGainMapJpeg(state.lumaMap, { stops, curve });
    const bytes = assembleUltraHdrJpeg(state.baseJpeg, gainMapJpeg, { maxGainLog2 });

    revokeIfSet(state.convertedObjectUrl);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    state.convertedObjectUrl = url;
    convertedPreviewEl.src = url;
    downloadButtonEl.disabled = false;
  } catch (error) {
    console.error(error);
    showError("HDR への変換に失敗しました。別の画像やパラメータで試してください。");
  } finally {
    convertingStatusEl.classList.add("hidden");
  }
}

let conversionRunning = false;
let rerunRequested = false;

/**
 * 変換の in-flight を直列化する。debounce は「開始」を間引くだけなので、前回の変換が
 * 実行中のまま次の呼び出しが来ることがある（重い処理なので普通に起こりうる）。
 * 実行中なら rerunRequested を立てて即座に返し、実行中の変換が終わった直後に
 * （そのときの最新パラメータで）もう一度だけ実行する。
 */
async function runConversion(): Promise<void> {
  if (conversionRunning) {
    rerunRequested = true;
    return;
  }
  conversionRunning = true;
  try {
    do {
      rerunRequested = false;
      await runConversionOnce();
    } while (rerunRequested);
  } finally {
    conversionRunning = false;
  }
}

const DEBOUNCE_MS = 150;
let debounceHandle: ReturnType<typeof setTimeout> | undefined;

function scheduleConversion(): void {
  if (debounceHandle !== undefined) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    runConversion().catch((error: unknown) => console.error(error));
  }, DEBOUNCE_MS);
}

function stopsToLabel(stops: number): string {
  const times = 2 ** stops;
  return `${Number.isInteger(times) ? times : times.toFixed(1)}倍`;
}

function curveToLabel(curve: number): string {
  if (curve <= 0.15) return "画像全体";
  if (curve >= 0.85) return "明るい部分だけ";
  if (curve < 0.35) return "広め";
  if (curve <= 0.65) return "半分くらい";
  return "狭め";
}

headroomInputEl.addEventListener("input", () => {
  headroomValueEl.textContent = stopsToLabel(Number.parseFloat(headroomInputEl.value));
  scheduleConversion();
});

curveInputEl.addEventListener("input", () => {
  curveValueEl.textContent = curveToLabel(Number.parseFloat(curveInputEl.value));
  scheduleConversion();
});

dropzoneEl.addEventListener("click", () => fileInputEl.click());
dropzoneEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInputEl.click();
  }
});
dropzoneEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzoneEl.classList.add("dropzone-active");
});
dropzoneEl.addEventListener("dragleave", () => {
  dropzoneEl.classList.remove("dropzone-active");
});
dropzoneEl.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzoneEl.classList.remove("dropzone-active");
  const file = event.dataTransfer?.files[0];
  if (file) {
    handleFileSelected(file).catch((error: unknown) => console.error(error));
  }
});

fileInputEl.addEventListener("change", () => {
  const file = fileInputEl.files?.[0];
  if (file) {
    handleFileSelected(file).catch((error: unknown) => console.error(error));
  }
});

downloadButtonEl.addEventListener("click", () => {
  if (!state.convertedObjectUrl || !state.file) return;
  const baseName = state.file.name.replace(/\.[^.]+$/, "");
  const anchor = document.createElement("a");
  anchor.href = state.convertedObjectUrl;
  anchor.download = `${baseName}-hdr.jpg`;
  anchor.click();
});

// WebGPU 初期化はコストがあるため、disclosure を実際に開くまで遅延させる
explainerEl.addEventListener("toggle", () => {
  if (explainerEl.open) {
    initDemos();
  }
});

checkSupport();
