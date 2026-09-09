import "../global.css";
import "./styles.css";
import { extractMetadata, formatBytes, loadImage, type ImageMeta } from "./imageMeta";
import { detectFormatSupport, generateSampleFile, type ProbedFormat } from "./encode";
import {
  formatDelta,
  isFormatSupported,
  runPipeline,
  computeSizeLadder,
  buildOriginalDetailHtml,
  buildLongEdgeOptionsHtml,
  buildSizeInfoHtml,
  buildSizeLadderHtml,
  buildFormatComparisonHtml,
  buildMetadataSegmentsHtml,
  metadataStatusText,
  buildOutputInfoHtml,
  type FormatChoice,
  type PipelineResult,
  type SizeLadderRow,
} from "./pipeline";

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("app element not found");
}

const DESCRIPTION = "画像の圧縮率を工程ごとに比較します。";

appEl.innerHTML = `
  <main class="mx-auto flex max-w-5xl flex-col gap-8 px-5 py-10">
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

    <section id="result-section" class="hidden flex-col gap-4">
      <div class="flex flex-wrap items-center gap-x-5 gap-y-2 rounded border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
        <span class="text-sm font-semibold text-foreground">パラメータ</span>
        <label class="flex items-center gap-2">
          <span>品質</span>
          <input type="range" id="quality" min="0.3" max="1" step="0.05" value="0.8" class="w-32 accent-primary" />
          <span id="quality-value" class="w-10 shrink-0 font-mono text-foreground">0.80</span>
        </label>
        <label class="flex items-center gap-2">
          <span>長辺の上限</span>
          <select
            id="long-edge"
            class="rounded border border-border bg-background px-1.5 py-1 text-foreground"
            aria-label="長辺の上限"
          ></select>
        </label>
        <label class="flex items-center gap-2">
          <span>出力形式</span>
          <select
            id="format-select"
            class="rounded border border-border bg-background px-1.5 py-1 text-foreground"
            aria-label="出力形式"
          ></select>
        </label>
        <label class="flex items-center gap-1.5">
          <input type="checkbox" id="strip-metadata" checked class="accent-primary" />
          <span>メタデータ除去</span>
        </label>
        <a
          id="download-button"
          href="#"
          aria-disabled="true"
          class="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-primary bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground opacity-50 transition-colors hover:opacity-90"
        >ダウンロード</a>
      </div>

      <div id="canvas" class="keiryo-canvas relative overflow-x-auto rounded border border-border">
        <div id="canvas-content" class="keiryo-canvas-content relative">
          <svg id="edges" class="keiryo-edges pointer-events-none absolute inset-0" aria-hidden="true"></svg>
        </div>
      </div>

      <div id="detail-panel" class="flex flex-col gap-3 rounded border border-border bg-card p-4"></div>
    </section>
  </main>
`;

const dropzoneEl = document.getElementById("dropzone") as HTMLDivElement;
const sampleButtonEl = document.getElementById("sample-button") as HTMLButtonElement;
const fileInputEl = document.getElementById("file-input") as HTMLInputElement;
const errorEl = document.getElementById("error") as HTMLParagraphElement;
const resultSectionEl = document.getElementById("result-section") as HTMLElement;
const qualityInputEl = document.getElementById("quality") as HTMLInputElement;
const qualityValueEl = document.getElementById("quality-value") as HTMLSpanElement;
const longEdgeSelectEl = document.getElementById("long-edge") as HTMLSelectElement;
const formatSelectEl = document.getElementById("format-select") as HTMLSelectElement;
const stripMetadataCheckboxEl = document.getElementById("strip-metadata") as HTMLInputElement;
const downloadButtonEl = document.getElementById("download-button") as HTMLAnchorElement;
const canvasEl = document.getElementById("canvas") as HTMLDivElement;
const canvasContentEl = document.getElementById("canvas-content") as HTMLDivElement;
const edgesSvgEl = document.getElementById("edges") as unknown as SVGSVGElement;
const detailPanelEl = document.getElementById("detail-panel") as HTMLDivElement;

type StageId = "original" | "size" | "format" | "metadata" | "output";

const STAGE_LABELS: Record<StageId, string> = {
  original: "元画像",
  size: "サイズ",
  format: "フォーマット",
  metadata: "メタデータ",
  output: "出力",
};

const STAGE_ORDER: readonly StageId[] = ["original", "size", "format", "metadata", "output"];

// ノードの座標。x はキャンバス幅に応じて等間隔に広げ（最小間隔 184px を下回るときだけ横スクロール）、
// y は各ノードの実測高さから都度センタリングする
const NODE_START_X = 24;
const NODE_MIN_STEP_X = 184;
const NODE_WIDTH = 172;

/** キャンバスの表示幅から、ノードの x 間隔とコンテンツ幅を決める */
function computeNodeLayout(): { stepX: number; contentWidth: number } {
  const available = canvasEl.clientWidth - NODE_START_X * 2 - NODE_WIDTH;
  const stepX = Math.max(NODE_MIN_STEP_X, Math.floor(available / (STAGE_ORDER.length - 1)));
  const contentWidth = NODE_START_X * 2 + NODE_WIDTH + stepX * (STAGE_ORDER.length - 1);
  return { stepX, contentWidth };
}

/** 全ノードの left とコンテンツ幅を現在のキャンバス幅に合わせて置き直す */
function layoutNodes(): void {
  const { stepX, contentWidth } = computeNodeLayout();
  canvasContentEl.style.width = `${contentWidth}px`;
  edgesSvgEl.setAttribute("width", String(contentWidth));
  STAGE_ORDER.forEach((stageId, index) => {
    const els = state.nodeEls[stageId];
    if (els) els.rootEl.style.left = `${NODE_START_X + index * stepX}px`;
  });
}
const EDGE_CURVE_OFFSET = 60;
/** エッジラベルの下端をノード上端からどれだけ離すか（px） */
const EDGE_LABEL_GAP = 10;
const EDGE_MIN_STROKE = 1.5;
const EDGE_MAX_STROKE = 8;

interface BaseNodeEls {
  rootEl: HTMLDivElement;
  headerEl: HTMLDivElement;
  inputPortEl: HTMLDivElement | null;
  outputPortEl: HTMLDivElement | null;
}

interface OriginalNodeEls extends BaseNodeEls {
  thumbEl: HTMLImageElement;
  summaryEl: HTMLSpanElement;
}

interface SizeNodeEls extends BaseNodeEls {
  summaryEl: HTMLSpanElement;
}

interface FormatNodeEls extends BaseNodeEls {
  summaryEl: HTMLSpanElement;
}

interface MetadataNodeEls extends BaseNodeEls {
  summaryEl: HTMLSpanElement;
}

interface OutputNodeEls extends BaseNodeEls {
  bytesEl: HTMLSpanElement;
  deltaEl: HTMLSpanElement;
}

interface NodeElsMap {
  original?: OriginalNodeEls;
  size?: SizeNodeEls;
  format?: FormatNodeEls;
  metadata?: MetadataNodeEls;
  output?: OutputNodeEls;
}

interface EdgeEls {
  pathEl: SVGPathElement;
  labelEl: HTMLSpanElement;
  bytesTextEl: HTMLSpanElement;
  deltaTextEl: HTMLSpanElement;
}

interface AppState {
  file: File | null;
  objectUrl: string | null;
  originalArrayBuffer: ArrayBuffer | null;
  image: HTMLImageElement | null;
  meta: ImageMeta | null;
  quality: number;
  longEdgeCap: number | null;
  formatChoice: FormatChoice;
  stripMetadataEnabled: boolean;
  activeStage: StageId;
  pipeline: PipelineResult | null;
  support: Record<ProbedFormat, boolean> | null;
  computing: boolean;
  outputObjectUrl: string | null;
  nodeEls: NodeElsMap;
  edgeEls: EdgeEls[];
  /** サイズノードの長辺ラダー（what-if 比較）。品質ごとにキャッシュし、選択中でだけ埋める */
  sizeLadderCache: Map<string, SizeLadderRow[]>;
  sizeLadderRows: SizeLadderRow[] | null;
}

const state: AppState = {
  file: null,
  objectUrl: null,
  originalArrayBuffer: null,
  image: null,
  meta: null,
  quality: 0.8,
  longEdgeCap: null,
  formatChoice: "original",
  stripMetadataEnabled: true,
  activeStage: "original",
  pipeline: null,
  support: null,
  computing: false,
  outputObjectUrl: null,
  nodeEls: {},
  edgeEls: [],
  sizeLadderCache: new Map(),
  sizeLadderRows: null,
};

// ブラウザの書き出し対応可否は起動直後に一度だけ probe する
const supportPromise: Promise<Record<ProbedFormat, boolean>> = detectFormatSupport();

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearError(): void {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

const FORMAT_SELECT_CHOICES: readonly { value: FormatChoice; label: string }[] = [
  { value: "original", label: "元のまま" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
  { value: "png", label: "PNG" },
  { value: "avif", label: "AVIF" },
];

function buildFormatSelectOptions(support: Record<ProbedFormat, boolean>, current: FormatChoice): string {
  return FORMAT_SELECT_CHOICES.map((choice) => {
    const supported = choice.value === "original" || isFormatSupported(choice.value, support);
    const selected = choice.value === current;
    return `<option value="${choice.value}"${supported ? "" : " disabled"}${selected ? " selected" : ""}>${choice.label}${
      supported ? "" : "（書き出し不可）"
    }</option>`;
  }).join("");
}

function createPort(side: "left" | "right"): HTMLDivElement {
  const portEl = document.createElement("div");
  portEl.className = "keiryo-port absolute size-2.5 rounded-full border-2 border-primary bg-background";
  portEl.style.top = "50%";
  portEl.style.transform = "translateY(-50%)";
  portEl.style[side] = "-5px";
  portEl.setAttribute("aria-hidden", "true");
  return portEl;
}

/** ノード共通の外枠（ヘッダー・ポート・選択操作）を組み立て、body 要素だけ呼び出し側に渡す */
function createNodeShell(stageId: StageId, index: number): { rootEl: HTMLDivElement; headerEl: HTMLDivElement; bodyEl: HTMLDivElement; inputPortEl: HTMLDivElement | null; outputPortEl: HTMLDivElement | null } {
  const rootEl = document.createElement("div");
  rootEl.id = `keiryo-node-${stageId}`;
  rootEl.className =
    "keiryo-node absolute flex flex-col overflow-hidden rounded border border-border bg-card shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring";
  rootEl.style.width = `${NODE_WIDTH}px`;
  rootEl.style.setProperty("--row-index", String(index));
  rootEl.setAttribute("role", "button");
  rootEl.setAttribute("aria-controls", "detail-panel");
  rootEl.setAttribute("aria-pressed", "false");
  rootEl.tabIndex = -1;

  const headerEl = document.createElement("div");
  headerEl.className = "keiryo-node-header bg-muted px-2 py-1 text-xs font-semibold text-foreground";
  headerEl.textContent = STAGE_LABELS[stageId];

  const bodyEl = document.createElement("div");
  bodyEl.className = "flex flex-col gap-1.5 p-2 text-xs";

  rootEl.append(headerEl, bodyEl);

  const inputPortEl = stageId === "original" ? null : createPort("left");
  const outputPortEl = stageId === "output" ? null : createPort("right");
  if (inputPortEl) rootEl.append(inputPortEl);
  if (outputPortEl) rootEl.append(outputPortEl);

  rootEl.addEventListener("click", () => {
    setActiveStage(stageId);
    rootEl.focus();
  });
  rootEl.addEventListener("keydown", (event) => {
    if (event.target !== rootEl) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveStage(stageId);
    }
  });

  return { rootEl, headerEl, bodyEl, inputPortEl, outputPortEl };
}

/**
 * ノード5枚とエッジ4本を1回だけ生成する（画像読み込みごとに1回。以降の再計算は中身の更新のみ）。
 * ノードは表示専用（ヘッダー・要約行・ポートのみ）で、パラメータ操作はすべてキャンバス上部の
 * パラメータバー側の要素が担う（引数の support は呼び出し側の互換のため受け取るだけで使わない）
 */
function buildPipelineNodes(_meta: ImageMeta, _support: Record<ProbedFormat, boolean>): void {
  canvasContentEl.querySelectorAll(".keiryo-node").forEach((el) => el.remove());
  canvasContentEl.querySelectorAll(".keiryo-edge-label").forEach((el) => el.remove());
  state.nodeEls = {};
  state.edgeEls = [];

  STAGE_ORDER.forEach((stageId, index) => {
    const shell = createNodeShell(stageId, index);

    switch (stageId) {
      case "original": {
        const thumbEl = document.createElement("img");
        thumbEl.alt = "";
        thumbEl.className = "max-h-14 w-fit rounded border border-border object-contain";
        const summaryEl = document.createElement("span");
        summaryEl.className = "whitespace-pre-line font-mono text-muted-foreground";
        shell.bodyEl.append(thumbEl, summaryEl);
        state.nodeEls.original = { ...shell, thumbEl, summaryEl };
        break;
      }
      case "size": {
        const summaryEl = document.createElement("span");
        summaryEl.className = "whitespace-pre-line font-mono text-muted-foreground";
        shell.bodyEl.append(summaryEl);
        state.nodeEls.size = { ...shell, summaryEl };
        break;
      }
      case "format": {
        const summaryEl = document.createElement("span");
        summaryEl.className = "whitespace-pre-line font-mono text-muted-foreground";
        shell.bodyEl.append(summaryEl);
        state.nodeEls.format = { ...shell, summaryEl };
        break;
      }
      case "metadata": {
        const summaryEl = document.createElement("span");
        summaryEl.className = "whitespace-pre-line font-mono text-muted-foreground";
        shell.bodyEl.append(summaryEl);
        state.nodeEls.metadata = { ...shell, summaryEl };
        break;
      }
      case "output": {
        const bytesEl = document.createElement("span");
        bytesEl.className = "font-mono text-base font-semibold text-foreground";
        const deltaEl = document.createElement("span");
        deltaEl.className = "font-mono font-semibold text-primary";
        shell.bodyEl.append(bytesEl, deltaEl);
        state.nodeEls.output = { ...shell, bytesEl, deltaEl };
        break;
      }
    }

    canvasContentEl.append(shell.rootEl);
  });

  layoutNodes();
  // y はノードごとの実測高さからセンタリングする（transform だと offsetTop がずれ、ポート座標計算が狂うため）
  const canvasHeight = canvasEl.clientHeight;
  for (const stageId of STAGE_ORDER) {
    const els = state.nodeEls[stageId];
    if (!els) continue;
    els.rootEl.style.top = `${Math.max(0, Math.round((canvasHeight - els.rootEl.offsetHeight) / 2))}px`;
  }

  for (let i = 0; i < STAGE_ORDER.length - 1; i++) {
    const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("class", "keiryo-edge");
    edgesSvgEl.append(pathEl);

    const labelEl = document.createElement("span");
    labelEl.className =
      "keiryo-edge-label rounded border border-border bg-card px-1 py-0.5 font-mono text-xs text-foreground";
    const bytesTextEl = document.createElement("span");
    const deltaTextEl = document.createElement("span");
    deltaTextEl.className = "ml-1 text-primary";
    labelEl.append(bytesTextEl, deltaTextEl);
    canvasContentEl.append(labelEl);

    state.edgeEls.push({ pathEl, labelEl, bytesTextEl, deltaTextEl });
  }

  canvasContentEl.addEventListener("keydown", handleCanvasKeydown);
}

function handleCanvasKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (!(event.target instanceof HTMLElement) || !event.target.classList.contains("keiryo-node")) return;
  const currentIndex = STAGE_ORDER.indexOf(state.activeStage);
  const nextIndex =
    event.key === "ArrowRight"
      ? Math.min(STAGE_ORDER.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
  const nextStage = STAGE_ORDER[nextIndex];
  if (!nextStage || nextStage === state.activeStage) return;
  event.preventDefault();
  setActiveStage(nextStage);
  state.nodeEls[nextStage]?.rootEl.focus();
}

/** ノードの選択状態（ヘッダー配色・枠線・roving tabindex）を切り替え、詳細パネルを描画し直す */
function setActiveStage(stageId: StageId): void {
  state.activeStage = stageId;
  for (const id of STAGE_ORDER) {
    const els = state.nodeEls[id];
    if (!els) continue;
    const active = id === stageId;
    els.rootEl.setAttribute("aria-pressed", String(active));
    els.rootEl.tabIndex = active ? 0 : -1;
    els.rootEl.classList.toggle("border-primary", active);
    els.rootEl.classList.toggle("shadow", active);
    els.headerEl.classList.toggle("bg-primary", active);
    els.headerEl.classList.toggle("text-primary-foreground", active);
    els.headerEl.classList.toggle("bg-muted", !active);
    els.headerEl.classList.toggle("text-foreground", !active);
  }
  if (stageId === "size") {
    syncSizeLadderForQuality();
  } else {
    renderDetailPanel();
  }
}

/**
 * サイズノードの長辺ラダーを現在の品質のキャッシュから引き当て、詳細パネルへ反映する。
 * キャッシュが無ければ非同期で埋めにいく（サイズノードが選択されているときだけ呼ばれる）
 */
function syncSizeLadderForQuality(): void {
  const key = sizeLadderCacheKey(state.quality);
  const cached = state.sizeLadderCache.get(key);
  state.sizeLadderRows = cached ?? null;
  renderDetailPanel();
  if (!cached) ensureSizeLadder().catch((error: unknown) => console.error(error));
}

function sizeLadderCacheKey(quality: number): string {
  return quality.toFixed(2);
}

/** サイズラダーを計算してキャッシュへ書き込む。計算中に画像や品質が変わっていたら結果を捨てる */
async function ensureSizeLadder(): Promise<void> {
  const meta = state.meta;
  const image = state.image;
  if (!meta || !image) return;
  const key = sizeLadderCacheKey(state.quality);
  const rows = await computeSizeLadder(image, meta, state.quality);
  if (state.meta !== meta || sizeLadderCacheKey(state.quality) !== key) return;
  state.sizeLadderCache.set(key, rows);
  if (state.activeStage === "size") {
    state.sizeLadderRows = rows;
    renderDetailPanel();
  }
}

/** 原本比に応じたエッジの太さ（min 1.5 / max 8） */
function edgeStrokeWidth(bytes: number, originalBytes: number): number {
  const ratio = originalBytes > 0 ? bytes / originalBytes : 0;
  const width = EDGE_MIN_STROKE + ratio * (EDGE_MAX_STROKE - EDGE_MIN_STROKE);
  return Math.min(EDGE_MAX_STROKE, Math.max(EDGE_MIN_STROKE, width));
}

/** ノードの実測 DOM 矩形からエッジのベジェ曲線とラベル位置を引き直す */
function layoutEdges(): void {
  const canvasHeight = canvasEl.clientHeight;
  edgesSvgEl.setAttribute("height", String(canvasHeight));

  for (let i = 0; i < state.edgeEls.length; i++) {
    const fromStage = STAGE_ORDER[i];
    const toStage = STAGE_ORDER[i + 1];
    const edge = state.edgeEls[i];
    const fromEls = fromStage ? state.nodeEls[fromStage] : undefined;
    const toEls = toStage ? state.nodeEls[toStage] : undefined;
    if (!edge || !fromEls?.outputPortEl || !toEls?.inputPortEl) continue;

    const p1x = fromEls.rootEl.offsetLeft + fromEls.outputPortEl.offsetLeft + fromEls.outputPortEl.offsetWidth / 2;
    const p1y = fromEls.rootEl.offsetTop + fromEls.outputPortEl.offsetTop + fromEls.outputPortEl.offsetHeight / 2;
    const p2x = toEls.rootEl.offsetLeft + toEls.inputPortEl.offsetLeft + toEls.inputPortEl.offsetWidth / 2;
    const p2y = toEls.rootEl.offsetTop + toEls.inputPortEl.offsetTop + toEls.inputPortEl.offsetHeight / 2;

    edge.pathEl.setAttribute(
      "d",
      `M ${p1x} ${p1y} C ${p1x + EDGE_CURVE_OFFSET} ${p1y}, ${p2x - EDGE_CURVE_OFFSET} ${p2y}, ${p2x} ${p2y}`,
    );

    // ラベルはエッジ中点の真上ではなく、両ノードの上端より上に逃がす。ノード間の隙間は
    // 20px 程度しかなく、中点に置くと隣のノード本体（select 等）に被って読めないため
    const midX = (p1x + p2x) / 2;
    const rowTop = Math.min(fromEls.rootEl.offsetTop, toEls.rootEl.offsetTop);
    edge.labelEl.style.left = `${midX}px`;
    edge.labelEl.style.top = `${rowTop - EDGE_LABEL_GAP}px`;
  }
}

/** エッジの太さ・ラベル・流れアニメーションをパイプライン結果から更新する */
function styleEdges(): void {
  const meta = state.meta;
  if (!meta) return;
  const pipeline = state.pipeline;

  const edgeBytes: { bytes: number; prevBytes: number }[] = pipeline
    ? [
        { bytes: pipeline.size.output.bytes, prevBytes: meta.bytes },
        { bytes: pipeline.format.output.bytes, prevBytes: pipeline.size.output.bytes },
        { bytes: pipeline.metadata.output.bytes, prevBytes: pipeline.format.output.bytes },
        { bytes: pipeline.output.output.bytes, prevBytes: pipeline.metadata.output.bytes },
      ]
    : [];

  state.edgeEls.forEach((edge, index) => {
    const entry = edgeBytes[index];
    const width = entry ? edgeStrokeWidth(entry.bytes, meta.bytes) : EDGE_MIN_STROKE;
    edge.pathEl.setAttribute("stroke-width", width.toFixed(2));
    edge.pathEl.classList.toggle("is-animating", state.computing);

    if (entry) {
      edge.bytesTextEl.textContent = formatBytes(entry.bytes);
      const delta = formatDelta(entry.bytes, entry.prevBytes);
      edge.deltaTextEl.textContent = delta === "±0%" ? "" : delta;
    } else {
      edge.bytesTextEl.textContent = "—";
      edge.deltaTextEl.textContent = "";
    }
  });
}

function updateOriginalNode(): void {
  const meta = state.meta;
  const els = state.nodeEls.original;
  if (!meta || !els) return;
  if (state.objectUrl) els.thumbEl.src = state.objectUrl;
  els.summaryEl.textContent = `${meta.width}×${meta.height}\n${meta.sniffedFormat}\n${formatBytes(meta.bytes)}`;
}

function updateSizeNode(): void {
  const els = state.nodeEls.size;
  if (!els) return;
  const pipeline = state.pipeline;
  els.summaryEl.textContent =
    state.computing || !pipeline
      ? "計算中…"
      : `${pipeline.size.detail.beforeWidth}×${pipeline.size.detail.beforeHeight} → ${pipeline.size.detail.afterWidth}×${pipeline.size.detail.afterHeight}`;
}

function updateFormatNode(): void {
  const els = state.nodeEls.format;
  if (!els) return;
  const pipeline = state.pipeline;
  if (state.computing || !pipeline) {
    els.summaryEl.textContent = "計算中…";
    return;
  }
  const d = pipeline.format.detail;
  const formatText = d.passthrough ? `${d.chosenLabel}（元のまま）` : `${d.fromLabel} → ${d.chosenLabel}`;
  els.summaryEl.textContent = `${formatText}\n品質 ${state.quality.toFixed(2)}`;
}

function updateMetadataNode(): void {
  const els = state.nodeEls.metadata;
  if (!els) return;
  const pipeline = state.pipeline;
  if (state.computing || !pipeline) {
    els.summaryEl.textContent = "計算中…";
    return;
  }
  const d = pipeline.metadata.detail;
  if (d.cameFromCanvas) {
    els.summaryEl.textContent = "再エンコードで除去済み";
    return;
  }
  const bytesText = `Exif など ${formatBytes(d.scan.totalBytes)}`;
  els.summaryEl.textContent = d.strippedApplied ? `${bytesText} を除去` : `${bytesText}（保持）`;
}

function updateOutputNode(): void {
  const els = state.nodeEls.output;
  const meta = state.meta;
  if (!els || !meta) return;
  const pipeline = state.pipeline;
  if (state.computing || !pipeline) {
    els.bytesEl.textContent = "計算中…";
    els.deltaEl.textContent = "";
    return;
  }
  els.bytesEl.textContent = formatBytes(pipeline.output.output.bytes);
  els.deltaEl.textContent = formatDelta(pipeline.output.output.bytes, meta.bytes);
}

/** パラメータバーのダウンロードボタンを最新のパイプライン結果に合わせる（disabled 切り替え・href・ファイル名） */
function updateDownloadButton(): void {
  const pipeline = state.pipeline;
  if (!pipeline || !state.outputObjectUrl) {
    downloadButtonEl.classList.add("pointer-events-none", "opacity-50");
    downloadButtonEl.setAttribute("aria-disabled", "true");
    return;
  }
  downloadButtonEl.classList.remove("pointer-events-none", "opacity-50");
  downloadButtonEl.removeAttribute("aria-disabled");
  downloadButtonEl.href = state.outputObjectUrl;
  downloadButtonEl.download = pipeline.output.detail.downloadName;
}

/** ノード本文・エッジの太さ/ラベル・レイアウトをまとめて更新する（要素は作り直さない） */
function renderNodes(): void {
  if (!state.meta) return;
  updateOriginalNode();
  updateSizeNode();
  updateFormatNode();
  updateMetadataNode();
  updateOutputNode();
  updateDownloadButton();
  styleEdges();
  layoutEdges();

  for (const id of STAGE_ORDER) {
    state.nodeEls[id]?.rootEl.classList.toggle("opacity-60", state.computing);
  }
}

// --- 詳細パネル -------------------------------------------------------------
// マークアップの組み立ては pipeline.ts の build*Html / *StatusText 関数に寄せ、
// ここでは innerHTML への反映（＝ DOM 固有の処理）だけを担う。パラメータ操作は
// すべてパラメータバー側の要素が担うため、詳細パネル側にイベント登録は不要。

function renderOriginalDetail(): void {
  const meta = state.meta;
  if (!meta || !state.objectUrl) return;
  detailPanelEl.innerHTML = `
    <div class="flex flex-col gap-4 sm:flex-row">
      <img
        src="${state.objectUrl}"
        alt="読み込んだ画像のサムネイル"
        class="max-h-[140px] w-auto max-w-[200px] shrink-0 rounded border border-border object-contain"
      />
      <div class="min-w-0 flex-1">${buildOriginalDetailHtml(meta)}</div>
    </div>
  `;
}

function renderSizeDetail(): void {
  const meta = state.meta;
  const pipeline = state.pipeline;
  if (!meta) return;
  const pipelineHtml = pipeline
    ? `<div class="flex flex-col gap-1.5 text-sm">${buildSizeInfoHtml(meta, pipeline.size.detail, pipeline.size.output.bytes)}</div>`
    : `<p class="text-xs text-muted-foreground">計算中…</p>`;
  const ladderHtml = state.sizeLadderRows
    ? `<div class="flex flex-col">${buildSizeLadderHtml(state.sizeLadderRows, state.longEdgeCap)}</div>`
    : `<p class="text-xs text-muted-foreground">長辺ごとの比較を計算中…</p>`;
  detailPanelEl.innerHTML = `
    ${pipelineHtml}
    <div class="flex flex-col gap-1.5 pt-2">
      <span class="text-xs font-semibold text-muted-foreground">長辺ごとの比較（同じ品質・同じ形式で what-if）</span>
      ${ladderHtml}
    </div>
  `;
}

function renderFormatDetail(): void {
  const pipeline = state.pipeline;
  if (!pipeline) {
    detailPanelEl.innerHTML = `<p class="text-xs text-muted-foreground">計算中…</p>`;
    return;
  }
  const dims = { width: pipeline.size.output.width, height: pipeline.size.output.height };
  detailPanelEl.innerHTML = `
    <div class="flex flex-col">${buildFormatComparisonHtml(pipeline.format.detail.comparison, dims, pipeline.format.detail.highlightFormat)}</div>
    ${pipeline.format.detail.qualityIgnored ? `<p class="text-xs text-muted-foreground">PNG は可逆圧縮のため品質は効きません。</p>` : ""}
  `;
}

function renderMetadataDetail(): void {
  const pipeline = state.pipeline;
  if (!pipeline) {
    detailPanelEl.innerHTML = `<p class="text-xs text-muted-foreground">計算中…</p>`;
    return;
  }
  const d = pipeline.metadata.detail;
  detailPanelEl.innerHTML = `
    <div class="flex items-baseline justify-between gap-3 border-b border-border py-1.5 text-sm">
      <span class="font-semibold text-foreground">メタデータ合計</span>
      <span class="font-mono text-xs text-foreground">${formatBytes(d.scan.totalBytes)}</span>
    </div>
    <div class="flex flex-col">${buildMetadataSegmentsHtml(d.scan)}</div>
    <p class="text-xs text-muted-foreground">${metadataStatusText(d)}</p>
  `;
}

function renderOutputDetail(): void {
  const meta = state.meta;
  const pipeline = state.pipeline;
  if (!meta || !pipeline || !state.objectUrl || !state.outputObjectUrl) {
    detailPanelEl.innerHTML = `<p class="text-xs text-muted-foreground">計算中…</p>`;
    return;
  }
  const d = pipeline.output.detail;
  detailPanelEl.innerHTML = `
    <div class="flex flex-col gap-1.5 text-sm">${buildOutputInfoHtml(d)}</div>
    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-semibold text-muted-foreground">元と比べる</span>
      <div class="flex flex-wrap gap-3">
        <img src="${state.objectUrl}" alt="変換前" class="max-h-[240px] w-auto max-w-[45%] rounded border border-border object-contain" />
        <img src="${state.outputObjectUrl}" alt="変換後" class="max-h-[240px] w-auto max-w-[45%] rounded border border-border object-contain" />
      </div>
    </div>
  `;
}

function renderDetailPanel(): void {
  switch (state.activeStage) {
    case "original":
      renderOriginalDetail();
      break;
    case "size":
      renderSizeDetail();
      break;
    case "format":
      renderFormatDetail();
      break;
    case "metadata":
      renderMetadataDetail();
      break;
    case "output":
      renderOutputDetail();
      break;
  }
}

function revokeOutputObjectUrl(): void {
  if (state.outputObjectUrl) {
    URL.revokeObjectURL(state.outputObjectUrl);
    state.outputObjectUrl = null;
  }
}

/** 出力 blob の object URL をパイプライン結果ごとに作り直す（ノードのダウンロードボタンと詳細パネルの両方が使う） */
function updateOutputObjectUrl(): void {
  revokeOutputObjectUrl();
  if (state.pipeline) {
    state.outputObjectUrl = URL.createObjectURL(state.pipeline.output.output.blob);
  }
}

// --- パイプライン実行 ---------------------------------------------------------

let pipelineRunning = false;
let rerunRequested = false;

async function runPipelineOnce(): Promise<void> {
  const meta = state.meta;
  const image = state.image;
  const file = state.file;
  const originalArrayBuffer = state.originalArrayBuffer;
  if (!meta || !image || !file || !originalArrayBuffer) return;

  const support = state.support ?? (await supportPromise);
  state.support = support;
  // await 中に画像が差し替えられていたら、古い meta に対する計算結果は捨てる
  if (state.meta !== meta) return;

  try {
    const result = await runPipeline({
      file,
      meta,
      image,
      originalArrayBuffer,
      quality: state.quality,
      longEdgeCap: state.longEdgeCap,
      formatChoice: state.formatChoice,
      stripMetadataEnabled: state.stripMetadataEnabled,
      support,
    });
    if (state.meta !== meta) return;
    state.pipeline = result;
  } catch (error) {
    console.error(error);
    showError("画像の変換に失敗しました。別の画像やパラメータで試してください。");
  }
}

async function runPipelineLoop(): Promise<void> {
  if (pipelineRunning) {
    rerunRequested = true;
    return;
  }
  pipelineRunning = true;
  state.computing = true;
  renderNodes();
  try {
    do {
      rerunRequested = false;
      await runPipelineOnce();
    } while (rerunRequested);
  } finally {
    pipelineRunning = false;
    state.computing = false;
    updateOutputObjectUrl();
    renderNodes();
    renderDetailPanel();
  }
}

const DEBOUNCE_MS = 150;
let debounceHandle: ReturnType<typeof setTimeout> | undefined;

function scheduleRecompute(): void {
  if (debounceHandle !== undefined) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    runPipelineLoop().catch((error: unknown) => console.error(error));
  }, DEBOUNCE_MS);
}

// --- ファイル読み込み ---------------------------------------------------------

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
    const originalArrayBuffer = await file.arrayBuffer();
    const support = state.support ?? (await supportPromise);
    state.support = support;

    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    revokeOutputObjectUrl();

    state.file = file;
    state.objectUrl = objectUrl;
    state.originalArrayBuffer = originalArrayBuffer;
    state.image = image;
    state.meta = meta;
    state.quality = 0.8;
    state.longEdgeCap = null;
    state.formatChoice = "original";
    state.stripMetadataEnabled = true;
    state.activeStage = "original";
    state.pipeline = null;
    state.sizeLadderCache = new Map();
    state.sizeLadderRows = null;
    qualityInputEl.value = "0.8";
    qualityValueEl.textContent = "0.80";
    longEdgeSelectEl.innerHTML = buildLongEdgeOptionsHtml(meta, null);
    formatSelectEl.innerHTML = buildFormatSelectOptions(support, "original");
    stripMetadataCheckboxEl.checked = true;

    resultSectionEl.classList.remove("hidden");
    resultSectionEl.classList.add("flex");

    buildPipelineNodes(meta, support);
    setActiveStage("original");
    renderNodes();
    runPipelineLoop().catch((error: unknown) => console.error(error));
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
  updateFormatNode();
  if (state.activeStage === "size") syncSizeLadderForQuality();
  scheduleRecompute();
});

longEdgeSelectEl.addEventListener("change", () => {
  state.longEdgeCap = longEdgeSelectEl.value ? Number.parseInt(longEdgeSelectEl.value, 10) : null;
  if (state.activeStage === "size") renderDetailPanel();
  scheduleRecompute();
});

formatSelectEl.addEventListener("change", () => {
  state.formatChoice = formatSelectEl.value as FormatChoice;
  scheduleRecompute();
});

stripMetadataCheckboxEl.addEventListener("change", () => {
  state.stripMetadataEnabled = stripMetadataCheckboxEl.checked;
  scheduleRecompute();
});

qualityValueEl.textContent = state.quality.toFixed(2);

window.addEventListener("resize", () => {
  if (!state.meta) return;
  layoutNodes();
  layoutEdges();
});
