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
import {
  scanMetadata,
  stripMetadata,
  insertJpegSegments,
  pngChunkDataRange,
  patchPngChunkData,
  segmentDescription,
  segmentContentPreview,
  type MetadataScanResult,
  type MetadataSegment,
} from "./metadataStrip";
import { applyExifEdits, EXIF_PAYLOAD_HEADER, type ExifEdits } from "./exif";

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
  /** 除去するメタデータセグメントの id（metadataStrip.ts の MetadataSegment.id）一式 */
  removeIds: Set<string>;
  exifEdits: ExifEdits;
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
  comparison: FormatComparisonRow[];
  qualityIgnored: boolean;
  /** comparison の AVIF 行が pending のときだけ非 null。解決すると確定行が届く（呼び出し側が comparison を差し替える） */
  avifPending: Promise<FormatComparisonRow> | null;
}

export interface MetadataStageDetail {
  scan: MetadataScanResult;
  /** サイズ・フォーマット段で canvas 再エンコードが起きたか（true なら元セグメントは blob から失われている） */
  cameFromCanvas: boolean;
  /** この段を出た時点の形式 */
  outputFormat: CurrentFormat;
  /** ユーザーが「除去」を選んだセグメントの合計バイト数 */
  removedBytes: number;
  /** 除去せず残す（保持する）セグメントの合計バイト数 */
  keptBytes: number;
  /** canvas 出力（JPEG）へ Exif/XMP/COM を再挿入できたか */
  carried: boolean;
  /** canvas 出力だが WebP/PNG/AVIF のため引き継げないケース */
  carryUnsupported: boolean;
  gpsRemoved: boolean;
  /** canvas 出力への再挿入時は常に true（drawImage で向きは既に反映済みのため 1 に強制する） */
  orientationForcedTo1: boolean;
  /** ICC プロファイルが保持されなかったか（canvas 出力は常に true。ロスレス経路ではユーザー選択次第） */
  iccDropped: boolean;
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

// --- AVIF エンコードの直列化・世代管理 ---------------------------------------
// 品質スライダーをドラッグ中など、AVIF の wasm エンコード（1600px 級で数秒かかる）が
// 終わらないうちに次のリクエストが積み上がると、未解決の bitmap/ImageData を抱えたまま
// 並行実行数だけ増えていく。ここでは「実行中は1本だけ」「その間に来たリクエストは
// 最新の1件だけを覚えておき、今の実行が終わってから改めて1回だけ走らせる」形で
// trailing-edge に間引く。古い世代（既に上書きされたリクエスト）の結果は使わずに捨てる
let avifGeneration = 0;
let avifRunning = false;
interface AvifJob {
  image: HTMLImageElement;
  opts: { format: "avif"; quality: number; longEdgeCap: number | null };
  sizeBytes: number;
  generation: number;
  resolve: (outcome: AvifEncodeOutcome) => void;
  reject: (error: unknown) => void;
}
let avifQueuedJob: AvifJob | null = null;

function runAvifQueue(): void {
  if (avifRunning) return;
  const job = avifQueuedJob;
  if (!job) return;
  avifQueuedJob = null;
  avifRunning = true;
  encodeImage(job.image, job.opts)
    .then((result) => {
      if (job.generation !== avifGeneration) {
        job.reject(new Error("stale AVIF request"));
        return;
      }
      job.resolve({
        result,
        row: {
          format: "avif",
          label: FORMAT_LABELS.avif,
          supported: true,
          bytes: result.blob.size,
          delta: formatDelta(result.blob.size, job.sizeBytes),
        },
      });
    })
    .catch((error: unknown) => job.reject(error))
    .finally(() => {
      avifRunning = false;
      runAvifQueue();
    });
}

/**
 * AVIF の wasm エンコードを1本だけ走らせる。呼び出し中に新しい quality/longEdgeCap で
 * 呼ばれ直したときは、保留中だった古いリクエストをキューから外して最新のものに差し替える
 * （古いリクエストの Promise は reject され、呼び出し側の runPipelineOnce は既に次の
 * pipeline 実行に進んでいるため実害はない）。
 */
function scheduleAvifEncode(
  image: HTMLImageElement,
  opts: { format: "avif"; quality: number; longEdgeCap: number | null },
  sizeBytes: number,
): Promise<AvifEncodeOutcome> {
  avifGeneration++;
  const generation = avifGeneration;
  const previousQueued = avifQueuedJob;
  return new Promise<AvifEncodeOutcome>((resolve, reject) => {
    previousQueued?.reject(new Error("superseded by a newer AVIF request"));
    avifQueuedJob = { image, opts, sizeBytes, generation, resolve, reject };
    runAvifQueue();
  });
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
      avifOutcomePromise = scheduleAvifEncode(image, { format, quality, longEdgeCap }, sizeOutput.bytes);
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

  const fromLabel = currentFormatLabel(sizeOutput.format, params.meta.ext);

  if (formatChoice === "original") {
    return {
      output: sizeOutput,
      detail: {
        passthrough: true,
        fromLabel,
        chosenLabel: fromLabel,
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
      comparison,
      qualityIgnored: formatChoice === "png",
      avifPending,
    },
  };
}

/** JPEG 出力へ再挿入する対象になりうるセグメント名。ICC はここに含めない（canvas 出力は常に sRGB のため） */
const CARRY_SEGMENT_NAMES = new Set(["APP1 Exif", "APP1 XMP", "COM"]);

/**
 * 元バッファのコピーへ、残す（除去しない）Exif セグメントがあれば固定長編集を in-place で
 * 焼き込む。編集はサイズを変えないため、以降 scan.segments の start/end はそのまま使い回せる。
 * 対象の Exif セグメントが無ければ元バッファをそのまま返す（コピー不要）。
 *
 * JPEG の APP1 Exif は payload が "Exif\0\0" + TIFF のまま並んでいるので in-place 上書きで足りるが、
 * PNG の eXIf チャンクは中身が生 TIFF（"Exif\0\0" 無し）で、かつ CRC を持つため上書き後に再計算が要る。
 * exif.ts のパーサーは JPEG の "Exif\0\0" 付き payload を前提にしているため、PNG の場合だけ
 * 編集の間だけ疑似ヘッダーを被せて共通コードに通し、書き戻すときに剥がす。
 */
function buildEditedOriginalBuffer(originalArrayBuffer: ArrayBuffer, scan: MetadataScanResult, edits: ExifEdits): ArrayBuffer {
  // 1ファイルに APP1 Exif が複数入っていることがある（多重埋め込みツール等）。除去せず
  // 残す全セグメントに同じ編集を焼き込まないと、キャリー先に古い Orientation/DateTime/GPS が
  // 残ったセグメントが混ざってしまうため、`.find` ではなく全件へ適用する
  const jpegExifSegs = scan.segments.filter((s) => s.name === "APP1 Exif");
  if (jpegExifSegs.length > 0) {
    const copy = originalArrayBuffer.slice(0);
    const bytes = new Uint8Array(copy);
    for (const seg of jpegExifSegs) {
      const payloadStart = seg.start + 4; // マーカー(2) + 長さ(2) を読み飛ばす
      const payload = bytes.subarray(payloadStart, seg.end);
      const edited = applyExifEdits(payload, edits);
      bytes.set(edited.subarray(0, payload.length), payloadStart);
    }
    return copy;
  }

  // PNG の eXIf は仕様上たかだか1個だが、念のため同じ全件適用にしておく
  const pngExifSegs = scan.segments.filter((s) => s.name === "eXIf");
  if (pngExifSegs.length > 0) {
    let buffer = originalArrayBuffer;
    for (const seg of pngExifSegs) {
      const { dataStart, dataEnd } = pngChunkDataRange(seg);
      const tiff = new Uint8Array(buffer).subarray(dataStart, dataEnd);
      const pseudoPayload = new Uint8Array(EXIF_PAYLOAD_HEADER.length + tiff.length);
      pseudoPayload.set(EXIF_PAYLOAD_HEADER, 0);
      pseudoPayload.set(tiff, EXIF_PAYLOAD_HEADER.length);
      const edited = applyExifEdits(pseudoPayload, edits);
      const editedTiff = edited.subarray(EXIF_PAYLOAD_HEADER.length);
      buffer = patchPngChunkData(buffer, seg, editedTiff);
    }
    return buffer;
  }

  return originalArrayBuffer;
}

function segmentBytesSum(scan: MetadataScanResult, predicate: (s: MetadataSegment) => boolean): number {
  return scan.segments.filter(predicate).reduce((sum, s) => sum + s.bytes, 0);
}

async function computeMetadataStage(
  params: PipelineParams,
  formatOutput: StageBlob,
): Promise<{ output: StageBlob; detail: MetadataStageDetail }> {
  const { meta, originalArrayBuffer, removeIds, exifEdits } = params;
  const scan = scanMetadata(originalArrayBuffer, meta.sniffedFormat);
  const removedBytes = segmentBytesSum(scan, (s) => removeIds.has(s.id));
  const keptBytes = scan.totalBytes - removedBytes;
  const hasIcc = scan.segments.some((s) => s.name === "APP2 ICC_PROFILE");

  if (!formatOutput.fromCanvas) {
    // ロスレス経路: 元バイト列がまだ生きているので、残す Exif には編集を焼き込んでから
    // 選んだセグメントだけを間引く。WebP のように除去非対応なら編集だけ反映したバイト列を使う
    const editedBuffer = buildEditedOriginalBuffer(originalArrayBuffer, scan, exifEdits);
    const stripped = scan.strippable ? stripMetadata(editedBuffer, meta.sniffedFormat, removeIds) : null;
    const outBuffer = stripped ?? editedBuffer;
    const blob = outBuffer === originalArrayBuffer ? formatOutput.blob : new Blob([outBuffer], { type: formatOutput.blob.type });
    return {
      output: { ...formatOutput, blob, bytes: blob.size },
      detail: {
        scan,
        cameFromCanvas: false,
        outputFormat: formatOutput.format,
        removedBytes,
        keptBytes,
        carried: false,
        carryUnsupported: false,
        gpsRemoved: exifEdits.removeGps,
        orientationForcedTo1: false,
        iccDropped: hasIcc && removeIds.has(scan.segments.find((s) => s.name === "APP2 ICC_PROFILE")?.id ?? ""),
      },
    };
  }

  // canvas 再エンコードを経た時点でメタデータは完全に失われている。JPEG 出力のときだけ、
  // 元ファイルの Exif/XMP/COM を（ICC を除いて）再挿入できる
  if (formatOutput.format !== "jpeg" || meta.sniffedFormat !== "JPEG" || scan.segments.length === 0) {
    return {
      output: formatOutput,
      detail: {
        scan,
        cameFromCanvas: true,
        outputFormat: formatOutput.format,
        removedBytes,
        keptBytes,
        carried: false,
        carryUnsupported: formatOutput.format !== "jpeg",
        gpsRemoved: exifEdits.removeGps,
        orientationForcedTo1: false,
        iccDropped: hasIcc,
      },
    };
  }

  // drawImage は既に Orientation を反映済みなので、再挿入する Exif は向き 1 に強制する
  // （そのまま向きの値だけ引き継ぐと、canvas が回転済みの上に Exif の回転指示が二重にかかる）
  const carryEdits: ExifEdits = { ...exifEdits, orientation: 1 };
  const editedBuffer = buildEditedOriginalBuffer(originalArrayBuffer, scan, carryEdits);
  const editedBytes = new Uint8Array(editedBuffer);
  const carrySegments = scan.segments
    .filter((s) => CARRY_SEGMENT_NAMES.has(s.name) && !removeIds.has(s.id))
    .map((s) => editedBytes.subarray(s.start, s.end));

  if (carrySegments.length === 0) {
    return {
      output: formatOutput,
      detail: {
        scan,
        cameFromCanvas: true,
        outputFormat: formatOutput.format,
        removedBytes,
        keptBytes,
        carried: false,
        carryUnsupported: false,
        gpsRemoved: exifEdits.removeGps,
        orientationForcedTo1: false,
        iccDropped: hasIcc,
      },
    };
  }

  const canvasArrayBuffer = await formatOutput.blob.arrayBuffer();
  const withSegments = insertJpegSegments(canvasArrayBuffer, carrySegments);
  const blob = new Blob([withSegments], { type: "image/jpeg" });
  return {
    output: { ...formatOutput, blob, bytes: blob.size },
    detail: {
      scan,
      cameFromCanvas: true,
      outputFormat: formatOutput.format,
      removedBytes,
      keptBytes,
      carried: true,
      carryUnsupported: false,
      gpsRemoved: exifEdits.removeGps,
      orientationForcedTo1: true,
      iccDropped: hasIcc,
    },
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
  /** data-value としてボタンに載せる安定な値（select の option value に相当） */
  value: string;
  label: string;
  dims: string;
  bytes: number | null;
  delta: string | null;
  disabled: boolean;
  /** disabled のとき、寸法/容量/差分/バーの代わりに表示する理由文 */
  disabledReason: string | null;
  highlighted: boolean;
  /** 最大行に対する比率（0〜1）。scaleX の transform に使う */
  scale: number;
  /** AVIF の wasm エンコードが完了していない間だけ true（disabled ではなく選択自体は可能） */
  pending?: boolean;
}

/**
 * label | 寸法(mono) | 容量(mono) | 差分%(mono, primary) | 比例バー の1行を、行全体をヒットエリアに
 * 持つ radio ボタンとして組み立てる（サイズ・フォーマット両カードの what-if 行で共有する）。
 * button の content model は phrasing content のため、バーの入れ物・塗りは div ではなく span を使う。
 */
function buildBarRowHtml(row: BarRow): string {
  const stateClass = row.highlighted ? " border-primary bg-muted" : " border-transparent";
  const interactionClass = row.disabled ? " cursor-not-allowed opacity-50" : " cursor-pointer hover:bg-muted/40";
  const attrs =
    `type="button" role="radio" aria-checked="${row.highlighted}" data-value="${row.value}" ` +
    `tabindex="${row.highlighted ? "0" : "-1"}"${row.disabled ? " disabled aria-disabled=\"true\"" : ""}`;
  const className =
    `asshukusan-bar-row flex w-full items-center gap-3 rounded border px-1.5 py-1.5 text-left text-sm ` +
    `transition-colors focus-visible:outline-2 focus-visible:outline-ring${stateClass}${interactionClass}`;

  if (row.pending) {
    return (
      `<button ${attrs} class="${className}">` +
      `<span class="w-16 shrink-0 font-semibold text-foreground">${row.label}</span>` +
      `<span class="flex-1 text-xs text-muted-foreground">AVIF を変換中…</span>` +
      `</button>`
    );
  }
  if (row.disabled) {
    return (
      `<button ${attrs} class="${className}">` +
      `<span class="w-16 shrink-0 font-semibold text-foreground">${row.label}</span>` +
      `<span class="flex-1 text-xs text-muted-foreground">${row.disabledReason ?? ""}</span>` +
      `</button>`
    );
  }
  return (
    `<button ${attrs} class="${className}">` +
    `<span class="w-16 shrink-0 font-semibold text-foreground">${row.label}</span>` +
    `<span class="w-24 shrink-0 font-mono text-xs text-muted-foreground">${row.dims}</span>` +
    `<span class="w-16 shrink-0 font-mono text-xs text-muted-foreground">${row.bytes != null ? formatBytes(row.bytes) : "—"}</span>` +
    `<span class="w-14 shrink-0 text-right font-mono text-xs font-semibold text-primary">${row.delta ?? "±0%"}</span>` +
    `<span class="block h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-muted">` +
    `<span class="asshukusan-bar-fill block h-full w-full rounded-full bg-primary" style="transform: scaleX(${row.scale.toFixed(4)});"></span>` +
    `</span>` +
    `</button>`
  );
}

/**
 * フォーマット比較表（元のまま/JPEG/WebP/PNG/AVIF）を radio 行として組み立てる。
 * 「元のまま」行はサイズ段の出力（passthroughBytes）をそのまま基準行として先頭に足す。
 */
export function buildFormatComparisonHtml(
  comparison: FormatComparisonRow[],
  dims: { width: number; height: number },
  selectedValue: FormatChoice,
  passthroughBytes: number,
): string {
  const maxBytes = Math.max(
    passthroughBytes,
    ...comparison.filter((row) => row.supported && row.bytes != null).map((row) => row.bytes as number),
  );
  const dimsText = `${dims.width}×${dims.height}`;
  const originalRow: BarRow = {
    value: "original",
    label: "元のまま",
    dims: dimsText,
    bytes: passthroughBytes,
    delta: "±0%",
    disabled: false,
    disabledReason: null,
    highlighted: selectedValue === "original",
    scale: maxBytes > 0 ? passthroughBytes / maxBytes : 0,
  };
  const rows: BarRow[] = comparison.map((row) => ({
    value: row.format,
    label: row.label,
    dims: dimsText,
    bytes: row.bytes,
    delta: row.delta,
    disabled: !row.supported,
    disabledReason: row.supported ? null : "このブラウザでは書き出し不可",
    highlighted: selectedValue === row.format,
    scale: row.supported && row.bytes != null && maxBytes > 0 ? row.bytes / maxBytes : 0,
    pending: row.pending,
  }));
  return [originalRow, ...rows].map(buildBarRowHtml).join("");
}

/**
 * サイズラダー（原寸/2048/1600/1200/800）を radio 行として組み立てる。差分は原寸基準。
 * 画像の長辺以上（拡大になる）段は選べないため disabled で残す。
 */
export function buildSizeLadderHtml(rows: SizeLadderRow[], selectedCap: number | null): string {
  const baseRow = rows[0];
  const baseBytes = baseRow?.bytes ?? 0;
  const longEdge = baseRow ? Math.max(baseRow.width, baseRow.height) : Infinity;
  const maxBytes = Math.max(0, ...rows.map((row) => row.bytes));
  const barRows: BarRow[] = rows.map((row) => {
    const disabled = row.cap !== null && row.cap >= longEdge;
    return {
      value: row.cap === null ? "original" : String(row.cap),
      label: row.label,
      dims: `${row.width}×${row.height}`,
      bytes: row.bytes,
      delta: formatDelta(row.bytes, baseBytes),
      disabled,
      disabledReason: disabled ? "拡大になるため不可" : null,
      highlighted: row.cap === selectedCap,
      scale: maxBytes > 0 ? row.bytes / maxBytes : 0,
    };
  });
  return barRows.map(buildBarRowHtml).join("");
}

// --- 詳細パネルの HTML 組み立て ---------------------------------------------
// DOM 操作（innerHTML への代入・イベント登録）は main.ts 側の責務として残し、
// ここでは値からマークアップ文字列を組み立てるところまでを担う。

// value はファイル名・MIME・Exif の ASCII フィールドなどバイナリ由来の未検証文字列を
// そのまま渡されることがあるため、常に escapeHtml を通す（label は呼び出し側の静的文字列のみ）
function detailRowHtml(label: string, value: string): string {
  return (
    `<div class="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-b-0">` +
    `<span class="text-muted-foreground">${label}</span>` +
    `<span class="font-mono text-xs text-foreground">${escapeHtml(value)}</span>` +
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
      `<span class="text-xs text-destructive">拡張子(${escapeHtml(m.extFormat)})と実形式(${escapeHtml(m.sniffedFormat)})が不一致</span>` +
      `</div>`
    : "";
  return rowsHtml + warningHtml;
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


/** セグメント名から「除去」チェックボックスのデフォルト値を決める。ICC だけ既定で保持（色が変わるため） */
export function defaultRemoveForSegmentName(name: string): boolean {
  return name !== "APP2 ICC_PROFILE";
}

/** 除去できないメタデータ（scan.strippable === false の形式、例: WebP）で全チェックの初期値を決める際に使う */
export function defaultRemoveIds(scan: MetadataScanResult): Set<string> {
  return new Set(scan.segments.filter((s) => defaultRemoveForSegmentName(s.name)).map((s) => s.id));
}

/** セグメントの説明・中身プレビューはバイナリ由来のテキストのため、HTML として無害化してから差し込む */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * メタデータノードの segment チェックボックス一覧。checkboxesDisabled は canvas 出力で
 * この形式（WebP/PNG/AVIF）へは引き継げないケースで、選択operationがもう意味を持たないことを
 * 視覚的にも伝えるために使う（disabled にするだけで、選択状態自体は保持する）。
 * 各行はチェックボックス+名前+バイト数の1行目、平易な説明の2行目、（読めれば）中身プレビューの3行目からなる。
 * APP1 Exif / eXIf は別枠の「Exif 詳細」テーブルで中身を見せるため、ここではプレビューを出さない。
 */
export function buildMetadataSegmentRowsHtml(
  scan: MetadataScanResult,
  removeIds: ReadonlySet<string>,
  checkboxesDisabled: boolean,
  originalArrayBuffer: ArrayBuffer,
): string {
  if (scan.segments.length === 0) {
    return `<p class="py-1 text-xs text-muted-foreground">検出されたメタデータセグメントはありません。</p>`;
  }
  return scan.segments
    .map((seg) => {
      const checked = removeIds.has(seg.id);
      const description = segmentDescription(seg.name);
      const content = segmentContentPreview(originalArrayBuffer, seg);
      const iccNote =
        seg.name === "APP2 ICC_PROFILE"
          ? `<p class="pl-6 pb-1 text-xs text-muted-foreground">sRGB でない ICC プロファイルを除去すると色味が変わることがあります。</p>`
          : "";
      const descriptionHtml = description
        ? `<p class="pl-6 text-xs text-muted-foreground">${escapeHtml(description)}</p>`
        : "";
      const contentHtml = content
        ? `<p class="pl-6 pt-0.5 break-all font-mono text-xs text-muted-foreground">${escapeHtml(content)}</p>`
        : "";
      return (
        `<div class="border-b border-border/60 py-1 last:border-b-0">` +
        `<label class="flex items-center justify-between gap-3 text-sm">` +
        `<span class="flex items-center gap-1.5"><input type="checkbox" class="asshukusan-seg-checkbox accent-primary" data-seg-id="${seg.id}"${checked ? " checked" : ""}${checkboxesDisabled ? " disabled" : ""} /><span class="font-semibold text-foreground">${escapeHtml(seg.name)}</span></span>` +
        `<span class="font-mono text-xs text-foreground">${formatBytes(seg.bytes)}</span>` +
        `</label>${descriptionHtml}${contentHtml}${iccNote}` +
        `</div>`
      );
    })
    .join("");
}

/** メタデータカードの総量行「除去 N B / 保持 M B」 */
export function buildMetadataTotalsHtml(removedBytes: number, keptBytes: number): string {
  return (
    `<div class="flex items-baseline justify-between gap-3 border-b border-border py-1.5 text-sm">` +
    `<span class="font-semibold text-foreground">除去 / 保持</span>` +
    `<span class="font-mono text-xs text-foreground">除去 ${formatBytes(removedBytes)} / 保持 ${formatBytes(keptBytes)}</span>` +
    `</div>`
  );
}

const EXIF_FIELD_LABELS: [key: keyof import("./exif").ExifTags, label: string][] = [
  ["make", "Make"],
  ["model", "Model"],
  ["software", "Software"],
  ["dateTime", "DateTime"],
  ["dateTimeOriginal", "DateTimeOriginal"],
  ["imageDescription", "ImageDescription"],
  ["artist", "Artist"],
  ["copyright", "Copyright"],
];

/** Exif 詳細テーブル（読み取り専用の一覧部分。Orientation と GPS は別行で扱う） */
export function buildExifTableHtml(tags: import("./exif").ExifTags): string {
  const rows = EXIF_FIELD_LABELS.filter(([key]) => tags[key] != null && tags[key] !== "")
    .map(([key, label]) => detailRowHtml(label, String(tags[key])))
    .join("");
  const orientationRow = tags.orientation != null ? detailRowHtml("Orientation", String(tags.orientation)) : "";
  const gpsRow = detailRowHtml(
    "GPS 有無",
    !tags.hasGps ? "なし" : tags.gpsLat != null && tags.gpsLon != null ? `あり（${tags.gpsLat.toFixed(4)}, ${tags.gpsLon.toFixed(4)}）` : "あり",
  );
  return rows + orientationRow + gpsRow;
}

/** メタデータカードの状態説明文（複数行になりうる） */
export function metadataStatusNotes(detail: MetadataStageDetail): string[] {
  const notes: string[] = [];
  if (detail.cameFromCanvas) {
    if (detail.carried) {
      notes.push("canvas 再エンコード後の JPEG に、元ファイルの Exif/XMP/COM を再挿入しました。向きは 1 に補正済みです（drawImage が向きを反映済みのため）。");
      if (detail.iccDropped) notes.push("ICC プロファイルは canvas 出力が常に sRGB を吐くため引き継いでいません。");
    } else if (detail.carryUnsupported) {
      notes.push("この形式への再エンコードではメタデータは引き継げません。");
    } else {
      notes.push("サイズ・フォーマット段で再エンコード済みのため、この段では既にメタデータが失われています。");
    }
    return notes;
  }
  if (detail.scan.strippable === false && detail.scan.segments.length > 0) {
    notes.push("WebP の除去は未対応です（RIFF サイズと VP8X flags の再計算が必要で、安全にロスレス除去できないため）。編集内容は保持したまま元のバイト列を通します。");
  } else if (detail.removedBytes > 0) {
    notes.push("元ファイルのバイト列から、選んだセグメントのみをロスレスに読み飛ばして除去しました。");
  }
  if (detail.gpsRemoved && detail.scan.segments.some((s) => s.name === "APP1 Exif")) {
    notes.push("GPS 情報は値をゼロ埋めし、IFD からたどれないようにしました。");
  }
  return notes;
}

/** メタデータノードの要約行（"\n" で複数行に積む。「·」区切りは使わない） */
export function metadataSummaryLines(detail: MetadataStageDetail): string[] {
  const exifSeg = detail.scan.segments.find((s) => s.name === "APP1 Exif");
  if (detail.cameFromCanvas) {
    if (detail.carried) {
      return [exifSeg ? `Exif ${formatBytes(exifSeg.bytes)} を引き継ぎ（向き 1 に補正）` : "メタデータを引き継ぎ（向き 1 に補正）"];
    }
    if (detail.carryUnsupported) return ["この形式へは引き継げません"];
    return ["再エンコードで除去済み"];
  }
  if (detail.scan.segments.length === 0) return ["メタデータなし"];
  const lines = [`除去 ${formatBytes(detail.removedBytes)} / 保持 ${formatBytes(detail.keptBytes)}`];
  if (detail.iccDropped) lines.push("ICC 除去");
  return lines;
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
