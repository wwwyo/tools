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
}

export interface FormatStageDetail {
  passthrough: boolean;
  chosenLabel: string;
  comparison: FormatComparisonRow[];
  qualityIgnored: boolean;
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

const COMPARISON_FORMATS: readonly OutputFormat[] = ["jpeg", "webp", "png", "avif"];

async function computeFormatStage(
  params: PipelineParams,
  sizeOutput: StageBlob,
): Promise<{ output: StageBlob; detail: FormatStageDetail }> {
  const { image, quality, longEdgeCap, formatChoice, support } = params;

  // 比較表は選択中の出力形式に関わらず、対応している全形式分を都度求める。
  // Promise.all にはせず1件ずつ await する（サイズ段と同じ理由でメモリを一気に食わないため）
  const comparison: FormatComparisonRow[] = [];
  for (const format of COMPARISON_FORMATS) {
    const supported = isFormatSupported(format, support);
    if (!supported) {
      comparison.push({ format, label: FORMAT_LABELS[format], supported: false, bytes: null, delta: null });
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

  if (formatChoice === "original") {
    return {
      output: sizeOutput,
      detail: {
        passthrough: true,
        chosenLabel: currentFormatLabel(sizeOutput.format, params.meta.ext),
        comparison,
        qualityIgnored: false,
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
      chosenLabel: FORMAT_LABELS[formatChoice],
      comparison,
      qualityIgnored: formatChoice === "png",
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


/** フォーマットノードの拡張子ごとの圧縮率比較表 */
export function buildFormatComparisonHtml(comparison: FormatComparisonRow[]): string {
  return comparison
    .map((row) => {
      const bytesText = row.supported ? formatBytes(row.bytes ?? 0) : "このブラウザでは書き出し不可";
      const deltaText = row.supported ? row.delta : "—";
      return `<div class="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-b-0">
        <span class="text-muted-foreground">${row.label}</span>
        <span class="font-mono text-xs text-foreground">${bytesText}</span>
        <span class="w-14 shrink-0 text-right font-mono text-xs font-semibold text-primary">${deltaText}</span>
      </div>`;
    })
    .join("");
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
