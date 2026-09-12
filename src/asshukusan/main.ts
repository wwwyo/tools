import "../global.css";
import "./styles.css";
import { extractMetadata, formatBytes, loadImage, type ImageMeta } from "./imageMeta";
import { detectFormatSupport, generateSampleFile, UnsupportedFormatError, type ProbedFormat } from "./encode";
import { scanMetadata, type MetadataScanResult } from "./metadataStrip";
import { extractExifPayload, parseExifStructure, readExifTags, type ExifEdits, type ExifTags } from "./exif";
import {
  formatDelta,
  runPipeline,
  computeSizeLadder,
  buildOriginalDetailHtml,
  buildSizeInfoHtml,
  buildSizeLadderHtml,
  buildFormatComparisonHtml,
  buildMetadataSegmentRowsHtml,
  buildMetadataTotalsHtml,
  buildExifTableHtml,
  metadataStatusNotes,
  metadataSummaryLines,
  defaultRemoveIds,
  buildOutputInfoHtml,
  FORMAT_LABELS,
  type FormatChoice,
  type FormatComparisonRow,
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
      <h1 class="text-2xl font-bold">圧縮 san</h1>
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
      <div id="canvas" class="asshukusan-canvas relative overflow-x-auto rounded border border-border">
        <div id="canvas-content" class="asshukusan-canvas-content relative">
          <svg id="edges" class="asshukusan-edges pointer-events-none absolute inset-0" aria-hidden="true"></svg>
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
  /** ヘッダー+本文をまとめた、実際に role="button" を持つ操作対象（フォーカス・キー操作はここが受ける） */
  buttonEl: HTMLDivElement;
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
  downloadButtonEl: HTMLAnchorElement;
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
  /** 除去するメタデータセグメントの id 一式（未読み込み時は空） */
  removeIds: Set<string>;
  exifEdits: ExifEdits;
  /** 画像読み込み時に一度だけ求める初期スキャン。セグメント一覧・Exif テーブルの元データ */
  metadataScan: MetadataScanResult | null;
  exifTags: ExifTags | null;
  metadataControls: MetadataControls | null;
  activeStage: StageId;
  pipeline: PipelineResult | null;
  support: Record<ProbedFormat, boolean> | null;
  computing: boolean;
  /** フォーマット比較表の AVIF 行がまだ wasm エンコード中かどうか（フォーマットノードの表示に使う） */
  avifComparisonPending: boolean;
  /** パラメータ変更〜再計算完了までの間 true。ダウンロードリンクは古い結果を配らないようこの間だけ無効化する */
  pipelineDirty: boolean;
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
  removeIds: new Set<string>(),
  exifEdits: { removeGps: false },
  metadataScan: null,
  exifTags: null,
  metadataControls: null,
  activeStage: "original",
  pipeline: null,
  support: null,
  computing: false,
  avifComparisonPending: false,
  pipelineDirty: false,
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

// --- インスペクタカードのコントロール行 -----------------------------------
// 各ステージ 1 回だけ DOM を生成し、再計算のたびに詳細パネルを再構築しても
// コントロール自体（select/range/checkbox）はフォーカス・選択状態を保ったまま
// 使い回す。詳細パネルの再描画では常にこの rootEl を先頭に append する。

/** コントロール行の共通外枠（折り返す flex row + 下端の hairline） */
function createControlsRow(): HTMLDivElement {
  const rowEl = document.createElement("div");
  rowEl.className = "flex flex-wrap items-center gap-3 border-b border-border pb-3 mb-3 text-xs";
  return rowEl;
}

// 品質はフォーマットカードだけが操作する単一の state.quality を持つ。サイズカードは
// 品質を操作しないため、このカードにはコントロール行そのものが無い（what-if 行だけが選択肢を兼ねる）。
// 2枚のカードで range を同期させていた頃の setQuality の相互書き込みは、片方が真実の発生源で
// ないと混乱するため廃止した。長辺の上限は select ではなく詳細パネルの what-if 行（サイズラダー）が選択肢を兼ねる

interface FormatControls {
  rootEl: HTMLDivElement;
  qualityInputEl: HTMLInputElement;
  qualityValueEl: HTMLSpanElement;
}

// 出力形式そのものは select ではなく詳細パネルの what-if 行（フォーマット比較表）が選択肢を兼ねる
function buildFormatControls(): FormatControls {
  const rootEl = createControlsRow();
  rootEl.innerHTML = `
    <label class="flex items-center gap-2">
      <span>品質</span>
      <input type="range" id="quality-format" min="0.3" max="1" step="0.05" value="0.8" class="w-32 accent-primary" />
      <span id="quality-format-value" class="w-10 shrink-0 font-mono text-foreground">0.80</span>
    </label>
  `;
  return {
    rootEl,
    qualityInputEl: rootEl.querySelector("#quality-format") as HTMLInputElement,
    qualityValueEl: rootEl.querySelector("#quality-format-value") as HTMLSpanElement,
  };
}

interface MetadataControls {
  rootEl: HTMLDivElement;
  segListEl: HTMLDivElement;
  orientationSelectEl: HTMLSelectElement | null;
  dateTimeInputEl: HTMLInputElement | null;
  dateTimeHintEl: HTMLParagraphElement | null;
  dateTimeOriginalInputEl: HTMLInputElement | null;
  dateTimeOriginalHintEl: HTMLParagraphElement | null;
  gpsCheckboxEl: HTMLInputElement | null;
}

const ORIENTATION_LABELS: Record<number, string> = {
  1: "1 そのまま",
  2: "2",
  3: "3 180°",
  4: "4",
  5: "5",
  6: "6 時計回り90°",
  7: "7",
  8: "8 反時計回り90°",
};

function buildOrientationOptionsHtml(current: number): string {
  return Object.entries(ORIENTATION_LABELS)
    .map(([value, label]) => `<option value="${value}"${Number(value) === current ? " selected" : ""}>${label}</option>`)
    .join("");
}

/**
 * メタデータカードのコントロール（セグメント一覧の除去チェックボックス + Exif の編集フィールド）は
 * 画像の中身（検出セグメント・Exif の有無）に依存するため、他カードのように起動時1回ではなく
 * 画像読み込みごとに作り直す。以降の再計算（recompute）では中身を作り直さず、この DOM をそのまま使い回す。
 */
function buildMetadataControls(
  scan: MetadataScanResult,
  exifTags: ExifTags | null,
  originalArrayBuffer: ArrayBuffer,
): MetadataControls {
  const rootEl = document.createElement("div");
  rootEl.className = "flex flex-col gap-3 border-b border-border pb-3 mb-3 text-xs";

  const segListEl = document.createElement("div");
  segListEl.className = "flex flex-col";
  segListEl.innerHTML = buildMetadataSegmentRowsHtml(scan, state.removeIds, false, originalArrayBuffer);

  const segSection = document.createElement("div");
  segSection.className = "flex flex-col gap-1.5";
  segSection.innerHTML = `<span class="text-sm font-semibold text-foreground">除去するメタデータ</span>`;
  segSection.append(segListEl);
  rootEl.append(segSection);

  segListEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("asshukusan-seg-checkbox")) return;
    const id = target.dataset.segId;
    if (!id) return;
    if (target.checked) state.removeIds.add(id);
    else state.removeIds.delete(id);
    scheduleRecompute();
  });

  let orientationSelectEl: HTMLSelectElement | null = null;
  let dateTimeInputEl: HTMLInputElement | null = null;
  let dateTimeHintEl: HTMLParagraphElement | null = null;
  let dateTimeOriginalInputEl: HTMLInputElement | null = null;
  let dateTimeOriginalHintEl: HTMLParagraphElement | null = null;
  let gpsCheckboxEl: HTMLInputElement | null = null;

  if (exifTags) {
    const exifSection = document.createElement("div");
    exifSection.className = "flex flex-col gap-2 border-t border-border/60 pt-2";
    exifSection.innerHTML = `
      <span class="text-sm font-semibold text-foreground">Exif 詳細</span>
      <div id="exif-table" class="flex flex-col"></div>
      <div class="flex flex-col gap-2 pt-1">
        <label class="flex items-center gap-2">
          <span class="w-32 shrink-0">Orientation</span>
          <select id="orientation-select" class="rounded border border-border bg-background px-1.5 py-1 text-foreground"></select>
        </label>
        <label class="flex items-center gap-2">
          <span class="w-32 shrink-0">DateTime</span>
          <input id="datetime-input" type="text" maxlength="19" pattern="\\d{4}:\\d{2}:\\d{2} \\d{2}:\\d{2}:\\d{2}" placeholder="YYYY:MM:DD HH:MM:SS" class="w-44 rounded border border-border bg-background px-1.5 py-1 font-mono text-foreground" />
        </label>
        <p id="datetime-hint" class="hidden pl-32 text-destructive">YYYY:MM:DD HH:MM:SS 形式・19文字で入力してください</p>
        <label class="flex items-center gap-2">
          <span class="w-32 shrink-0">DateTimeOriginal</span>
          <input id="datetime-original-input" type="text" maxlength="19" pattern="\\d{4}:\\d{2}:\\d{2} \\d{2}:\\d{2}:\\d{2}" placeholder="YYYY:MM:DD HH:MM:SS" class="w-44 rounded border border-border bg-background px-1.5 py-1 font-mono text-foreground" />
        </label>
        <p id="datetime-original-hint" class="hidden pl-32 text-destructive">YYYY:MM:DD HH:MM:SS 形式・19文字で入力してください</p>
        <label class="flex items-center gap-1.5">
          <input type="checkbox" id="gps-remove" class="accent-primary" />
          <span>GPS 情報を消す</span>
        </label>
      </div>
    `;
    rootEl.append(exifSection);

    const exifTableEl = exifSection.querySelector("#exif-table") as HTMLDivElement;
    exifTableEl.innerHTML = buildExifTableHtml(exifTags);

    orientationSelectEl = exifSection.querySelector("#orientation-select") as HTMLSelectElement;
    orientationSelectEl.innerHTML = buildOrientationOptionsHtml(exifTags.orientation ?? 1);
    orientationSelectEl.addEventListener("change", () => {
      state.exifEdits.orientation = Number.parseInt((orientationSelectEl as HTMLSelectElement).value, 10);
      scheduleRecompute();
    });

    dateTimeInputEl = exifSection.querySelector("#datetime-input") as HTMLInputElement;
    dateTimeHintEl = exifSection.querySelector("#datetime-hint") as HTMLParagraphElement;
    if (exifTags.dateTime) dateTimeInputEl.value = exifTags.dateTime;
    dateTimeInputEl.addEventListener("input", () => {
      const value = (dateTimeInputEl as HTMLInputElement).value;
      const valid = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
      (dateTimeHintEl as HTMLParagraphElement).classList.toggle("hidden", valid || value.length === 0);
      if (valid) {
        state.exifEdits.dateTime = value;
      } else {
        delete state.exifEdits.dateTime;
      }
      // 空欄・不正値へ変えたときも「編集を無かったことにする」という状態変化なので、
      // 再計算しないと直前の値を書き込んだままの結果が残ってしまう
      scheduleRecompute();
    });

    dateTimeOriginalInputEl = exifSection.querySelector("#datetime-original-input") as HTMLInputElement;
    dateTimeOriginalHintEl = exifSection.querySelector("#datetime-original-hint") as HTMLParagraphElement;
    if (exifTags.dateTimeOriginal) dateTimeOriginalInputEl.value = exifTags.dateTimeOriginal;
    dateTimeOriginalInputEl.addEventListener("input", () => {
      const value = (dateTimeOriginalInputEl as HTMLInputElement).value;
      const valid = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
      (dateTimeOriginalHintEl as HTMLParagraphElement).classList.toggle("hidden", valid || value.length === 0);
      if (valid) {
        state.exifEdits.dateTimeOriginal = value;
      } else {
        delete state.exifEdits.dateTimeOriginal;
      }
      scheduleRecompute();
    });

    gpsCheckboxEl = exifSection.querySelector("#gps-remove") as HTMLInputElement;
    gpsCheckboxEl.checked = exifTags.hasGps;
    gpsCheckboxEl.addEventListener("change", () => {
      state.exifEdits.removeGps = (gpsCheckboxEl as HTMLInputElement).checked;
      scheduleRecompute();
    });
  }

  return {
    rootEl,
    segListEl,
    orientationSelectEl,
    dateTimeInputEl,
    dateTimeHintEl,
    dateTimeOriginalInputEl,
    dateTimeOriginalHintEl,
    gpsCheckboxEl,
  };
}

const formatControls = buildFormatControls();

// --- what-if 行グループ（サイズラダー・フォーマット比較）---------------------------
// 行は select の <option> の代わりに、行全体をヒットエリアに持つ radio ボタン
// （`.asshukusan-bar-row`、`buildBarRowHtml` が組み立てる）。データ（ラダー行・比較行）が
// 変わったときだけ innerHTML を作り直し、選択の切り替えだけなら既存 DOM の
// aria-checked/クラスを更新するだけに留める。毎回作り直すと、キーボード操作（↑/↓）の
// 最中にフォーカスしていたボタンが消えて操作が続けられなくなるため

/** フォーカス中の行があれば data-value を返す（rebuild 前にフォーカス位置を退避するため） */
function focusedRowValue(containerEl: HTMLElement): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !containerEl.contains(active)) return null;
  return active.dataset.value ?? null;
}

/** rebuild 後、退避しておいた値と同じ行があれば再フォーカスする */
function restoreRowFocus(containerEl: HTMLElement, value: string | null): void {
  if (value === null) return;
  containerEl.querySelector<HTMLButtonElement>(`.asshukusan-bar-row[data-value="${value}"]`)?.focus();
}

/** 行ボタンの aria-checked・ハイライト・roving tabindex だけを既存 DOM 上で更新する（作り直さない） */
function syncRowSelection(containerEl: HTMLElement, selectedValue: string): void {
  containerEl.querySelectorAll<HTMLButtonElement>(".asshukusan-bar-row").forEach((btn) => {
    const selected = btn.dataset.value === selectedValue;
    btn.setAttribute("aria-checked", String(selected));
    btn.tabIndex = selected ? 0 : -1;
    btn.classList.toggle("border-primary", selected);
    btn.classList.toggle("bg-muted", selected);
    btn.classList.toggle("border-transparent", !selected);
  });
}

/**
 * クリックと ↑/↓ キー操作を行グループのコンテナへ1回だけ登録する（コンテナへの
 * addEventListener は innerHTML を作り直しても消えないため、行ボタン個々には付けない）。
 * ↑/↓ はノードのキーボード操作と同じく、フォーカス移動と同時に選択も切り替える
 */
function attachRowGroupHandlers(containerEl: HTMLElement, onSelect: (value: string) => void): void {
  containerEl.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const btn = event.target.closest<HTMLButtonElement>(".asshukusan-bar-row");
    if (!btn || btn.disabled) return;
    onSelect(btn.dataset.value ?? "");
  });
  containerEl.addEventListener("keydown", (event) => {
    // ↑/↓ に加えて ←/→ でも移動できるようにする（W3C の radiogroup パターンに合わせる）。
    // 端に達したら反対側へ折り返す（Home/End の代わりに一周する動線にしている）
    const isForward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const isBackward = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!isForward && !isBackward) return;
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.classList.contains("asshukusan-bar-row")) return;
    const rows = Array.from(containerEl.querySelectorAll<HTMLButtonElement>(".asshukusan-bar-row:not([disabled])"));
    const currentIndex = rows.indexOf(target);
    if (currentIndex === -1 || rows.length === 0) return;
    const nextIndex = (currentIndex + (isForward ? 1 : -1) + rows.length) % rows.length;
    const next = rows[nextIndex];
    if (!next || next === target) return;
    event.preventDefault();
    onSelect(next.dataset.value ?? "");
    next.focus();
  });
}

interface SizeDetailEls {
  rootEl: HTMLDivElement;
  infoEl: HTMLDivElement;
  ladderStatusEl: HTMLParagraphElement;
  ladderRowsEl: HTMLDivElement;
}

function buildSizeDetailEls(): SizeDetailEls {
  const rootEl = document.createElement("div");
  rootEl.className = "flex flex-col gap-1.5";

  const infoEl = document.createElement("div");
  infoEl.className = "flex flex-col gap-1.5 text-sm";

  const ladderSection = document.createElement("div");
  ladderSection.className = "flex flex-col gap-1.5 pt-2";
  const ladderLabelEl = document.createElement("span");
  ladderLabelEl.className = "text-xs font-semibold text-muted-foreground";
  ladderLabelEl.textContent = "長辺ごとの比較";
  const ladderStatusEl = document.createElement("p");
  ladderStatusEl.className = "text-xs text-muted-foreground";
  ladderStatusEl.textContent = "長辺ごとの比較を計算中…";
  const ladderRowsEl = document.createElement("div");
  ladderRowsEl.className = "flex flex-col";
  ladderRowsEl.setAttribute("role", "radiogroup");
  ladderRowsEl.setAttribute("aria-label", "長辺の上限");
  attachRowGroupHandlers(ladderRowsEl, handleSizeRowSelect);

  ladderSection.append(ladderLabelEl, ladderStatusEl, ladderRowsEl);
  rootEl.append(infoEl, ladderSection);

  return { rootEl, infoEl, ladderStatusEl, ladderRowsEl };
}

interface FormatDetailEls {
  rootEl: HTMLDivElement;
  loadingEl: HTMLParagraphElement;
  comparisonRowsEl: HTMLDivElement;
  pngNoteEl: HTMLParagraphElement;
}

function buildFormatDetailEls(): FormatDetailEls {
  const rootEl = document.createElement("div");
  rootEl.className = "flex flex-col gap-1.5";

  const comparisonLabelEl = document.createElement("span");
  comparisonLabelEl.className = "text-xs font-semibold text-muted-foreground";
  comparisonLabelEl.textContent = "形式ごとの比較";

  const loadingEl = document.createElement("p");
  loadingEl.className = "text-xs text-muted-foreground";
  loadingEl.textContent = "計算中…";

  const comparisonRowsEl = document.createElement("div");
  comparisonRowsEl.className = "flex flex-col";
  comparisonRowsEl.setAttribute("role", "radiogroup");
  comparisonRowsEl.setAttribute("aria-label", "出力形式");
  attachRowGroupHandlers(comparisonRowsEl, handleFormatRowSelect);

  const pngNoteEl = document.createElement("p");
  pngNoteEl.className = "hidden text-xs text-muted-foreground";
  pngNoteEl.textContent = "PNG は可逆圧縮のため品質は効きません。";

  rootEl.append(comparisonLabelEl, loadingEl, comparisonRowsEl, pngNoteEl);
  return { rootEl, loadingEl, comparisonRowsEl, pngNoteEl };
}

/** サイズラダー行の選択。ラダー行自体は品質だけに依存し longEdgeCap には依存しないため、
 * ここでの選択切り替えは data の再計算を伴わず（ensureSizeLadder は再実行しない）済む */
function handleSizeRowSelect(value: string): void {
  state.longEdgeCap = value === "original" ? null : Number.parseInt(value, 10);
  if (state.activeStage === "size") renderDetailPanel();
  scheduleRecompute();
}

function handleFormatRowSelect(value: string): void {
  state.formatChoice = value as FormatChoice;
  if (state.activeStage === "format") renderDetailPanel();
  scheduleRecompute();
}

const sizeDetailEls = buildSizeDetailEls();
const formatDetailEls = buildFormatDetailEls();

/** ノード・出力カード上部の2箇所にあるダウンロードボタンの共通見た目（disabled 時は opacity-50 + pointer-events-none） */
function createDownloadButton(): HTMLAnchorElement {
  const el = document.createElement("a");
  el.href = "#";
  el.setAttribute("aria-disabled", "true");
  el.className =
    "pointer-events-none mt-1 inline-flex self-start items-center rounded border border-primary bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground opacity-50 transition-colors hover:opacity-90";
  el.textContent = "ダウンロード";
  // 親要素（ノード本体・出力カード）の click は選択操作に使うため、ボタン押下をそちらへ流さない
  el.addEventListener("click", (event) => event.stopPropagation());
  return el;
}

interface OutputDetailEls {
  rootEl: HTMLDivElement;
  downloadButtonEl: HTMLAnchorElement;
  infoEl: HTMLDivElement;
  beforeImgEl: HTMLImageElement;
  afterImgEl: HTMLImageElement;
}

/** 出力カードは常設のダウンロードボタンをコントロール行代わりに持つ（他カードの controls とは違い、選択操作を伴わないため独立した persistent DOM にする） */
function buildOutputDetailEls(): OutputDetailEls {
  const rootEl = document.createElement("div");
  rootEl.className = "flex flex-col gap-3";

  const downloadButtonEl = createDownloadButton();

  const infoEl = document.createElement("div");
  infoEl.className = "flex flex-col gap-1.5 text-sm";

  const compareLabelEl = document.createElement("span");
  compareLabelEl.className = "text-xs font-semibold text-muted-foreground";
  compareLabelEl.textContent = "元と比べる";
  const compareImagesEl = document.createElement("div");
  compareImagesEl.className = "flex flex-wrap gap-3";
  const beforeImgEl = document.createElement("img");
  beforeImgEl.alt = "変換前";
  beforeImgEl.className = "max-h-[240px] w-auto max-w-[45%] rounded border border-border object-contain";
  const afterImgEl = document.createElement("img");
  afterImgEl.alt = "変換後";
  afterImgEl.className = "max-h-[240px] w-auto max-w-[45%] rounded border border-border object-contain";
  compareImagesEl.append(beforeImgEl, afterImgEl);
  const compareSection = document.createElement("div");
  compareSection.className = "flex flex-col gap-1.5";
  compareSection.append(compareLabelEl, compareImagesEl);

  rootEl.append(downloadButtonEl, infoEl, compareSection);
  return { rootEl, downloadButtonEl, infoEl, beforeImgEl, afterImgEl };
}

const outputDetailEls = buildOutputDetailEls();

/** サイズラダー・フォーマット比較のうち、直近に行 DOM を作り直した元データへの参照（変化検知用） */
let lastRenderedSizeLadderRows: SizeLadderRow[] | null = null;
let lastRenderedFormatComparison: FormatComparisonRow[] | null = null;

/** フォーマット比較表の AVIF 行のように、配列の中身だけが差し替わるケース向けにキャッシュを明示的に無効化する */
function invalidateFormatComparisonCache(): void {
  lastRenderedFormatComparison = null;
}

/** フォーマットカードの品質 range だけが state.quality を書き換える単一の発生源 */
function setQuality(value: number): void {
  state.quality = value;
  const text = value.toFixed(2);
  formatControls.qualityInputEl.value = String(value);
  formatControls.qualityValueEl.textContent = text;
  updateFormatNode();
  if (state.activeStage === "size") syncSizeLadderForQuality();
  scheduleRecompute();
}

function createPort(side: "left" | "right"): HTMLDivElement {
  const portEl = document.createElement("div");
  portEl.className = "asshukusan-port absolute size-2.5 rounded-full border-2 border-primary bg-background";
  portEl.style.top = "50%";
  portEl.style.transform = "translateY(-50%)";
  portEl.style[side] = "-5px";
  portEl.setAttribute("aria-hidden", "true");
  return portEl;
}

/**
 * ノード共通の外枠（ヘッダー・ポート・選択操作）を組み立て、body 要素だけ呼び出し側に渡す。
 *
 * role="button" はヘッダー+本文をまとめた内側の `buttonEl` に持たせ、`rootEl` 自体には
 * 付けない。出力ノードだけは `rootEl` の直下（`buttonEl` の外）にダウンロード用の `<a>` を
 * 追加で持つため、`<a>` が role="button" の中に入れ子にならないようにするための構造。
 */
function createNodeShell(stageId: StageId, index: number): { rootEl: HTMLDivElement; buttonEl: HTMLDivElement; headerEl: HTMLDivElement; bodyEl: HTMLDivElement; inputPortEl: HTMLDivElement | null; outputPortEl: HTMLDivElement | null } {
  const rootEl = document.createElement("div");
  rootEl.id = `asshukusan-node-${stageId}`;
  rootEl.className = "asshukusan-node absolute flex flex-col overflow-hidden rounded border border-border bg-card shadow-sm transition-colors";
  rootEl.style.width = `${NODE_WIDTH}px`;
  rootEl.style.setProperty("--row-index", String(index));

  const buttonEl = document.createElement("div");
  buttonEl.className = "flex flex-col focus-visible:outline-2 focus-visible:outline-ring";
  buttonEl.setAttribute("role", "button");
  buttonEl.setAttribute("aria-controls", "detail-panel");
  buttonEl.setAttribute("aria-pressed", "false");
  buttonEl.tabIndex = -1;

  const headerEl = document.createElement("div");
  headerEl.className = "asshukusan-node-header bg-muted px-2 py-1 text-xs font-semibold text-foreground";
  headerEl.textContent = STAGE_LABELS[stageId];

  const bodyEl = document.createElement("div");
  bodyEl.className = "flex flex-col gap-1.5 p-2 text-xs";

  buttonEl.append(headerEl, bodyEl);
  rootEl.append(buttonEl);

  const inputPortEl = stageId === "original" ? null : createPort("left");
  const outputPortEl = stageId === "output" ? null : createPort("right");
  if (inputPortEl) rootEl.append(inputPortEl);
  if (outputPortEl) rootEl.append(outputPortEl);

  buttonEl.addEventListener("click", () => {
    setActiveStage(stageId);
    buttonEl.focus();
  });
  buttonEl.addEventListener("keydown", (event) => {
    if (event.target !== buttonEl) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveStage(stageId);
    }
  });

  return { rootEl, buttonEl, headerEl, bodyEl, inputPortEl, outputPortEl };
}

/**
 * ノード5枚とエッジ4本を1回だけ生成する（画像読み込みごとに1回。以降の再計算は中身の更新のみ）。
 * ノードは表示専用（ヘッダー・要約行・ポートのみ）で、パラメータ操作はすべてキャンバス上部の
 * パラメータバー側の要素が担う（引数の support は呼び出し側の互換のため受け取るだけで使わない）
 */
function buildPipelineNodes(_meta: ImageMeta, _support: Record<ProbedFormat, boolean>): void {
  canvasContentEl.querySelectorAll(".asshukusan-node").forEach((el) => el.remove());
  canvasContentEl.querySelectorAll(".asshukusan-edge-label").forEach((el) => el.remove());
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
        const downloadButtonEl = createDownloadButton();
        downloadButtonEl.classList.add("mx-2", "mb-2");
        shell.bodyEl.append(bytesEl, deltaEl);
        // ダウンロードリンクは role="button" の buttonEl の外（rootEl 直下）に置く。
        // インタラクティブ要素を role="button" の中へ入れ子にしないため
        shell.rootEl.append(downloadButtonEl);
        state.nodeEls.output = { ...shell, bytesEl, deltaEl, downloadButtonEl };
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
    pathEl.setAttribute("class", "asshukusan-edge");
    edgesSvgEl.append(pathEl);

    const labelEl = document.createElement("span");
    labelEl.className =
      "asshukusan-edge-label rounded border border-border bg-card px-1 py-0.5 font-mono text-xs text-foreground";
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
  if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "button") return;
  const currentIndex = STAGE_ORDER.indexOf(state.activeStage);
  const nextIndex =
    event.key === "ArrowRight"
      ? Math.min(STAGE_ORDER.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1);
  const nextStage = STAGE_ORDER[nextIndex];
  if (!nextStage || nextStage === state.activeStage) return;
  event.preventDefault();
  setActiveStage(nextStage);
  state.nodeEls[nextStage]?.buttonEl.focus();
}

/** ノードの選択状態（ヘッダー配色・枠線・roving tabindex）を切り替え、詳細パネルを描画し直す */
function setActiveStage(stageId: StageId): void {
  state.activeStage = stageId;
  for (const id of STAGE_ORDER) {
    const els = state.nodeEls[id];
    if (!els) continue;
    const active = id === stageId;
    els.buttonEl.setAttribute("aria-pressed", String(active));
    els.buttonEl.tabIndex = active ? 0 : -1;
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
  const avifNote = state.avifComparisonPending ? "\nAVIF を変換中…" : "";
  els.summaryEl.textContent = `${formatText}\n品質 ${state.quality.toFixed(2)}${avifNote}`;
}

function updateMetadataNode(): void {
  const els = state.nodeEls.metadata;
  if (!els) return;
  const pipeline = state.pipeline;
  if (state.computing || !pipeline) {
    els.summaryEl.textContent = "計算中…";
    return;
  }
  els.summaryEl.textContent = metadataSummaryLines(pipeline.metadata.detail).join("\n");
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

/**
 * 出力ノード・出力カード上部の2箇所にあるダウンロードボタンを、最新のパイプライン結果へまとめて同期する
 * （計算中は disabled・href・ファイル名）。片方だけ更新し忘れて href がずれることがないよう、
 * 登録済みの全アンカーへ同じ状態を書き込む一本の関数に寄せている。
 */
function syncDownloadLinks(): void {
  const pipeline = state.pipeline;
  const objectUrl = state.outputObjectUrl;
  const anchors = [state.nodeEls.output?.downloadButtonEl, outputDetailEls.downloadButtonEl].filter(
    (el): el is HTMLAnchorElement => el != null,
  );
  // pipelineDirty の間（パラメータ変更〜再計算完了まで）は、まだ今のパラメータを反映していない
  // 古い blob を配ってしまわないよう無効化する
  const enabled = pipeline != null && objectUrl != null && !state.computing && !state.pipelineDirty;
  for (const el of anchors) {
    el.classList.toggle("pointer-events-none", !enabled);
    el.classList.toggle("opacity-50", !enabled);
    if (!enabled || !pipeline || !objectUrl) {
      el.setAttribute("aria-disabled", "true");
      // href/download が残っていると、aria-disabled でも Enter キー操作でリンクをたどれてしまう
      el.removeAttribute("href");
      el.removeAttribute("download");
      continue;
    }
    el.removeAttribute("aria-disabled");
    el.href = objectUrl;
    el.download = pipeline.output.detail.downloadName;
  }
}

/** ノード本文・エッジの太さ/ラベル・レイアウトをまとめて更新する（要素は作り直さない） */
function renderNodes(): void {
  if (!state.meta) return;
  updateOriginalNode();
  updateSizeNode();
  updateFormatNode();
  updateMetadataNode();
  updateOutputNode();
  syncDownloadLinks();
  styleEdges();
  layoutEdges();

  for (const id of STAGE_ORDER) {
    state.nodeEls[id]?.rootEl.classList.toggle("opacity-60", state.computing);
  }
}

// --- 詳細パネル -------------------------------------------------------------
// マークアップの組み立ては pipeline.ts の build*Html / *StatusText 関数に寄せ、
// ここでは innerHTML への反映（＝ DOM 固有の処理）だけを担う。各カードの操作系は
// buildXControls() が一度だけ作った持続 DOM（formatControls 等。サイズ・出力カードは
// コントロールを持たないので controls は null）が担い、ここでは
// 再計算のたびに detailPanelEl へ「controls.rootEl → 内容 div」の順で差し替えるだけ
// で、controls 要素自体は作り直さない（フォーカス・入力途中の値を失わないため）。

/** 詳細パネルの内容 div を組み立てる（innerHTML はこの使い捨て div にだけ設定する） */
function buildDetailContentEl(className: string, html: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  return el;
}

/**
 * 詳細パネルへ controls（あれば）+ content を差し込む。controls・content どちらも既に
 * 同じ要素が接続済みならそこは触らない。replaceChildren は一旦全子要素を外してから積み直す
 * ため、毎回入れ直すとフォーカス中の select/input やサイズ・フォーマットカードの行ボタンが
 * 同期的にデタッチされてフォーカスを失う。再計算のたびに同じカードを再描画するケース
 * （品質スライダー操作中の debounce recompute 等）で入力・フォーカスを落とさないための対処
 */
function renderDetailCard(controlsRootEl: HTMLElement | null, contentEl: HTMLElement): void {
  if (!controlsRootEl) {
    if (detailPanelEl.firstElementChild !== contentEl || detailPanelEl.children.length !== 1) {
      detailPanelEl.replaceChildren(contentEl);
    }
    return;
  }
  if (detailPanelEl.firstElementChild === controlsRootEl) {
    const oldContentEl = detailPanelEl.children[1];
    if (oldContentEl === contentEl) return;
    if (oldContentEl) detailPanelEl.replaceChild(contentEl, oldContentEl);
    else detailPanelEl.append(contentEl);
    return;
  }
  detailPanelEl.replaceChildren(controlsRootEl, contentEl);
}

function renderOriginalDetail(): void {
  const meta = state.meta;
  if (!meta || !state.objectUrl) return;
  const contentEl = buildDetailContentEl(
    "flex flex-col gap-4 sm:flex-row",
    `
      <img
        src="${state.objectUrl}"
        alt="読み込んだ画像のサムネイル"
        class="max-h-[140px] w-auto max-w-[200px] shrink-0 rounded border border-border object-contain"
      />
      <div class="min-w-0 flex-1">${buildOriginalDetailHtml(meta)}</div>
    `,
  );
  detailPanelEl.replaceChildren(contentEl);
}

function renderSizeDetail(): void {
  const meta = state.meta;
  const pipeline = state.pipeline;
  if (!meta) return;
  sizeDetailEls.infoEl.innerHTML = pipeline
    ? buildSizeInfoHtml(meta, pipeline.size.detail, pipeline.size.output.bytes)
    : `<p class="text-xs text-muted-foreground">計算中…</p>`;

  const rows = state.sizeLadderRows;
  sizeDetailEls.ladderStatusEl.classList.toggle("hidden", rows !== null);
  sizeDetailEls.ladderRowsEl.classList.toggle("hidden", rows === null);
  if (rows) {
    const selectedValue = state.longEdgeCap === null ? "original" : String(state.longEdgeCap);
    if (rows !== lastRenderedSizeLadderRows) {
      const focusedValue = focusedRowValue(sizeDetailEls.ladderRowsEl);
      sizeDetailEls.ladderRowsEl.innerHTML = buildSizeLadderHtml(rows, state.longEdgeCap);
      restoreRowFocus(sizeDetailEls.ladderRowsEl, focusedValue);
      lastRenderedSizeLadderRows = rows;
    } else {
      syncRowSelection(sizeDetailEls.ladderRowsEl, selectedValue);
    }
  }
  renderDetailCard(null, sizeDetailEls.rootEl);
}

function renderFormatDetail(): void {
  const pipeline = state.pipeline;
  formatDetailEls.loadingEl.classList.toggle("hidden", !!pipeline);
  formatDetailEls.comparisonRowsEl.classList.toggle("hidden", !pipeline);
  formatDetailEls.pngNoteEl.classList.toggle("hidden", !pipeline?.format.detail.qualityIgnored);
  if (!pipeline) {
    renderDetailCard(formatControls.rootEl, formatDetailEls.rootEl);
    return;
  }
  const dims = { width: pipeline.size.output.width, height: pipeline.size.output.height };
  const comparison = pipeline.format.detail.comparison;
  if (comparison !== lastRenderedFormatComparison) {
    const focusedValue = focusedRowValue(formatDetailEls.comparisonRowsEl);
    formatDetailEls.comparisonRowsEl.innerHTML = buildFormatComparisonHtml(
      comparison,
      dims,
      state.formatChoice,
      pipeline.size.output.bytes,
    );
    restoreRowFocus(formatDetailEls.comparisonRowsEl, focusedValue);
    lastRenderedFormatComparison = comparison;
  } else {
    syncRowSelection(formatDetailEls.comparisonRowsEl, state.formatChoice);
  }
  renderDetailCard(formatControls.rootEl, formatDetailEls.rootEl);
}

function renderMetadataDetail(): void {
  const controls = state.metadataControls;
  if (!controls) return;
  const pipeline = state.pipeline;
  if (!pipeline) {
    renderDetailCard(controls.rootEl, buildDetailContentEl("", `<p class="text-xs text-muted-foreground">計算中…</p>`));
    return;
  }
  const d = pipeline.metadata.detail;
  // canvas 出力で引き継げない形式（WebP/PNG/AVIF）のときだけ、セグメントチェックボックスを
  // 視覚的に disabled にする（選択状態自体は state.removeIds に残したまま触らない）
  const checkboxesDisabled = d.cameFromCanvas && d.carryUnsupported;
  controls.segListEl.querySelectorAll<HTMLInputElement>(".asshukusan-seg-checkbox").forEach((el) => {
    el.disabled = checkboxesDisabled;
  });
  const notesHtml = metadataStatusNotes(d)
    .map((note) => `<p class="text-xs text-muted-foreground">${note}</p>`)
    .join("");
  const contentEl = buildDetailContentEl(
    "flex flex-col gap-1.5",
    `
      ${buildMetadataTotalsHtml(d.removedBytes, d.keptBytes)}
      ${notesHtml}
    `,
  );
  renderDetailCard(controls.rootEl, contentEl);
}

function renderOutputDetail(): void {
  const meta = state.meta;
  const pipeline = state.pipeline;
  if (!meta || !pipeline || !state.objectUrl || !state.outputObjectUrl) {
    renderDetailCard(null, buildDetailContentEl("", `<p class="text-xs text-muted-foreground">計算中…</p>`));
    return;
  }
  outputDetailEls.infoEl.innerHTML = buildOutputInfoHtml(pipeline.output.detail);
  outputDetailEls.beforeImgEl.src = state.objectUrl;
  outputDetailEls.afterImgEl.src = state.outputObjectUrl;
  syncDownloadLinks();
  renderDetailCard(null, outputDetailEls.rootEl);
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

/**
 * フォーマット比較表の AVIF 行（pending）を、wasm エンコードが確定した時点で差し替える。
 * runPipeline 自体は AVIF の確定を待たずに解決しているため、この監視は別系統で走らせる。
 * result はパイプライン結果ごとに新しいオブジェクトなので、参照比較で古い結果からの反映を弾く。
 */
function watchAvifComparison(result: PipelineResult): void {
  const avifPending = result.format.detail.avifPending;
  if (!avifPending) {
    state.avifComparisonPending = false;
    return;
  }
  state.avifComparisonPending = true;
  avifPending
    .then((row) => {
      if (state.pipeline !== result) return;
      const comparison = result.format.detail.comparison;
      const index = comparison.findIndex((r) => r.format === "avif");
      if (index !== -1) comparison[index] = row;
      // comparison は配列オブジェクトを in-place で書き換えているため参照は変わらない。
      // 行 DOM の作り直し判定は参照比較なので、明示的に無効化しないと pending 表示のまま残る
      invalidateFormatComparisonCache();
      state.avifComparisonPending = false;
      renderNodes();
      if (state.activeStage === "format") renderDetailPanel();
    })
    .catch((error: unknown) => {
      console.error(error);
      if (state.pipeline !== result) return;
      state.avifComparisonPending = false;
      if (error instanceof UnsupportedFormatError) {
        // wasm の初期化・エンコードが実際に失敗した。以後は AVIF を「このブラウザでは書き出し不可」
        // として比較表から外し、選択中だったら「元のまま」に戻して再計算する
        if (state.support) state.support = { ...state.support, avif: false };
        const comparison = result.format.detail.comparison;
        const index = comparison.findIndex((r) => r.format === "avif");
        if (index !== -1) comparison[index] = { format: "avif", label: FORMAT_LABELS.avif, supported: false, bytes: null, delta: null };
        invalidateFormatComparisonCache();
        if (state.formatChoice === "avif") {
          state.formatChoice = "original";
          scheduleRecompute();
        }
      }
      renderNodes();
      if (state.activeStage === "format") renderDetailPanel();
    });
}

// パラメータ変更のたびに増える世代カウンタ。debounce 中・実行中にさらに変更が来たら
// 世代を進め、走行中の（もう古い）計算が終わっても結果を公開させない。「実行を1本に
// 直列化する」pipelineRunning/rerunRequested だけでは、実行中に来た変更が「今動いている
// 計算に間に合わなかった」ことを実行後まで知る術が無く、古いパラメータの結果が一瞬でも
// 表示されうる（ダウンロードリンクが古いファイルを指す事故につながる）ため、これを判定に使う
let pipelineGeneration = 0;

/**
 * 実行開始時点のパラメータで1回だけパイプラインを計算する。呼び出し側（runPipelineLoop）
 * が実行開始時に固定した `generation` を渡し、完了時点でまだ最新であれば結果を公開する。
 * 古くなっていれば公開せず rerunRequested を立て、直後の do-while が最新世代で回り直す。
 */
async function runPipelineOnce(generation: number): Promise<void> {
  const meta = state.meta;
  const image = state.image;
  const file = state.file;
  const originalArrayBuffer = state.originalArrayBuffer;
  if (!meta || !image || !file || !originalArrayBuffer) return;

  const support = state.support ?? (await supportPromise);
  state.support = support;
  // await 中に画像が差し替えられていたら、古い meta に対する計算結果は捨てる
  if (state.meta !== meta) return;

  // removeIds/exifEdits はミュータブルな Set/オブジェクトで、計算中にユーザーが
  // チェックボックスや Exif 編集欄を操作すると同じ参照の中身が変わりうる。実行開始時点の
  // 値をコピーして固定し、「走り始めた計算には走り始めた時点の設定だけを反映する」を保証する
  const removeIds = new Set(state.removeIds);
  const exifEdits = { ...state.exifEdits };

  try {
    const result = await runPipeline({
      file,
      meta,
      image,
      originalArrayBuffer,
      quality: state.quality,
      longEdgeCap: state.longEdgeCap,
      formatChoice: state.formatChoice,
      removeIds,
      exifEdits,
      support,
    });
    if (state.meta !== meta) return;
    if (generation !== pipelineGeneration) {
      // 計算中により新しいパラメータが積まれていた。この結果は公開せず次の周回に譲る
      rerunRequested = true;
      return;
    }
    state.pipeline = result;
    state.pipelineDirty = false;
    watchAvifComparison(result);
  } catch (error) {
    if (state.meta !== meta) return;
    console.error(error);
    if (error instanceof UnsupportedFormatError) {
      // このブラウザ・セッションでは AVIF の wasm エンコードが動かないと判明した。
      // 以後のフォーマット比較表からは AVIF を外し、選択中だった場合は「元のまま」に戻す
      if (state.support) state.support = { ...state.support, avif: false };
      invalidateFormatComparisonCache();
      if (state.formatChoice === "avif") state.formatChoice = "original";
      // 選択を戻した場合は state.pipeline を古いままにせず、新しい選択で計算し直す
      rerunRequested = true;
      return;
    }
    if (generation !== pipelineGeneration) {
      // 失敗した結果すら、もう古い世代のものなら状態を書き換えない（最新世代の結果を待つ）
      rerunRequested = true;
      return;
    }
    // 失敗した結果を古いパイプラインのまま出し続けるとダウンロードが古いファイルを配ってしまうため、
    // 出力を明示的に空にしてからエラーを出す
    state.pipeline = null;
    revokeOutputObjectUrl();
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
      const generation = pipelineGeneration;
      await runPipelineOnce(generation);
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
  // 実際の再計算は debounce 後だが、パラメータが変わった時点でダウンロードは即座に
  // 無効化する（見た目のちらつきより「押したら古いファイルが降ってくる」方が事故が大きい）。
  // 世代も同時に進め、いま走っている（もう古い）計算がこの後で終わっても公開されないようにする
  pipelineGeneration++;
  state.pipelineDirty = true;
  syncDownloadLinks();
  if (debounceHandle !== undefined) clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    runPipelineLoop().catch((error: unknown) => console.error(error));
  }, DEBOUNCE_MS);
}

// --- ファイル読み込み ---------------------------------------------------------
// ドラッグ&ドロップ・貼り付け・input change・サンプル生成のいずれも handleFileSelected を
// 経由する。連投（複数ファイルを続けて選ぶ、貼り付け直後にもう1枚 drop する等）されたときに
// 遅い方の await が先に完了した選択を上書きしてしまわないよう、世代カウンタで判定する。
// 世代は「取り込みが始まった瞬間」に進める。MIME 不正で弾く場合も含めて必ず進めることで、
// 直前に走っていた（まだ有効な）読み込みが後から来たこの取り込みに気づいて自分を古いと
// 判定できるようにする（無効なファイルを選んだせいで、その前の有効な読み込みと状態が
// 二重に競合するのを防ぐ）。

let loadGeneration = 0;

/** 取り込み開始時点で世代を進めて払い出す。サンプル生成のように非同期の間を挟む
 * 呼び出し元は、この時点のトークンを保持して後から handleFileSelected へ渡す */
function nextLoadGeneration(): number {
  loadGeneration++;
  return loadGeneration;
}

async function handleFileSelected(file: File, generation: number = nextLoadGeneration()): Promise<void> {
  const myGeneration = generation;
  const isStale = (): boolean => myGeneration !== loadGeneration;

  if (!file.type.startsWith("image/")) {
    showError("画像ファイルを選択してください。");
    return;
  }
  clearError();

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    if (isStale()) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    const meta = await extractMetadata(file, image);
    if (isStale()) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    const originalArrayBuffer = await file.arrayBuffer();
    if (isStale()) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    const support = state.support ?? (await supportPromise);
    if (isStale()) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    state.support = support;

    // メタデータのセグメント一覧・Exif タグは画像ごとに固定なので、パイプラインとは独立に
    // ここで一度だけ求める（メタデータカードのコントロール DOM を組み立てる元データ）。
    // JPEG の APP1 Exif・PNG の eXIf チャンクのどちらも extractExifPayload が同じ形の payload に揃えて返す。
    //
    // 新しい画像の派生データ（meta/originalArrayBuffer/support に加えてこれら）が揃うまでは、
    // 旧オブジェクト URL をまだ破棄しない。ここより前で例外が起きても旧 state はそのまま
    // 有効なままにし、「旧 URL は破棄済みだが state はまだ旧画像のまま」という中間状態を
    // 作らないため（そうなると旧画像のサムネイル等が壊れた URL を指すことになる）
    const metadataScan = scanMetadata(originalArrayBuffer, meta.sniffedFormat);
    const exifPayload = extractExifPayload(originalArrayBuffer, meta.sniffedFormat, metadataScan);
    const exifStructure = exifPayload ? parseExifStructure(exifPayload) : null;
    const exifTags = exifPayload && exifStructure ? readExifTags(exifPayload, exifStructure) : null;

    // ここまでで新しい画像の派生データが揃った。以降は旧オブジェクト URL の破棄と
    // state の入れ替えを同期的に一括で行う
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
    state.removeIds = defaultRemoveIds(metadataScan);
    state.exifEdits = { removeGps: exifTags?.hasGps ?? false };
    state.metadataScan = metadataScan;
    state.exifTags = exifTags;
    state.activeStage = "original";
    state.pipeline = null;
    state.pipelineDirty = true;
    // 新しい画像の読み込みは常に最新世代として扱う（この後すぐ runPipelineLoop を直接呼ぶため）
    pipelineGeneration++;
    state.avifComparisonPending = false;
    state.sizeLadderCache = new Map();
    state.sizeLadderRows = null;
    formatControls.qualityInputEl.value = "0.8";
    formatControls.qualityValueEl.textContent = "0.80";
    // 画像が変われば旧画像の行データへの参照は必ず捨てる。新しい行データは同じ品質でも
    // 別配列として計算し直されるので参照比較で自然に検知されるが、画像切り替えの最初の
    // 描画で確実に作り直させるためここでも明示的にリセットしておく
    lastRenderedSizeLadderRows = null;
    lastRenderedFormatComparison = null;
    state.metadataControls = buildMetadataControls(metadataScan, exifTags, originalArrayBuffer);

    resultSectionEl.classList.remove("hidden");
    resultSectionEl.classList.add("flex");

    buildPipelineNodes(meta, support);
    setActiveStage("original");
    renderNodes();
    runPipelineLoop().catch((error: unknown) => console.error(error));
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    if (isStale()) return;
    console.error(error);
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
  // generateSampleFile() 自体が非同期（canvas エンコード）のため、世代はクリックした
  // この瞬間（取り込みの開始）に確保し、生成が終わってから handleFileSelected へ渡す。
  // ここで確保しないと、生成中に別のファイルが先に読み込まれても世代が追いつかず、
  // 後から出来上がったサンプル画像がそれを上書きしてしまう
  const generation = nextLoadGeneration();
  sampleButtonEl.disabled = true;
  sampleButtonEl.textContent = "生成中…";
  generateSampleFile()
    .then((file) => handleFileSelected(file, generation))
    .catch((error: unknown) => {
      console.error(error);
      showError("サンプル画像の生成に失敗しました。");
    })
    .finally(() => {
      sampleButtonEl.disabled = false;
      sampleButtonEl.textContent = "サンプル画像で試す";
    });
});

formatControls.qualityInputEl.addEventListener("input", () => {
  setQuality(Number.parseFloat(formatControls.qualityInputEl.value));
});

window.addEventListener("resize", () => {
  if (!state.meta) return;
  layoutNodes();
  layoutEdges();
});
