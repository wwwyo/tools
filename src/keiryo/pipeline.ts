/**
 * パイプライン各ノードの計算ロジック。DOM を持たない純粋計算に寄せ、main.ts からは
 * 「今の設定一式を渡して結果一式を受け取る」形でだけ呼ぶ。
 *
 * 各ノードは前ノードのバイト列を積み上げて再利用するのではなく、必要な出力を
 * 元画像（HTMLImageElement）+ 長辺上限 + 品質から都度 canvas 再エンコードして求める。
 * ノードをまたいで canvas を使い回すと「このノード単体で何が起きているか」を
 * 追うのに前段の内部状態を知る必要が出るため、多少の再計算コストと引き換えに
 * ノードごとの独立性を優先した（PoC 規模の画像サイズでは体感できる差にならない）。
 */

import { basenameNoExt, formatBytes, type ImageMeta } from "./imageMeta";
import {
  computeTargetDims,
  encodeImage,
  extensionFor,
  type EncodeResult,
  type OutputFormat,
  type ProbedFormat,
} from "./encode";
import { scanMetadata, stripMetadata, type MetadataScanResult } from "./metadataStrip";

/** 元ファイルの実形式から、そのまま同形式で再エンコードする際に使う出力形式へ落とす */
const SNIFFED_TO_REENCODE_FORMAT: Record<string, OutputFormat> = {
  JPEG: "jpeg",
  PNG: "png",
  WebP: "webp",
};

function originalReencodeFormat(sniffedFormat: string): OutputFormat {
  return SNIFFED_TO_REENCODE_FORMAT[sniffedFormat] ?? "jpeg";
}

/** JPEG・PNG は常にブラウザが書き出せる前提とし、probe 対象は非可逆の WebP / AVIF のみ */
export function isFormatSupported(format: OutputFormat, support: Record<ProbedFormat, boolean>): boolean {
  if (format === "jpeg" || format === "png") return true;
  return support[format as ProbedFormat] ?? false;
}

export function formatDelta(size: number, baseBytes: number): string {
  if (baseBytes === 0) return "±0%";
  const delta = Math.round((1 - size / baseBytes) * 100);
  if (delta === 0) return "±0%";
  return delta > 0 ? `−${delta}%` : `+${Math.abs(delta)}%`;
}

/** 出力形式の選択。「元のまま」はサイズ段の結果を素通しする特別値 */
export type FormatChoice = OutputFormat | "original";

/** 現在パイプラインを流れているバイト列がどの形式かの表現。"original" は元ファイルのバイト列そのもの */
export type CurrentFormat = OutputFormat | "original";

export interface StageBlob {
  blob: Blob;
  bytes: number;
  width: number;
  height: number;
  /** canvas 再エンコードを経て生成されたか（true なら Exif 等のメタデータは既に失われている） */
  fromCanvas: boolean;
  format: CurrentFormat;
}

export interface PipelineParams {
  file: File;
  meta: ImageMeta;
  image: HTMLImageElement;
  originalArrayBuffer: ArrayBuffer;
  quality: number;
  longEdgeCap: number | null;
  formatChoice: FormatChoice;
  stripMetadataEnabled: boolean;
  support: Record<ProbedFormat, boolean>;
}

export interface SizeStageDetail {
  passthrough: boolean;
  beforeWidth: number;
  beforeHeight: number;
  afterWidth: number;
  afterHeight: number;
  scale: number;
  beforeMegapixels: string;
  afterMegapixels: string;
  quality: number;
  reencodeFormat: OutputFormat | null;
}

export interface FormatComparisonRow {
  format: OutputFormat;
  label: string;
  supported: boolean;
  bytes: number | null;
  delta: string | null;
  /** AVIF は wasm エンコードに数秒かかるため、確定するまでこの行だけ「変換中」で先に表示する */
  pending?: boolean;
}

export interface FormatStageDetail {
  passthrough: boolean;
  /** フォーマット段に入ってきた時点の形式ラベル（ノードの「JPEG → WebP」表示の左側に使う） */
  fromLabel: string;
  chosenLabel: string;
  /** 比較表で「今これ」を強調する行の判定に使う（passthrough でも元の実形式にマップして1行は必ず光らせる） */
  highlightFormat: OutputFormat;
  comparison: FormatComparisonRow[];
  qualityIgnored: boolean;
  /** comparison の AVIF 行が pending のときだけ非 null。解決すると確定行が届く（呼び出し側が comparison を差し替える） */
  avifPending: Promise<FormatComparisonRow> | null;
}

export interface MetadataStageDetail {
  scan: MetadataScanResult;
  cameFromCanvas: boolean;
  strippedApplied: boolean;
  webpUnsupported: boolean;
  toggleOn: boolean;
}

export interface OutputStageDetail {
  width: number;
  height: number;
  format: CurrentFormat;
  formatLabel: string;
  bytes: number;
  originalBytes: number;
  downloadName: string;
}

export interface PipelineResult {
  originalBytes: number;
  size: { output: StageBlob; detail: SizeStageDetail };
  format: { output: StageBlob; detail: FormatStageDetail };
  metadata: { output: StageBlob; detail: MetadataStageDetail };
  output: { output: StageBlob; detail: OutputStageDetail };
}

export const FORMAT_LABELS: Record<OutputFormat, string> = {
  jpeg: "JPEG",
  webp: "WebP",
  avif: "AVIF",
  png: "PNG",
};

function currentFormatLabel(format: CurrentFormat, ext: string): string {
  return format === "original" ? `元の形式 (.${ext})` : FORMAT_LABELS[format];
}

async function computeSizeStage(params: PipelineParams): Promise<{ output: StageBlob; detail: SizeStageDetail }> {
  const { file, meta, image, quality, longEdgeCap } = params;
  const beforeMegapixels = ((image.naturalWidth * image.naturalHeight) / 1_000_000).toFixed(2);

  if (longEdgeCap == null) {
    return {
      output: {
        blob: file,
        bytes: file.size,
        width: image.naturalWidth,
        height: image.naturalHeight,
        fromCanvas: false,
        format: "original",
      },
      detail: {
        passthrough: true,
        beforeWidth: image.naturalWidth,
        beforeHeight: image.naturalHeight,
        afterWidth: image.naturalWidth,
        afterHeight: image.naturalHeight,
        scale: 1,
        beforeMegapixels,
        afterMegapixels: beforeMegapixels,
        quality,
        reencodeFormat: null,
      },
    };
  }

  const reencodeFormat = originalReencodeFormat(meta.sniffedFormat);
  const result = await encodeImage(image, { format: reencodeFormat, quality, longEdgeCap });
  const afterMegapixels = ((result.width * result.height) / 1_000_000).toFixed(2);
  const dims = computeTargetDims(image.naturalWidth, image.naturalHeight, longEdgeCap);

  return {
    output: {
      blob: result.blob,
      bytes: result.blob.size,
      width: result.width,
      height: result.height,
      fromCanvas: true,
      format: reencodeFormat,
    },
    detail: {
      passthrough: false,
      beforeWidth: image.naturalWidth,
      beforeHeight: image.naturalHeight,
      afterWidth: dims.width,
      afterHeight: dims.height,
      scale: dims.width / image.naturalWidth,
      beforeMegapixels,
      afterMegapixels,
      quality,
      reencodeFormat,
    },
  };
}

// AVIF を最後に置くのは表示上の意味だけでなく、逐次 await するこの後の実装が
// 「他形式を先に確定させてから AVIF に着手する」順序を保証するためでもある
const COMPARISON_FORMATS: readonly OutputFormat[] = ["jpeg", "webp", "png", "avif"];

/** AVIF の wasm エンコード結果。比較表の確定行と、選択出力用の blob/寸法を両方持つ */
interface AvifEncodeOutcome {
  row: FormatComparisonRow;
  result: EncodeResult;
}

async function computeFormatStage(
  params: PipelineParams,
  sizeOutput: StageBlob,
): Promise<{ output: StageBlob; detail: FormatStageDetail }> {
  const { image, quality, longEdgeCap, formatChoice, support } = params;

  // 比較表は選択中の出力形式に関わらず、対応している全形式分を都度求める。
  // Promise.all にはせず1件ずつ await する（サイズ段と同じ理由でメモリを一気に食わないため）。
  // ただし AVIF だけは wasm エンコードが 1600px で数秒かかり、他の行を待たせたくないため
  // ここでは encode を投げっぱなしにし、pending 行を積んでこのステージ自体は先に確定させる。
  const comparison: FormatComparisonRow[] = [];
  let avifOutcomePromise: Promise<AvifEncodeOutcome> | null = null;
  for (const format of COMPARISON_FORMATS) {
    const supported = isFormatSupported(format, support);
    if (!supported) {
      comparison.push({ format, label: FORMAT_LABELS[format], supported: false, bytes: null, delta: null });
      continue;
    }
    if (format === "avif") {
      comparison.push({ format, label: FORMAT_LABELS[format], supported: true, bytes: null, delta: null, pending: true });
      avifOutcomePromise = encodeImage(image, { format, quality, longEdgeCap }).then((result) => ({
        result,
        row: {
          format,
          label: FORMAT_LABELS[format],
          supported: true,
          bytes: result.blob.size,
          delta: formatDelta(result.blob.size, sizeOutput.bytes),
        },
      }));
      continue;
    }
    const result = await encodeImage(image, { format, quality, longEdgeCap });
    comparison.push({
      format,
      label: FORMAT_LABELS[format],
      supported: true,
      bytes: result.blob.size,
      delta: formatDelta(result.blob.size, sizeOutput.bytes),
    });
  }
  const avifPending = avifOutcomePromise ? avifOutcomePromise.then((outcome) => outcome.row) : null;

  // 比較表で光らせる行。「元のまま」でも sizeOutput の実形式（素通しなら sniff 結果）に
  // マップし、必ずどこかの行が「今これ」を指すようにする
  const highlightFormat: OutputFormat =
    formatChoice === "original"
      ? sizeOutput.format === "original"
        ? originalReencodeFormat(params.meta.sniffedFormat)
        : sizeOutput.format
      : formatChoice;

  const fromLabel = currentFormatLabel(sizeOutput.format, params.meta.ext);

  if (formatChoice === "original") {
    return {
      output: sizeOutput,
      detail: {
        passthrough: true,
        fromLabel,
        chosenLabel: fromLabel,
        highlightFormat,
        comparison,
        qualityIgnored: false,
        avifPending,
      },
    };
  }

  if (formatChoice === "avif") {
    if (!avifOutcomePromise) throw new Error("AVIF は書き出せません");
    // 比較表用に投げた encode をそのまま選択出力にも使い回す（同じ quality/longEdgeCap なので二重エンコードを避ける）
    const outcome = await avifOutcomePromise;
    return {
      output: {
        blob: outcome.result.blob,
        bytes: outcome.row.bytes ?? outcome.result.blob.size,
        width: outcome.result.width,
        height: outcome.result.height,
        fromCanvas: true,
        format: "avif",
      },
      detail: {
        passthrough: false,
        fromLabel,
        chosenLabel: FORMAT_LABELS.avif,
        highlightFormat,
        comparison,
        qualityIgnored: false,
        avifPending,
      },
    };
  }

  const chosenRow = comparison.find((row) => row.format === formatChoice);
  const result = await encodeImage(image, { format: formatChoice, quality, longEdgeCap });
  return {
    output: {
      blob: result.blob,
      bytes: chosenRow?.bytes ?? result.blob.size,
      width: result.width,
      height: result.height,
      fromCanvas: true,
      format: formatChoice,
    },
    detail: {
      passthrough: false,
      fromLabel,
      chosenLabel: FORMAT_LABELS[formatChoice],
      highlightFormat,
      comparison,
      qualityIgnored: formatChoice === "png",
      avifPending,
    },
  };
}

async function computeMetadataStage(
  params: PipelineParams,
  formatOutput: StageBlob,
): Promise<{ output: StageBlob; detail: MetadataStageDetail }> {
  const { meta, originalArrayBuffer, stripMetadataEnabled } = params;
  const scan = scanMetadata(originalArrayBuffer, meta.sniffedFormat);

  if (formatOutput.fromCanvas) {
    // canvas 再エンコードを経た時点でメタデータは既に失われている。再度削る操作は不要
    return {
      output: formatOutput,
      detail: {
        scan,
        cameFromCanvas: true,
        strippedApplied: false,
        webpUnsupported: false,
        toggleOn: stripMetadataEnabled,
      },
    };
  }

  if (!stripMetadataEnabled) {
    return {
      output: formatOutput,
      detail: { scan, cameFromCanvas: false, strippedApplied: false, webpUnsupported: false, toggleOn: false },
    };
  }

  const stripped = stripMetadata(originalArrayBuffer, meta.sniffedFormat);
  if (stripped === null) {
    // WebP は RIFF サイズ / VP8X flags の再計算が必要で安全にロスレス除去できないため未対応のまま通す
    return {
      output: formatOutput,
      detail: { scan, cameFromCanvas: false, strippedApplied: false, webpUnsupported: true, toggleOn: true },
    };
  }

  const strippedBlob = new Blob([stripped], { type: formatOutput.blob.type });
  return {
    output: { ...formatOutput, blob: strippedBlob, bytes: strippedBlob.size },
    detail: { scan, cameFromCanvas: false, strippedApplied: true, webpUnsupported: false, toggleOn: true },
  };
}

function computeOutputStage(params: PipelineParams, metadataOutput: StageBlob): { output: StageBlob; detail: OutputStageDetail } {
  const ext = metadataOutput.format === "original" ? params.meta.ext : extensionFor(metadataOutput.format);
  return {
    output: metadataOutput,
    detail: {
      width: metadataOutput.width,
      height: metadataOutput.height,
      format: metadataOutput.format,
      formatLabel: currentFormatLabel(metadataOutput.format, params.meta.ext),
      bytes: metadataOutput.bytes,
      originalBytes: params.meta.bytes,
      downloadName: `${basenameNoExt(params.meta.fileName)}.${ext}`,
    },
  };
}

/** パイプライン全段を直列に計算する。途中の失敗はそのまま呼び出し側へ投げる */
export async function runPipeline(params: PipelineParams): Promise<PipelineResult> {
  const size = await computeSizeStage(params);
  const format = await computeFormatStage(params, size.output);
  const metadata = await computeMetadataStage(params, format.output);
  const output = computeOutputStage(params, metadata.output);
  return { originalBytes: params.meta.bytes, size, format, metadata, output };
}

// --- サイズノードの what-if 比較（長辺ラダー） ---------------------------------
// パイプライン本体の longEdgeCap とは独立に「同じ品質・同じ元フォーマットのまま
// 長辺だけ動かしたらどうなるか」を5段まとめて計算する。呼び出し側（main.ts）が
// サイズノード選択時にだけ呼び、(品質) をキーにキャッシュして再選択時の再計算を避ける
// （元フォーマットは画像ごとに固定なのでキーに含めなくても衝突しない）。

export interface SizeLadderRow {
  cap: number | null;
  label: string;
  width: number;
  height: number;
  bytes: number;
}

const SIZE_LADDER_STEPS: readonly { cap: number | null; label: string }[] = [
  { cap: null, label: "原寸" },
  { cap: 2048, label: "2048px" },
  { cap: 1600, label: "1600px" },
  { cap: 1200, label: "1200px" },
  { cap: 800, label: "800px" },
];

/** 長辺ラダーの各段を、元と同じフォーマット・現在の品質で逐次エンコードする */
export async function computeSizeLadder(
  image: HTMLImageElement,
  meta: ImageMeta,
  quality: number,
): Promise<SizeLadderRow[]> {
  const format = originalReencodeFormat(meta.sniffedFormat);
  const rows: SizeLadderRow[] = [];
  for (const step of SIZE_LADDER_STEPS) {
    const result = await encodeImage(image, { format, quality, longEdgeCap: step.cap });
    rows.push({ cap: step.cap, label: step.label, width: result.width, height: result.height, bytes: result.blob.size });
  }
  return rows;
}

// --- 比較テーブルの棒グラフ行（フォーマット比較・サイズラダー共通） -------------------

interface BarRow {
  label: string;
  dims: string;
  bytes: number | null;
  delta: string | null;
  supported: boolean;
  highlighted: boolean;
  /** 最大行に対する比率（0〜1）。scaleX の transform に使う */
  scale: number;
  /** AVIF の wasm エンコードが完了していない間だけ true */
  pending?: boolean;
}

/** label | 寸法(mono) | 容量(mono) | 差分%(mono, primary) | 比例バー の1行を組み立てる */
function buildBarRowHtml(row: BarRow): string {
  const highlightClass = row.highlighted ? " bg-muted/60" : "";
  if (row.pending) {
    return (
      `<div class="flex items-center gap-3 rounded px-1.5 py-1.5 text-sm${highlightClass}">` +
      `<span class="w-16 shrink-0 font-semibold text-foreground">${row.label}</span>` +
      `<span class="flex-1 text-xs text-muted-foreground">AVIF を変換中…</span>` +
      `</div>`
    );
  }
  if (!row.supported) {
    return (
      `<div class="flex items-center gap-3 rounded px-1.5 py-1.5 text-sm${highlightClass}">` +
      `<span class="w-16 shrink-0 font-semibold text-foreground">${row.label}</span>` +
      `<span class="flex-1 text-xs text-muted-foreground">このブラウザでは書き出し不可</span>` +
      `</div>`
    );
  }
  return (
    `<div class="flex items-center gap-3 rounded px-1.5 py-1.5 text-sm${highlightClass}">` +
    `<span class="w-16 shrink-0 font-semibold text-foreground">${row.label}</span>` +
    `<span class="w-24 shrink-0 font-mono text-xs text-muted-foreground">${row.dims}</span>` +
    `<span class="w-16 shrink-0 font-mono text-xs text-muted-foreground">${row.bytes != null ? formatBytes(row.bytes) : "—"}</span>` +
    `<span class="w-14 shrink-0 text-right font-mono text-xs font-semibold text-primary">${row.delta ?? "±0%"}</span>` +
    `<div class="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-muted">` +
    `<div class="keiryo-bar-fill h-full w-full rounded-full bg-primary" style="transform: scaleX(${row.scale.toFixed(4)});"></div>` +
    `</div>` +
    `</div>`
  );
}

/** フォーマット比較表（JPEG/WebP/PNG/AVIF）を棒グラフ行として組み立てる */
export function buildFormatComparisonHtml(
  comparison: FormatComparisonRow[],
  dims: { width: number; height: number },
  highlightFormat: OutputFormat,
): string {
  const maxBytes = Math.max(0, ...comparison.filter((row) => row.supported && row.bytes != null).map((row) => row.bytes as number));
  const rows: BarRow[] = comparison.map((row) => ({
    label: row.label,
    dims: `${dims.width}×${dims.height}`,
    bytes: row.bytes,
    delta: row.delta,
    supported: row.supported,
    highlighted: row.format === highlightFormat,
    scale: row.supported && row.bytes != null && maxBytes > 0 ? row.bytes / maxBytes : 0,
    pending: row.pending,
  }));
  return rows.map(buildBarRowHtml).join("");
}

/** サイズラダー（原寸/2048/1600/1200/800）を棒グラフ行として組み立てる。差分は原寸基準 */
export function buildSizeLadderHtml(rows: SizeLadderRow[], selectedCap: number | null): string {
  const baseBytes = rows[0]?.bytes ?? 0;
  const maxBytes = Math.max(0, ...rows.map((row) => row.bytes));
  const barRows: BarRow[] = rows.map((row) => ({
    label: row.label,
    dims: `${row.width}×${row.height}`,
    bytes: row.bytes,
    delta: formatDelta(row.bytes, baseBytes),
    supported: true,
    highlighted: row.cap === selectedCap,
    scale: maxBytes > 0 ? row.bytes / maxBytes : 0,
  }));
  return barRows.map(buildBarRowHtml).join("");
}

// --- 詳細パネルの HTML 組み立て ---------------------------------------------
// DOM 操作（innerHTML への代入・イベント登録）は main.ts 側の責務として残し、
// ここでは値からマークアップ文字列を組み立てるところまでを担う。

function detailRowHtml(label: string, value: string): string {
  return (
    `<div class="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-b-0">` +
    `<span class="text-muted-foreground">${label}</span>` +
    `<span class="font-mono text-xs text-foreground">${value}</span>` +
    `</div>`
  );
}

/** 元画像ノードの検品テーブル */
export function buildOriginalDetailHtml(m: ImageMeta): string {
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
  const rowsHtml = rows.map(([label, value]) => detailRowHtml(label, value)).join("");
  const warningHtml = m.mismatch
    ? `<div class="flex items-baseline justify-between gap-3 py-1.5 text-sm">` +
      `<span class="text-destructive">警告</span>` +
      `<span class="text-xs text-destructive">拡張子(${m.extFormat})と実形式(${m.sniffedFormat})が不一致</span>` +
      `</div>`
    : "";
  return rowsHtml + warningHtml;
}

const LONG_EDGE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "", label: "なし" },
  { value: "2048", label: "2048px" },
  { value: "1600", label: "1600px" },
  { value: "1200", label: "1200px" },
  { value: "800", label: "800px" },
];

/** 長辺の上限 select の <option> 一覧。画像の長辺以上の値は disabled にする */
export function buildLongEdgeOptionsHtml(meta: ImageMeta, longEdgeCap: number | null): string {
  const longEdge = Math.max(meta.width, meta.height);
  return LONG_EDGE_OPTIONS.map((opt) => {
    const disabled = opt.value !== "" && Number(opt.value) >= longEdge;
    const selected = (longEdgeCap?.toString() ?? "") === opt.value;
    return `<option value="${opt.value}"${disabled ? " disabled" : ""}${selected ? " selected" : ""}>${opt.label}</option>`;
  }).join("");
}

/** サイズノードの寸法・縮小率・画素数・容量の情報テーブル */
export function buildSizeInfoHtml(meta: ImageMeta, detail: SizeStageDetail, afterBytes: number): string {
  const rows =
    detailRowHtml("寸法", `${detail.beforeWidth}×${detail.beforeHeight} → ${detail.afterWidth}×${detail.afterHeight}`) +
    detailRowHtml("縮小率", `${(detail.scale * 100).toFixed(0)}%`) +
    detailRowHtml("画素数", `${detail.beforeMegapixels} MP → ${detail.afterMegapixels} MP`) +
    detailRowHtml("容量", `${formatBytes(meta.bytes)} → ${formatBytes(afterBytes)}`);
  const note = detail.passthrough
    ? ""
    : `<p class="pt-1 text-xs text-muted-foreground">品質 ${detail.quality.toFixed(2)} で ${
        detail.reencodeFormat ? FORMAT_LABELS[detail.reencodeFormat] : ""
      } として再エンコードしています。可逆な縮小はできないため、縮小しただけでもバイト数は変わります。</p>`;
  return rows + note;
}


/** メタデータノードのセグメント一覧 */
export function buildMetadataSegmentsHtml(scan: MetadataScanResult): string {
  if (scan.segments.length === 0) {
    return `<p class="py-1 text-xs text-muted-foreground">検出されたメタデータセグメントはありません。</p>`;
  }
  return scan.segments
    .map(
      (seg) =>
        `<div class="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 text-sm last:border-b-0">
          <span class="text-muted-foreground">${seg.name}</span>
          <span class="font-mono text-xs text-foreground">${formatBytes(seg.bytes)}</span>
        </div>`,
    )
    .join("");
}

/** メタデータノードの状態説明文。分岐の意味は computeMetadataStage 側のコメント参照 */
export function metadataStatusText(detail: MetadataStageDetail): string {
  if (detail.cameFromCanvas) {
    return "サイズ・フォーマット段で再エンコード済みのため、この段では既にメタデータが失われています。";
  }
  if (!detail.toggleOn) return "トグルを切ったため、元のメタデータをそのまま保持します。";
  if (detail.webpUnsupported) {
    return "WebP の除去は未対応です（RIFF サイズと VP8X flags の再計算が必要で、安全にロスレス除去できないため）。";
  }
  if (detail.strippedApplied) return "元ファイルのバイト列からメタデータセグメントのみをロスレスに読み飛ばして除去しました。";
  return "";
}

/** 出力ノードの寸法・形式・容量の情報テーブル */
export function buildOutputInfoHtml(detail: OutputStageDetail): string {
  return (
    detailRowHtml("寸法", `${detail.width}×${detail.height}`) +
    detailRowHtml("形式", detail.formatLabel) +
    detailRowHtml(
      "容量",
      `元 ${formatBytes(detail.originalBytes)} → ${formatBytes(detail.bytes)}（${formatDelta(detail.bytes, detail.originalBytes)}）`,
    )
  );
}
