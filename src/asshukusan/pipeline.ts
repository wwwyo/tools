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
  extractIccProfileBytes,
  bestEffortDecode,
  XMP_APP1_HEADER,
  type MetadataScanResult,
  type MetadataSegment,
} from "./metadataStrip";
import { applyExifEdits, EXIF_PAYLOAD_HEADER, type ExifEdits } from "./exif";
import { parseIccProfile, type IccProfileInfo } from "./icc";
import { parseXmpPacket, type XmpInfo } from "./xmp";

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
  /** ユーザーが個別に消すと選んだ Exif タグの数（Exif セグメント自体が無ければ 0） */
  tagsRemovedCount: number;
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
      const payload = bytes.subarray(seg.payloadStart, seg.end);
      const edited = applyExifEdits(payload, edits);
      bytes.set(edited.subarray(0, payload.length), seg.payloadStart);
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
  // Exif セグメント自体が無いのに「タグを N 件消去」と出すと何を消したのか分からなくなるため、
  // Exif/eXIf が実在するときだけ選択中のタグ数をそのまま報告する
  const hasExif = scan.segments.some((s) => s.name === "APP1 Exif" || s.name === "eXIf");
  const tagsRemovedCount = hasExif ? exifEdits.removeTags.size : 0;

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
        tagsRemovedCount,
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
        tagsRemovedCount,
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
        tagsRemovedCount,
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
      tagsRemovedCount,
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


/** セグメント名から一言の平易な日本語タイトルを返す（チェックボックス行の見出し）。
 * 技術的な id（`APP1 Exif` 等）はこのタイトルの直後に小さく添えるだけにし、
 * 「一覧を眺めればジャーゴンの羅列」にならないようにする（ユーザーフィードバック「個別に消せるなら一覧は不要」） */
const SEGMENT_TITLES: Record<string, string> = {
  "APP1 Exif": "撮影情報（Exif）",
  eXIf: "撮影情報（Exif）",
  EXIF: "撮影情報（Exif）",
  "APP1 XMP": "編集情報（XMP）",
  "XMP ": "編集情報（XMP）",
  "APP2 ICC_PROFILE": "カラープロファイル（ICC）",
  ICCP: "カラープロファイル（ICC）",
  iCCP: "カラープロファイル（ICC）",
  "APP13 Photoshop": "Photoshop 付随データ（IPTC）",
  COM: "コメント",
  tEXt: "テキスト情報（PNG tEXt）",
  zTXt: "テキスト情報（PNG tEXt）",
  iTXt: "テキスト情報（PNG tEXt）",
  tIME: "最終更新時刻（PNG tIME）",
  "APP2 MPF": "マルチピクチャ索引（MPF）",
  APP1: "不明な付随データ（APP1）",
  APP2: "不明な付随データ（APP2）",
};

function segmentTitle(name: string): string {
  return SEGMENT_TITLES[name] ?? name;
}

function isIccSegmentName(name: string): boolean {
  return name === "APP2 ICC_PROFILE" || name === "ICCP";
}

function isXmpSegmentName(name: string): boolean {
  return name === "APP1 XMP" || name === "XMP ";
}

export function isExifSegmentName(name: string): boolean {
  return name === "APP1 Exif" || name === "eXIf" || name === "EXIF";
}

/**
 * ICC セグメント（JPEG APP2 ICC_PROFILE / WebP ICCP）から実プロファイルバイト列を取り出して解析する。
 * PNG iCCP はプロファイル本体が zlib 圧縮のためここでは扱わない（keyword だけの簡易プレビューのまま）。
 * 壊れている・対象外なら null を返し、呼び出し側は「概要が読めません」を出す。
 */
export function iccProfileInfoForSegment(
  format: MetadataScanResult["format"],
  originalArrayBuffer: ArrayBuffer,
  segment: MetadataSegment,
): IccProfileInfo | null {
  try {
    if (segment.name === "APP2 ICC_PROFILE" && format === "jpeg") {
      const bytes = extractIccProfileBytes(originalArrayBuffer, segment);
      return bytes ? parseIccProfile(bytes) : null;
    }
    if (segment.name === "ICCP" && format === "webp") {
      const bytes = new Uint8Array(originalArrayBuffer).subarray(segment.payloadStart, segment.end);
      return parseIccProfile(bytes);
    }
    return null;
  } catch {
    return null;
  }
}

/** XMP セグメント（JPEG APP1 XMP / WebP XMP ）から XML パケットを取り出して解析する */
export function xmpInfoForSegment(originalArrayBuffer: ArrayBuffer, segment: MetadataSegment): XmpInfo | null {
  try {
    const bytes = new Uint8Array(originalArrayBuffer);
    const xmlStart = segment.name === "APP1 XMP" ? segment.payloadStart + XMP_APP1_HEADER.length : segment.payloadStart;
    const xml = bestEffortDecode(bytes.subarray(xmlStart, segment.end));
    return parseXmpPacket(xml);
  } catch {
    return null;
  }
}

/** 既定で保持する（除去チェックボックスを OFF にする）セグメント名。
 * 未知の APP2 / MPF は正体不明・副画像索引という「消してよいか判断できないもの」の代表であり、
 * 安全側に倒して保持を既定にする。ICC はここに含めない（sRGB 判定で個別に決める、下記 defaultRemoveIds） */
const DEFAULT_KEEP_SEGMENT_NAMES = new Set(["APP2", "APP2 MPF"]);

/** セグメント名から「除去」チェックボックスのデフォルト値を決める（ICC を除く） */
export function defaultRemoveForSegmentName(name: string): boolean {
  return !DEFAULT_KEEP_SEGMENT_NAMES.has(name);
}

/**
 * 除去チェックボックスの初期値一式を決める。ICC だけは sRGB 判定に従う: sRGB 相当なら
 * 除去しても実害が無いため既定 ON、そうでなければ色味が変わるため既定 OFF にする。
 * WebP のように除去そのものが未対応の形式でも、チェックボックスの初期状態としては同じ規則を使う
 * （実際の除去には反映されないが、UI 上の意思表示として意味を持つ）。
 */
export function defaultRemoveIds(scan: MetadataScanResult, originalArrayBuffer: ArrayBuffer): Set<string> {
  const ids = new Set<string>();
  for (const seg of scan.segments) {
    if (isIccSegmentName(seg.name)) {
      const info = iccProfileInfoForSegment(scan.format, originalArrayBuffer, seg);
      if (info?.isSrgbEquivalent) ids.add(seg.id);
      continue;
    }
    if (defaultRemoveForSegmentName(seg.name)) ids.add(seg.id);
  }
  return ids;
}

/** セグメントの説明・中身プレビュー・Exif タグ名等はバイナリ由来のテキストを含みうるため、
 * HTML として無害化してから差し込む（main.ts の Exif タグテーブル組み立てからも使う） */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** APP1 Exif / eXIf / WebP EXIF の行にだけ挿す、タグテーブル差し込み用の空 tbody。main.ts が
 * セクション本文の innerHTML を設定した直後にこの要素を見つけ、インタラクティブな行
 * （チェックボックス・Orientation/DateTime 系の編集欄・GPS IFD 疑似行）を組み立てて入れる。
 * ここで文字列として組み立てないのは、編集欄が select/input への DOM 参照とイベント登録を
 * 必要とするため（他の Exif 編集欄と同じ理由、本ファイル冒頭コメント参照）。
 * すべての除去可能な行（タグ + GPS IFD）が消す対象になったときは、main.ts 側が
 * セグメント自体を `removeIds` に加えてゼロ埋めではなく物理除去に切り替える
 * （ユーザーフィードバック「セクションまるごとのチェックボックスは廃止し、行の状態から導出する」）。
 * その規則をその場で伝えるため、テーブルの下に常時この注記を添える。 */
function exifTagTableShellHtml(seg: MetadataSegment): string {
  return (
    `${metadataTableOpenHtml()}<tbody data-exif-tag-table></tbody></table>` +
    `<p class="pt-1 text-xs text-muted-foreground">すべて削除のときはセグメントごと除去（−${formatBytes(seg.bytes)}）</p>`
  );
}

/** メタデータの詳細テーブル（削除・項目・値・サイズ）の開始タグ + ヘッダー行 */
function metadataTableOpenHtml(): string {
  return (
    `<table class="w-full text-xs">` +
    `<thead><tr class="border-b border-border text-left text-muted-foreground">` +
    `<th class="w-8 py-1 pr-1 font-normal">削除</th>` +
    `<th class="py-1 pr-2 font-normal">項目</th>` +
    `<th class="py-1 pr-2 font-normal">値</th>` +
    `<th class="w-16 py-1 text-right font-normal">サイズ</th>` +
    `</tr></thead>`
  );
}

/** rowsHtml（`<tr>` の列）を table 全体に包む */
function metadataTableHtml(rowsHtml: string): string {
  return `${metadataTableOpenHtml()}<tbody>${rowsHtml}</tbody></table>`;
}

/** テーブル1行（削除セル + 項目 + 値 + サイズ）。itemHtml/valueHtml は既にエスケープ済みの
 * HTML を受け取る（select/input 等の埋め込みを許すため）。読み取り専用の値は
 * `metadataReadonlyRowHtml` を使う */
function metadataRowHtml(checkboxHtml: string, itemHtml: string, valueHtml: string, sizeHtml: string): string {
  return (
    `<tr class="border-b border-border/40 last:border-b-0 align-top">` +
    `<td class="w-8 py-1 pr-1">${checkboxHtml}</td>` +
    `<td class="py-1 pr-2 font-semibold text-foreground">${itemHtml}</td>` +
    `<td class="min-w-0 py-1 pr-2">${valueHtml}</td>` +
    `<td class="w-16 py-1 text-right font-mono text-muted-foreground">${sizeHtml}</td>` +
    `</tr>`
  );
}

/** チェックボックスも消去対象の区別も無い、読み取り専用の情報行（label/value は生文字列で渡し、ここで escape する） */
function metadataReadonlyRowHtml(label: string, value: string, sizeBytes?: number): string {
  return metadataRowHtml(
    "",
    escapeHtml(label),
    `<span class="break-all">${escapeHtml(value)}</span>`,
    sizeBytes != null ? formatBytes(sizeBytes) : "",
  );
}

/** セグメントまるごとの除去チェックボックス。main.ts の `segListEl` change ハンドラが
 * `.asshukusan-seg-checkbox` を委譲で拾うため、テーブルの行内に置いても配線は変わらない */
function segmentCheckboxHtml(segId: string, checked: boolean, disabled: boolean): string {
  return `<input type="checkbox" class="asshukusan-seg-checkbox accent-primary" data-seg-id="${segId}"${checked ? " checked" : ""}${disabled ? " disabled" : ""} />`;
}

/** ICC セクションの本文: 1行目にチェック可能な概要行（sRGB 判定込み）、以下はプロファイル情報・
 * タグ一覧を読み取り専用行として並べる（アコーディオンは持たない） */
function iccBodyHtml(info: IccProfileInfo | null, seg: MetadataSegment, checked: boolean, disabled: boolean): string {
  const checkboxHtml = segmentCheckboxHtml(seg.id, checked, disabled);
  if (!info) {
    return metadataTableHtml(
      metadataRowHtml(
        checkboxHtml,
        escapeHtml("ICC プロファイル"),
        `<span class="text-muted-foreground">プロファイルの詳細を読み取れませんでした。</span>`,
        formatBytes(seg.bytes),
      ),
    );
  }
  const version = info.versionMajor != null ? `${info.versionMajor}.${info.versionMinor ?? 0}` : "（読めない）";
  const judgmentClass = info.isSrgbEquivalent ? "text-muted-foreground" : "text-destructive";
  const summaryRow = metadataRowHtml(
    checkboxHtml,
    escapeHtml("ICC プロファイル"),
    `<span class="${judgmentClass}">${escapeHtml(info.judgmentText)}</span>`,
    formatBytes(seg.bytes),
  );
  const infoRows = (
    [
      ["プロファイル名", info.description ?? "（読めない）"],
      ["色空間", info.colorSpace ?? "（読めない）"],
      ["PCS", info.pcs ?? "（読めない）"],
      ["デバイス種別", info.deviceClassLabel ?? info.deviceClass ?? "（読めない）"],
      ["バージョン", version],
      ["作成日", info.creationDate ?? "（読めない）"],
      [
        "白色点",
        info.whitePoint ? `${info.whitePoint.x.toFixed(4)}, ${info.whitePoint.y.toFixed(4)}, ${info.whitePoint.z.toFixed(4)}` : "（読めない）",
      ],
      [
        "原色 R",
        info.redPrimary ? `${info.redPrimary.x.toFixed(4)}, ${info.redPrimary.y.toFixed(4)}, ${info.redPrimary.z.toFixed(4)}` : "（読めない）",
      ],
      [
        "原色 G",
        info.greenPrimary ? `${info.greenPrimary.x.toFixed(4)}, ${info.greenPrimary.y.toFixed(4)}, ${info.greenPrimary.z.toFixed(4)}` : "（読めない）",
      ],
      [
        "原色 B",
        info.bluePrimary ? `${info.bluePrimary.x.toFixed(4)}, ${info.bluePrimary.y.toFixed(4)}, ${info.bluePrimary.z.toFixed(4)}` : "（読めない）",
      ],
      ["レンダリングインテント", info.renderingIntentLabel ?? "（読めない）"],
    ] satisfies [string, string][]
  )
    .map(([label, value]) => metadataReadonlyRowHtml(label, value))
    .join("");
  const tagRows = info.tags
    .map((tag) => metadataReadonlyRowHtml(tag.signature || "?", tag.decoded ?? "", tag.size))
    .join("");
  return metadataTableHtml(summaryRow + infoRows + tagRows);
}

/** XMP セクションの本文: 1行目にチェック可能な概要行（プロパティ件数）、以下は見つかった
 * プロパティと生 XML（先頭 600 文字）を読み取り専用行として並べる（アコーディオンは持たない） */
function xmpBodyHtml(info: XmpInfo | null, seg: MetadataSegment, checked: boolean, disabled: boolean): string {
  const checkboxHtml = segmentCheckboxHtml(seg.id, checked, disabled);
  if (!info) {
    return metadataTableHtml(
      metadataRowHtml(
        checkboxHtml,
        escapeHtml("XMP パケット"),
        `<span class="text-muted-foreground">XMP パケットを読み取れませんでした。</span>`,
        formatBytes(seg.bytes),
      ),
    );
  }
  const knownRows: [string, string][] = [];
  if (info.creatorTool) knownRows.push(["CreatorTool", info.creatorTool]);
  if (info.createDate) knownRows.push(["CreateDate", info.createDate]);
  if (info.modifyDate) knownRows.push(["ModifyDate", info.modifyDate]);
  if (info.creators.length > 0) knownRows.push(["creator", info.creators.join(", ")]);
  if (info.description) knownRows.push(["description", info.description]);
  if (info.subjects.length > 0) knownRows.push(["subject", info.subjects.join(", ")]);
  if (info.photoshopDateCreated) knownRows.push(["DateCreated (Photoshop)", info.photoshopDateCreated]);
  if (info.exifCount > 0) knownRows.push(["exif:* プロパティ", `${info.exifCount} 件`]);
  if (info.tiffCount > 0) knownRows.push(["tiff:* プロパティ", `${info.tiffCount} 件`]);

  const propertyCount = knownRows.length > 0 ? knownRows.length : info.unknownPropertyCount;
  const summaryRow = metadataRowHtml(checkboxHtml, escapeHtml("XMP パケット"), escapeHtml(`プロパティ ${propertyCount} 件`), formatBytes(seg.bytes));
  const propertyRows = knownRows.map(([label, value]) => metadataReadonlyRowHtml(label, value)).join("");
  const rawXmlHtml = `<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1.5 font-mono text-[11px] text-muted-foreground">${escapeHtml(info.rawXmlPreview.slice(0, 600))}</pre>`;
  const rawXmlRow = metadataRowHtml("", escapeHtml("生 XML（先頭600文字）"), rawXmlHtml, "");
  return metadataTableHtml(summaryRow + propertyRows + rawXmlRow);
}

/** COM・PNG テキストチャンク・tIME・Photoshop・不明な APP2・MPF 用の1行だけの本文
 * （デコード済みテキストや説明をそのまま値セルに出す） */
function simpleSegmentBodyHtml(seg: MetadataSegment, content: string | null, checked: boolean, disabled: boolean): string {
  const checkboxHtml = segmentCheckboxHtml(seg.id, checked, disabled);
  const valueHtml = content
    ? `<span class="break-all font-mono">${escapeHtml(content)}</span>`
    : `<span class="text-muted-foreground">（内容を読み取れません）</span>`;
  return metadataTableHtml(metadataRowHtml(checkboxHtml, escapeHtml(segmentTitle(seg.name)), valueHtml, formatBytes(seg.bytes)));
}

/**
 * メタデータカードのセクション一覧を組み立てる。アコーディオンは持たず、常にすべて展開済みの
 * 状態で表示する（ユーザーフィードバック「折りたたみを無くし、常時全部見える形にする」）。
 * 見出しはプレーンなタイトル + 小さく添えた技術 id・バイト数のみとし、除去チェックボックスは
 * 持たない（セクションまるごとの除去チェックボックスは廃止し、本文のテーブル内の行単位で選ぶ）。
 * 本文は種別ごとに詳細が変わるが、共通して「削除・項目・値・サイズ」の4列テーブルを持つ。
 * checkboxesDisabled は canvas 出力でこの形式（WebP/PNG/AVIF）へ引き継げないケースで使う
 * （選択状態自体は保持したまま、見た目と実際の操作だけを無効化する）。
 * WebP はそもそも除去が未対応なため、format が "webp" のときは常にチェックボックスを
 * 無効化し、その理由を隣に添える。
 */
export function buildMetadataSectionsHtml(
  scan: MetadataScanResult,
  removeIds: ReadonlySet<string>,
  checkboxesDisabled: boolean,
  originalArrayBuffer: ArrayBuffer,
): string {
  if (scan.segments.length === 0) {
    return `<p class="py-1 text-xs text-muted-foreground">検出されたメタデータセグメントはありません。</p>`;
  }
  const webpUnsupported = scan.format === "webp";
  return scan.segments
    .map((seg) => {
      const checked = removeIds.has(seg.id);
      const disabled = checkboxesDisabled || webpUnsupported;
      const description = segmentDescription(seg.name);
      const descriptionHtml = description ? `<p class="pb-1 text-xs text-muted-foreground">${escapeHtml(description)}</p>` : "";

      let bodyHtml: string;
      if (isExifSegmentName(seg.name)) {
        bodyHtml = exifTagTableShellHtml(seg);
      } else if (isIccSegmentName(seg.name)) {
        bodyHtml = iccBodyHtml(iccProfileInfoForSegment(scan.format, originalArrayBuffer, seg), seg, checked, disabled);
      } else if (isXmpSegmentName(seg.name)) {
        bodyHtml = xmpBodyHtml(xmpInfoForSegment(originalArrayBuffer, seg), seg, checked, disabled);
      } else {
        const content = segmentContentPreview(originalArrayBuffer, seg);
        bodyHtml = simpleSegmentBodyHtml(seg, content, checked, disabled);
      }

      const mpfNote =
        seg.name === "APP2 MPF"
          ? `<p class="pt-1 text-xs text-muted-foreground">除去すると MPO の副画像（視差画像など）も一緒に失われます。</p>`
          : "";
      const webpNote = webpUnsupported ? `<span class="text-xs text-muted-foreground">（WebP の除去は未対応）</span>` : "";

      return (
        `<div class="border-b border-border/60 py-5 first:pt-1 last:border-b-0 last:pb-1">` +
        `<div class="flex min-w-0 items-center justify-between gap-3 text-sm">` +
        `<span class="truncate font-semibold text-foreground">${escapeHtml(segmentTitle(seg.name))}</span>` +
        `<span class="shrink-0 font-mono text-xs text-muted-foreground">${escapeHtml(seg.name)} · ${formatBytes(seg.bytes)}${webpNote ? ` ${webpNote}` : ""}</span>` +
        `</div>` +
        `<div class="pt-1">${descriptionHtml}${bodyHtml}${mpfNote}</div>` +
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

/** メタデータカードの状態説明文（複数行になりうる） */
export function metadataStatusNotes(detail: MetadataStageDetail): string[] {
  // 出せるのは「なぜ操作が効かないか」だけ。処理の内部説明はカードに載せない
  const notes: string[] = [];
  if (detail.cameFromCanvas) {
    if (detail.carried && detail.iccDropped) {
      notes.push("再エンコード後は sRGB になるため、ICC プロファイルは引き継ぎません。");
    } else if (detail.carryUnsupported) {
      notes.push("この形式への再エンコードではメタデータは引き継げません。");
    } else if (!detail.carried) {
      notes.push("再エンコード済みのため、メタデータは既にありません。");
    }
    return notes;
  }
  if (detail.scan.strippable === false && detail.scan.segments.length > 0) {
    notes.push("WebP のメタデータ除去は未対応です。");
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
  if (detail.tagsRemovedCount > 0) lines.push(`Exif タグ ${detail.tagsRemovedCount} 件を消去`);
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
