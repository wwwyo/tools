import "../global.css";
import "./styles.css";
import {
  basenameNoExt,
  extractMetadata,
  formatBytes,
  loadImage,
  type ImageMeta,
} from "./imageMeta";
import {
  detectFormatSupport,
  encodeImage,
  extensionFor,
  generateSampleFile,
  type OutputFormat,
  type ProbedFormat,
} from "./encode";

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("app element not found");
}

const DESCRIPTION = "画像を検品して、拡張子ごとの圧縮結果を見比べられます。";

appEl.innerHTML = `
  <main class="mx-auto flex max-w-3xl flex-col gap-8 px-5 py-10">
    <header class="flex flex-col gap-1.5">
      <h1 class="text-2xl font-bold">ケイリョウ</h1>
      <p class="text-sm text-muted-foreground">${DESCRIPTION}</p>
    </header>

    <section class="flex flex-col gap-3">
      <div
        id="dropzone"
        tabindex="0"
        role="button"
        aria-label="画像をドラッグ&ドロップまたはクリックして選択"
        class="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded border border-dashed border-border px-4 py-10 text-center transition-colors focus-visible:outline-2 focus-visible:outline-ring"
      >
        <p class="text-sm text-foreground">ここに画像をドラッグ&ドロップ / クリックで選択 / Cmd+V で貼り付け</p>
      </div>
      <div class="-mt-1 flex justify-end">
        <button
          type="button"
          id="sample-button"
          class="rounded border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >サンプル画像で試す</button>
      </div>
      <input id="file-input" type="file" accept="image/*" class="hidden" />
      <p id="error" class="hidden text-sm text-destructive" role="alert"></p>
    </section>

    <section id="result-section" class="hidden flex-col gap-6">
      <div class="flex flex-col gap-4 rounded border border-border bg-card p-4 sm:flex-row">
        <img
          id="thumbnail"
          alt="読み込んだ画像のサムネイル"
          class="max-h-[140px] w-auto max-w-[200px] shrink-0 rounded border border-border object-contain"
        />
        <div id="meta-table" class="min-w-0 flex-1"></div>
      </div>

      <div class="flex flex-wrap items-center gap-4">
        <label class="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
          <span>品質</span>
          <input type="range" id="quality" min="0.3" max="1" step="0.05" value="0.8" class="w-full max-w-48 accent-primary" />
          <span id="quality-value" class="w-10 shrink-0 font-mono text-foreground">0.80</span>
        </label>
        <label class="flex items-center gap-2 text-xs text-muted-foreground">
          <span>長辺の上限</span>
          <select
            id="long-edge"
            class="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            <option value="">なし</option>
            <option value="2048">2048px</option>
            <option value="1600">1600px</option>
            <option value="1200">1200px</option>
            <option value="800">800px</option>
          </select>
        </label>
      </div>

      <div id="ladder" class="flex flex-col gap-2"></div>
    </section>
  </main>
`;

const dropzoneEl = document.getElementById("dropzone") as HTMLDivElement;
const sampleButtonEl = document.getElementById("sample-button") as HTMLButtonElement;
const fileInputEl = document.getElementById("file-input") as HTMLInputElement;
const errorEl = document.getElementById("error") as HTMLParagraphElement;
const resultSectionEl = document.getElementById("result-section") as HTMLElement;
const thumbnailEl = document.getElementById("thumbnail") as HTMLImageElement;
const metaTableEl = document.getElementById("meta-table") as HTMLDivElement;
const qualityInputEl = document.getElementById("quality") as HTMLInputElement;
const qualityValueEl = document.getElementById("quality-value") as HTMLSpanElement;
const longEdgeSelectEl = document.getElementById("long-edge") as HTMLSelectElement;
const ladderEl = document.getElementById("ladder") as HTMLDivElement;

/** ラダーに並べる出力形式。常にこの順で1行ずつ出す */
const ROW_FORMATS: readonly OutputFormat[] = ["jpeg", "webp", "avif", "png"];

const FORMAT_LABELS: Record<OutputFormat, string> = {
  jpeg: "JPEG .jpg",
  webp: "WebP .webp",
  avif: "AVIF .avif",
  png: "PNG .png",
};

/** ラダー1行の仕様。format が null の行だけは「元ファイル」で、再エンコードせず元のバイト列をそのまま扱う */
interface RowSpec {
  label: string;
  format: OutputFormat | null;
}

/** ラダー1行の実行時状態（DOM 参照 + 直近のエンコード結果） */
interface RowRuntime {
  spec: RowSpec;
  supported: boolean;
  rowEl: HTMLDivElement;
  dimsEl: HTMLSpanElement;
  sizeEl: HTMLSpanElement;
  deltaEl: HTMLSpanElement;
  statusEl: HTMLSpanElement;
  barTrackEl: HTMLDivElement;
  barFillEl: HTMLDivElement;
  downloadButtonEl: HTMLButtonElement;
  size: number | null;
  width: number | null;
  height: number | null;
  objectUrl: string | null;
  downloadName: string | null;
}

interface AppState {
  file: File | null;
  objectUrl: string | null;
  image: HTMLImageElement | null;
  meta: ImageMeta | null;
  quality: number;
  longEdgeCap: number | null;
  rows: RowRuntime[];
}

const state: AppState = {
  file: null,
  objectUrl: null,
  image: null,
  meta: null,
  quality: 0.8,
  longEdgeCap: null,
  rows: [],
};

// ブラウザの書き出し対応可否は起動直後に一度だけ probe する。1×1 canvas での判定なので実質同期に近い速さで解決する
const supportPromise: Promise<Record<ProbedFormat, boolean>> = detectFormatSupport();

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError(): void {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

function buildMetaRowsHtml(m: ImageMeta): string {
  const rows: [string, string][] = [
    ["ファイル名", m.fileName],
    ["拡張子", `.${m.ext}`],
    ["実際の形式", m.sniffedFormat],
    ["MIME", m.mime],
    ["容量", `${formatBytes(m.bytes)} (${m.bytes.toLocaleString("ja-JP")} B)`],
    ["寸法", `${m.width} × ${m.height} px`],
    ["画素数", `${m.megapixels} MP`],
    ["アスペクト比", `${m.ratioInt} (${m.ratioDec})`],
    ["最終更新", m.lastModified],
    ["透過の有無", m.hasAlpha === null ? "判定不可" : m.hasAlpha ? "あり" : "なし"],
    ["色深度", m.bitInfo],
    ["EXIF向き", m.exifOrientation],
  ];
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<div class="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-b-0">` +
        `<span class="text-muted-foreground">${label}</span>` +
        `<span class="font-mono text-xs text-foreground">${value}</span>` +
        `</div>`,
    )
    .join("");
  const warningHtml = m.mismatch
    ? `<div class="flex items-baseline justify-between gap-3 py-1.5 text-sm">` +
      `<span class="text-destructive">警告</span>` +
      `<span class="text-xs text-destructive">拡張子(${m.extFormat})と実形式(${m.sniffedFormat})が不一致</span>` +
      `</div>`
    : "";
  return rowsHtml + warningHtml;
}

function buildRowSpecs(): RowSpec[] {
  return [
    { label: "元ファイル", format: null },
    ...ROW_FORMATS.map((format) => ({ label: FORMAT_LABELS[format], format })),
  ];
}

/** JPEG・PNG は常にブラウザが書き出せる前提とし、probe 対象は非可逆の WebP / AVIF のみ */
function isFormatSupported(format: OutputFormat, support: Record<ProbedFormat, boolean>): boolean {
  if (format === "jpeg" || format === "png") return true;
  return support[format as ProbedFormat] ?? false;
}

function formatDelta(size: number | null, originalBytes: number): string {
  if (size == null) return "±0%";
  const delta = Math.round((1 - size / originalBytes) * 100);
  if (delta === 0) return "±0%";
  return delta > 0 ? `−${delta}%` : `+${Math.abs(delta)}%`;
}

function createRow(spec: RowSpec, index: number, supported: boolean): RowRuntime {
  const rowEl = document.createElement("div");
  rowEl.className =
    "keiryo-row flex flex-col gap-1 rounded border border-border bg-card px-4 py-2.5";
  rowEl.style.setProperty("--row-index", String(index));
  rowEl.innerHTML = `
    <div class="flex flex-wrap items-center gap-3">
      <span class="row-label w-28 shrink-0 text-sm font-semibold text-foreground">${spec.label}</span>
      <span class="row-dims w-28 shrink-0 font-mono text-xs text-muted-foreground">—</span>
      <span class="row-size w-20 shrink-0 font-mono text-xs text-muted-foreground">—</span>
      <span class="row-delta w-14 shrink-0 font-mono text-xs font-semibold text-primary">±0%</span>
      <span class="row-status hidden shrink-0 text-xs text-muted-foreground">変換中…</span>
      <span class="row-unsupported hidden shrink-0 text-xs text-muted-foreground">このブラウザでは書き出し不可</span>
      <div class="row-bar-track h-2 min-w-24 flex-1 overflow-hidden rounded-full bg-muted">
        <div class="row-bar-fill keiryo-bar-fill h-full w-full rounded-full bg-primary" style="transform: scaleX(0);"></div>
      </div>
      <button
        type="button"
        class="row-download shrink-0 rounded border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
        disabled
      >ダウンロード</button>
    </div>
    <p class="row-note hidden pl-1 text-xs text-muted-foreground">可逆・品質は効きません</p>
  `;

  const downloadButtonEl = rowEl.querySelector(".row-download") as HTMLButtonElement;
  const row: RowRuntime = {
    spec,
    supported,
    rowEl,
    dimsEl: rowEl.querySelector(".row-dims") as HTMLSpanElement,
    sizeEl: rowEl.querySelector(".row-size") as HTMLSpanElement,
    deltaEl: rowEl.querySelector(".row-delta") as HTMLSpanElement,
    statusEl: rowEl.querySelector(".row-status") as HTMLSpanElement,
    barTrackEl: rowEl.querySelector(".row-bar-track") as HTMLDivElement,
    barFillEl: rowEl.querySelector(".row-bar-fill") as HTMLDivElement,
    downloadButtonEl,
    size: null,
    width: null,
    height: null,
    objectUrl: null,
    downloadName: null,
  };

  if (spec.format === "png") {
    (rowEl.querySelector(".row-note") as HTMLParagraphElement).classList.remove("hidden");
  }

  if (!supported) {
    const unsupportedEl = rowEl.querySelector(".row-unsupported") as HTMLSpanElement;
    unsupportedEl.classList.remove("hidden");
    row.dimsEl.classList.add("hidden");
    row.sizeEl.classList.add("hidden");
    row.deltaEl.classList.add("hidden");
    row.barTrackEl.classList.add("hidden");
    row.downloadButtonEl.classList.add("hidden");
  }

  downloadButtonEl.addEventListener("click", () => {
    if (!row.objectUrl || !row.downloadName) return;
    const anchor = document.createElement("a");
    anchor.href = row.objectUrl;
    anchor.download = row.downloadName;
    anchor.click();
  });

  return row;
}

function setRowBusy(row: RowRuntime, busy: boolean): void {
  row.rowEl.classList.toggle("opacity-50", busy);
  row.statusEl.classList.toggle("hidden", !busy);
}

/** 全行の現在サイズ（未計算行は元ファイルのバイト数で仮置き）から比率バーを再計算する */
function recomputeBars(): void {
  const meta = state.meta;
  if (!meta) return;
  const sizes = state.rows.map((row) => row.size ?? meta.bytes);
  const maxSize = Math.max(meta.bytes, ...sizes);
  state.rows.forEach((row, i) => {
    if (!row.supported) return;
    const size = sizes[i] ?? meta.bytes;
    const scale = maxSize > 0 ? size / maxSize : 0;
    row.barFillEl.style.transform = `scaleX(${scale})`;
  });
}

function applyRowResult(
  row: RowRuntime,
  data: { width: number; height: number; size: number; objectUrl: string; downloadName: string },
): void {
  const meta = state.meta;
  if (!meta) return;
  row.width = data.width;
  row.height = data.height;
  row.size = data.size;
  row.objectUrl = data.objectUrl;
  row.downloadName = data.downloadName;

  row.dimsEl.textContent = `${data.width}×${data.height}`;
  row.sizeEl.textContent = formatBytes(data.size);
  row.deltaEl.textContent = formatDelta(data.size, meta.bytes);
  row.downloadButtonEl.disabled = false;
  recomputeBars();
}

/** 元ファイル行は再エンコードせず、読み込み時に一度だけ確定値を反映する */
function applyOriginalFileRow(row: RowRuntime): void {
  const meta = state.meta;
  if (!meta || !state.objectUrl) return;
  applyRowResult(row, {
    width: meta.width,
    height: meta.height,
    size: meta.bytes,
    objectUrl: state.objectUrl,
    downloadName: meta.fileName,
  });
}

/** 1行分の再エンコードを実行し、完了次第 UI へ反映する（前回の object URL は失効させてから差し替える） */
async function encodeRow(row: RowRuntime): Promise<void> {
  const meta = state.meta;
  const image = state.image;
  if (!meta || !image || !row.spec.format) return;
  setRowBusy(row, true);
  try {
    const result = await encodeImage(image, {
      format: row.spec.format,
      quality: state.quality,
      longEdgeCap: state.longEdgeCap,
    });
    const staleObjectUrl = row.objectUrl;
    const objectUrl = URL.createObjectURL(result.blob);
    applyRowResult(row, {
      width: result.width,
      height: result.height,
      size: result.blob.size,
      objectUrl,
      downloadName: `${basenameNoExt(meta.fileName)}.${extensionFor(row.spec.format)}`,
    });
    // 差し替え後に失効させる。差し替え前に revoke すると、描画中の別行のダウンロードリンクへ影響しうるため
    if (staleObjectUrl) URL.revokeObjectURL(staleObjectUrl);
  } catch (error) {
    console.error(error);
    showError("画像の変換に失敗しました。別の画像やパラメータで試してください。");
  } finally {
    setRowBusy(row, false);
  }
}

let encodeRunning = false;
let rerunRequested = false;

/**
 * 全ラダー行を直列に再エンコードする。巨大な画像で複数行分の canvas を同時確保すると
 * メモリを食い荒らすため、Promise.all にせず1行ずつ await する。
 * 実行中に品質・長辺上限が変わった場合は直後にもう一度だけやり直す（in-flight の直列化）。
 */
async function runLadderOnce(): Promise<void> {
  for (const row of state.rows) {
    if (!row.spec.format || !row.supported) continue;
    await encodeRow(row);
  }
}

async function runLadder(): Promise<void> {
  if (encodeRunning) {
    rerunRequested = true;
    return;
  }
  encodeRunning = true;
  try {
    do {
      rerunRequested = false;
      await runLadderOnce();
    } while (rerunRequested);
  } finally {
    encodeRunning = false;
  }
}

const DEBOUNCE_MS = 150;
let debounceHandle: ReturnType<typeof setTimeout> | undefined;

function scheduleLadder(): void {
  if (debounceHandle !== undefined) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    runLadder().catch((error: unknown) => console.error(error));
  }, DEBOUNCE_MS);
}

function revokeAllRowObjectUrls(): void {
  for (const row of state.rows) {
    // 元ファイル行の objectUrl は state.objectUrl と共有しているため、ここでは個別に revoke しない
    if (row.objectUrl && row.spec.format) URL.revokeObjectURL(row.objectUrl);
  }
}

/** 長辺の上限 select の選択肢を、今の画像でアップスケールになるものだけ disabled にする */
function updateLongEdgeOptions(): void {
  const meta = state.meta;
  if (!meta) return;
  const longEdge = Math.max(meta.width, meta.height);
  let selectionInvalidated = false;
  for (const option of Array.from(longEdgeSelectEl.options)) {
    if (option.value === "") continue;
    const value = Number(option.value);
    const disabled = value >= longEdge;
    option.disabled = disabled;
    if (disabled && option.selected) selectionInvalidated = true;
  }
  if (selectionInvalidated) {
    longEdgeSelectEl.value = "";
    state.longEdgeCap = null;
  }
}

async function renderLadder(): Promise<void> {
  const meta = state.meta;
  if (!meta) return;
  const support = await supportPromise;
  // await 中に画像が差し替えられていたら、古い meta に対する描画は捨てる
  if (state.meta !== meta) return;

  revokeAllRowObjectUrls();
  ladderEl.innerHTML = "";
  const specs = buildRowSpecs();
  state.rows = specs.map((spec, i) => {
    const supported = spec.format === null || isFormatSupported(spec.format, support);
    return createRow(spec, i, supported);
  });
  for (const row of state.rows) ladderEl.append(row.rowEl);

  const originalRow = state.rows.find((row) => row.spec.format === null);
  if (originalRow) applyOriginalFileRow(originalRow);

  recomputeBars();
  runLadder().catch((error: unknown) => console.error(error));
}

function renderResult(): void {
  const meta = state.meta;
  if (!meta || !state.objectUrl) return;
  resultSectionEl.classList.remove("hidden");
  resultSectionEl.classList.add("flex");
  thumbnailEl.src = state.objectUrl;
  metaTableEl.innerHTML = buildMetaRowsHtml(meta);
  updateLongEdgeOptions();
  renderLadder().catch((error: unknown) => console.error(error));
}

async function handleFileSelected(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) {
    showError("画像ファイルを選択してください。");
    return;
  }
  clearError();

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const meta = await extractMetadata(file, image);

    // 差し替え成功後にのみ前の状態を破棄する。失敗時に前の画像が消える不整合を避けるため
    revokeAllRowObjectUrls();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);

    state.file = file;
    state.objectUrl = objectUrl;
    state.image = image;
    state.meta = meta;
    state.rows = [];

    renderResult();
  } catch (error) {
    console.error(error);
    URL.revokeObjectURL(objectUrl);
    showError("画像の読み込みに失敗しました。別の画像で試してください。");
  }
}

dropzoneEl.addEventListener("click", () => fileInputEl.click());
dropzoneEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInputEl.click();
  }
});
dropzoneEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzoneEl.classList.add("bg-muted");
});
dropzoneEl.addEventListener("dragleave", () => {
  dropzoneEl.classList.remove("bg-muted");
});
dropzoneEl.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzoneEl.classList.remove("bg-muted");
  const file = event.dataTransfer?.files[0];
  if (file) handleFileSelected(file).catch((error: unknown) => console.error(error));
});

fileInputEl.addEventListener("change", () => {
  const file = fileInputEl.files?.[0];
  if (file) handleFileSelected(file).catch((error: unknown) => console.error(error));
});

document.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) handleFileSelected(file).catch((error: unknown) => console.error(error));
      break;
    }
  }
});

sampleButtonEl.addEventListener("click", () => {
  sampleButtonEl.disabled = true;
  sampleButtonEl.textContent = "生成中…";
  generateSampleFile()
    .then((file) => handleFileSelected(file))
    .catch((error: unknown) => {
      console.error(error);
      showError("サンプル画像の生成に失敗しました。");
    })
    .finally(() => {
      sampleButtonEl.disabled = false;
      sampleButtonEl.textContent = "サンプル画像で試す";
    });
});

qualityInputEl.addEventListener("input", () => {
  state.quality = Number.parseFloat(qualityInputEl.value);
  qualityValueEl.textContent = state.quality.toFixed(2);
  scheduleLadder();
});

longEdgeSelectEl.addEventListener("change", () => {
  state.longEdgeCap = longEdgeSelectEl.value ? Number.parseInt(longEdgeSelectEl.value, 10) : null;
  scheduleLadder();
});

qualityValueEl.textContent = state.quality.toFixed(2);
