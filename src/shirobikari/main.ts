/// <reference types="vite/client" />
import "../global.css";
import "./styles.css";
import gioiaHdrJpg from "./gioia-pixel-ultrahdr.jpg";
import hdrPng from "./hdr.png";

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("app element not found");
}

appEl.innerHTML = `
  <main class="mx-auto flex max-w-3xl flex-col gap-12 px-5 py-10">
    <header class="flex flex-col gap-1.5">
      <h1 class="text-2xl font-bold">シロビカリ</h1>
      <p class="text-sm text-muted-foreground">
        HDR 対応ディスプレイは、通常の「白」よりも明るい光を出せます。CSS・画像・WebGPU
        という3つの方法で、その明るさの差を並べて見比べます。差は HDR 対応のディスプレイ・
        ブラウザでないと見えません。
      </p>
    </header>

    <section class="flex flex-col gap-2 rounded border border-border bg-card px-4 py-3">
      <h2 class="text-sm font-bold text-muted-foreground">サポート状況</h2>
      <ul id="support-list" class="flex flex-col gap-1 text-sm"></ul>
    </section>

    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <h2 class="text-lg font-bold">1. CSS の dynamic-range-limit で切り替える</h2>
        <p class="text-sm text-muted-foreground">
          <code>dynamic-range-limit</code> は、画像の明るさの上限を CSS 側で制限するプロパティです。
          左の画像はホバー・Tab フォーカスすると <code>standard</code>（上限あり）から
          <code>no-limit</code>（上限なし）に切り替わります。右は常に <code>no-limit</code> で、
          最大どこまで明るくなるかの比較用です。中間の明るさは
          <code>dynamic-range-limit-mix(standard 70%, no-limit 30%)</code> のように指定できます。
        </p>
        <p class="text-sm text-muted-foreground">
          このプロパティは上限を外すだけで、明るさを作り出すわけではありません。元画像が HDR の
          輝度情報を持っていない普通の sRGB 画像なら、<code>no-limit</code> にしても見た目は変わりません。
          ここで使っているのは Pixel が撮った UltraHDR 形式の JPEG で、通常の JPEG に加えて
          「どこをどれだけ持ち上げるか」を記録したゲインマップを内包しています。
        </p>
      </div>
      <div id="drl-unsupported" class="hidden rounded border border-dashed border-border px-4 py-3 text-sm text-muted-foreground"></div>
      <div class="flex flex-col gap-6 sm:flex-row">
        <figure class="flex flex-1 flex-col gap-2">
          <img
            src="${gioiaHdrJpg}"
            alt="UltraHDR形式のサンプル写真。ホバーまたはフォーカスすると白い部分の明るさが変わる"
            tabindex="0"
            class="drl-hover w-full rounded border border-border"
          />
          <figcaption class="text-xs text-muted-foreground">ホバー / フォーカスで standard ⇔ no-limit</figcaption>
        </figure>
        <figure class="flex flex-1 flex-col gap-2">
          <img
            src="${gioiaHdrJpg}"
            alt="同じUltraHDR写真をno-limit固定で表示したもの。常に最大輝度で表示される"
            class="drl-no-limit w-full rounded border border-border"
          />
          <figcaption class="text-xs text-muted-foreground">常に no-limit（比較用）</figcaption>
        </figure>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <h2 class="text-lg font-bold">2. HDR 画像をそのまま埋め込む</h2>
        <p class="text-sm text-muted-foreground">
          CSS で何も指定せず、HDR の PNG をそのまま <code>&lt;img&gt;</code> に埋め込んでいます。
          中身は白一色ですが、ICC プロファイルが Rec.2020 色域 + PQ 転送関数なので、
          同じ <code>#ffffff</code> でも SDR の白よりずっと高い輝度として解釈されます。
          明るさは画素値ではなく、どの転送関数で解釈するかで決まる、という例です。
        </p>
      </div>
      <img
        src="${hdrPng}"
        alt="輝度情報を持つHDR形式のPNG画像"
        tabindex="0"
        class="max-w-sm rounded border border-border"
      />
    </section>

    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <h2 class="text-lg font-bold">3. WebGPU で SDR と HDR を並べて描く</h2>
        <p class="text-sm text-muted-foreground">
          WebGPU の <code>toneMapping: { mode: "extended" }</code> と
          <code>format: "rgba16float"</code> を使うと、1.0 を超える輝度値（白より明るい色）を
          直接描画できます。左が通常の <code>standard</code>、右が <code>extended</code> です。
          スライダーで明るさを上げると、右側だけ白の上限を超えて光り続けます。
        </p>
      </div>
      <div id="gradient-unsupported" class="hidden rounded border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"></div>
      <div id="gradient-canvases" class="hidden flex-col gap-6 sm:flex-row">
        <div class="flex flex-1 flex-col gap-2">
          <h3 class="text-sm font-bold text-muted-foreground">SDR（standard トーンマッピング）</h3>
          <canvas id="canvas-sdr" width="400" height="300" class="w-full rounded border border-border"></canvas>
        </div>
        <div class="flex flex-1 flex-col gap-2">
          <h3 class="text-sm font-bold text-muted-foreground">HDR（extended トーンマッピング）</h3>
          <canvas id="canvas-hdr" width="400" height="300" class="w-full rounded border border-border"></canvas>
        </div>
      </div>
      <label id="gradient-controls" class="hidden flex-col gap-1.5 text-sm sm:flex-row sm:items-center sm:gap-3">
        <span class="text-muted-foreground">トーンマッピングの明るさ</span>
        <input type="range" id="brightness" min="0.5" max="4" step="0.1" value="1.5" class="w-full accent-primary sm:max-w-64" />
        <span id="brightness-value" class="font-mono text-xs tabular-nums">1.5</span>
      </label>
    </section>

    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <h2 class="text-lg font-bold">4. 単色で輝度だけを比較する</h2>
        <p class="text-sm text-muted-foreground">
          形や模様を取り除き、同じ色を輝度だけ変えて並べます。左は輝度 1.0（SDR 相当の上限）に
          固定、右はスライダーで選んだ輝度です。HDR ディスプレイでは右側がより明るく光って見えます。
        </p>
      </div>
      <div id="solid-unsupported" class="hidden rounded border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"></div>
      <div id="solid-canvases" class="hidden flex-col gap-6 sm:flex-row">
        <div class="flex flex-1 flex-col gap-2">
          <h3 class="text-sm font-bold text-muted-foreground">輝度 1.0（SDR相当）</h3>
          <canvas id="canvas-solid-sdr" width="400" height="200" class="w-full rounded border border-border"></canvas>
        </div>
        <div class="flex flex-1 flex-col gap-2">
          <h3 class="text-sm font-bold text-muted-foreground">輝度 <span id="hdr-brightness-label">2.0</span>（HDR）</h3>
          <canvas id="canvas-solid-hdr" width="400" height="200" class="w-full rounded border border-border"></canvas>
        </div>
      </div>
      <div id="solid-controls" class="hidden flex-col gap-3 text-sm sm:flex-row sm:items-center">
        <label class="flex items-center gap-2">
          <span class="text-muted-foreground">色</span>
          <select id="color-select" class="rounded border border-border bg-card px-2 py-1 text-foreground">
            <option value="white">白</option>
            <option value="red">赤</option>
            <option value="green">緑</option>
            <option value="blue">青</option>
            <option value="yellow">黄</option>
            <option value="cyan">シアン</option>
            <option value="magenta">マゼンタ</option>
          </select>
        </label>
        <label class="flex flex-1 items-center gap-2">
          <span class="text-muted-foreground">HDR輝度</span>
          <input type="range" id="solid-brightness" min="1" max="5" step="0.1" value="2" class="w-full accent-primary" />
          <span id="solid-brightness-value" class="font-mono text-xs tabular-nums">2.0</span>
        </label>
      </div>
    </section>
  </main>
`;

const supportListEl = document.getElementById("support-list") as HTMLUListElement;
const drlUnsupportedEl = document.getElementById("drl-unsupported") as HTMLDivElement;
const gradientUnsupportedEl = document.getElementById("gradient-unsupported") as HTMLDivElement;
const gradientCanvasesEl = document.getElementById("gradient-canvases") as HTMLDivElement;
const gradientControlsEl = document.getElementById("gradient-controls") as HTMLLabelElement;
const solidUnsupportedEl = document.getElementById("solid-unsupported") as HTMLDivElement;
const solidCanvasesEl = document.getElementById("solid-canvases") as HTMLDivElement;
const solidControlsEl = document.getElementById("solid-controls") as HTMLDivElement;

type SupportItem = { label: string; ok: boolean; detail?: string };

function renderSupportList(items: SupportItem[]): void {
  supportListEl.innerHTML = items
    .map(
      (item) => `
        <li class="flex items-start gap-2">
          <span class="mt-0.5">${item.ok ? "✅" : "⚠️"}</span>
          <span>
            <span class="text-foreground">${item.label}</span>
            ${item.detail ? `<span class="block text-xs text-muted-foreground">${item.detail}</span>` : ""}
          </span>
        </li>
      `,
    )
    .join("");
}

function showUnsupportedMessage(el: HTMLElement, message: string): void {
  el.textContent = message;
  el.classList.remove("hidden");
}

// 単色用シェーダー（vec4fでアライメント問題を回避）
const solidShaderCode = `
  struct Uniforms {
    colorAndBrightness: vec4f,  // xyz=color, w=brightness
  }

  @group(0) @binding(0) var<uniform> uniforms: Uniforms;

  struct VertexOutput {
    @builtin(position) position: vec4f,
  }

  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2f, 3>(
      vec2f(-1.0, -1.0),
      vec2f(3.0, -1.0),
      vec2f(-1.0, 3.0)
    );
    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    return output;
  }

  @fragment
  fn fragmentMain() -> @location(0) vec4f {
    let color = uniforms.colorAndBrightness.xyz * uniforms.colorAndBrightness.w;
    return vec4f(color, 1.0);
  }
`;

// グラデーション用シェーダー
const gradientShaderCode = `
  struct Uniforms {
    brightness: f32,
    time: f32,
  }

  @group(0) @binding(0) var<uniform> uniforms: Uniforms;

  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
  }

  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // フルスクリーン三角形
    var pos = array<vec2f, 3>(
      vec2f(-1.0, -1.0),
      vec2f(3.0, -1.0),
      vec2f(-1.0, 3.0)
    );
    var uv = array<vec2f, 3>(
      vec2f(0.0, 1.0),
      vec2f(2.0, 1.0),
      vec2f(0.0, -1.0)
    );

    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = uv[vertexIndex];
    return output;
  }

  // 円の距離関数
  fn sdCircle(p: vec2f, center: vec2f, r: f32) -> f32 {
    return length(p - center) - r;
  }

  // スムーズな円
  fn smoothCircle(p: vec2f, center: vec2f, r: f32, softness: f32) -> f32 {
    let d = sdCircle(p, center, r);
    return 1.0 - smoothstep(0.0, softness, d);
  }

  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    let uv = input.uv;
    let brightness = uniforms.brightness;
    let time = uniforms.time;

    // 背景グラデーション
    var color = mix(
      vec3f(0.08, 0.08, 0.16),
      vec3f(0.16, 0.08, 0.24),
      uv.y
    );

    // 輝度バー（上部）- HDRでは1.0を超える値が可能
    if (uv.y > 0.82) {
      let barLuminance = uv.x * brightness * 2.0;
      color = vec3f(barLuminance);
    }

    // 輝く円たち
    let aspect = 400.0 / 300.0;
    let p = vec2f(uv.x * aspect, uv.y);

    // 赤い円
    let redCenter = vec2f(0.33 * aspect, 0.5);
    let redGlow = smoothCircle(p, redCenter, 0.12, 0.15);
    let redColor = vec3f(brightness * 1.5, 0.1, 0.1) * redGlow;
    color += redColor;

    // 緑の円
    let greenCenter = vec2f(0.5 * aspect, 0.5);
    let greenGlow = smoothCircle(p, greenCenter, 0.12, 0.15);
    let greenColor = vec3f(0.1, brightness * 1.5, 0.1) * greenGlow;
    color += greenColor;

    // 青い円
    let blueCenter = vec2f(0.67 * aspect, 0.5);
    let blueGlow = smoothCircle(p, blueCenter, 0.12, 0.15);
    let blueColor = vec3f(0.1, 0.1, brightness * 1.5) * blueGlow;
    color += blueColor;

    // 白い輝く円（中央下）- HDRで最も効果的
    let whiteCenter = vec2f(0.5 * aspect, 0.25);
    let whiteGlow = smoothCircle(p, whiteCenter, 0.1, 0.12);
    // HDRでは2.0以上の値で「白より明るい」を表現
    let whiteColor = vec3f(brightness * 2.5) * whiteGlow;
    color += whiteColor;

    // パルスする輝点（アニメーション）
    let pulseIntensity = 0.5 + 0.5 * sin(time * 2.0);
    let sparkleCenter = vec2f(0.5 * aspect, 0.65);
    let sparkleGlow = smoothCircle(p, sparkleCenter, 0.03, 0.05);
    let sparkleColor = vec3f(brightness * 3.0 * pulseIntensity) * sparkleGlow;
    color += sparkleColor;

    return vec4f(color, 1.0);
  }
`;

type ToneMappingMode = "standard" | "extended";

/** グラデーションの輝く円たちを描くレンダラー */
class GradientHDRRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly toneMappingMode: ToneMappingMode;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  constructor(canvas: HTMLCanvasElement, toneMappingMode: ToneMappingMode) {
    this.canvas = canvas;
    this.toneMappingMode = toneMappingMode;
  }

  async init(device: GPUDevice): Promise<void> {
    this.device = device;
    const context = this.canvas.getContext("webgpu");
    if (!context) {
      throw new Error("webgpu canvas context を取得できませんでした");
    }
    this.context = context;

    // HDR用の設定: rgba16floatフォーマットとextendedトーンマッピング
    this.context.configure({
      device: this.device,
      format: "rgba16float", // HDR用のフォーマット
      toneMapping: { mode: this.toneMappingMode }, // "standard" or "extended"
      alphaMode: "premultiplied",
    });

    const shaderModule = this.device.createShaderModule({ code: gradientShaderCode });

    // Uniformバッファ: brightness(f32) + time(f32)
    this.uniformBuffer = this.device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba16float" }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  render(brightness: number, time: number): void {
    if (!this.device || !this.context || !this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    const uniformData = new Float32Array([brightness, time]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const commandEncoder = this.device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(3); // フルスクリーン三角形
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }
}

/** 単色を輝度だけ変えて描くレンダラー */
class SolidColorRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly toneMappingMode: ToneMappingMode;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  constructor(canvas: HTMLCanvasElement, toneMappingMode: ToneMappingMode) {
    this.canvas = canvas;
    this.toneMappingMode = toneMappingMode;
  }

  async init(device: GPUDevice): Promise<void> {
    this.device = device;
    const context = this.canvas.getContext("webgpu");
    if (!context) {
      throw new Error("webgpu canvas context を取得できませんでした");
    }
    this.context = context;

    this.context.configure({
      device: this.device,
      format: "rgba16float",
      toneMapping: { mode: this.toneMappingMode },
      alphaMode: "premultiplied",
    });

    const shaderModule = this.device.createShaderModule({ code: solidShaderCode });

    // 16バイトアライメント: vec3f(12) + f32(4) = 16
    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba16float" }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  render(color: readonly [number, number, number], brightness: number): void {
    if (!this.device || !this.context || !this.pipeline || !this.uniformBuffer || !this.bindGroup) return;

    const uniformData = new Float32Array([color[0], color[1], color[2], brightness]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const commandEncoder = this.device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }
}

// 色の定義（白は純粋な#ffffffではなく少しずらす）
const colors: Record<string, readonly [number, number, number]> = {
  white: [0.98, 0.98, 0.96], // 少し暖色寄りにずらした白
  red: [1.0, 0.0, 0.0],
  green: [0.0, 1.0, 0.0],
  blue: [0.0, 0.0, 1.0],
  yellow: [1.0, 1.0, 0.0],
  cyan: [0.0, 1.0, 1.0],
  magenta: [1.0, 0.0, 1.0],
};

function checkDrlSupport(): void {
  if (typeof CSS === "undefined" || !CSS.supports("dynamic-range-limit", "standard")) {
    showUnsupportedMessage(
      drlUnsupportedEl,
      "このブラウザは dynamic-range-limit に対応していません。画像は常に標準の明るさで表示されます。",
    );
  }
}

async function initWebGpuDemos(): Promise<void> {
  const items: SupportItem[] = [];

  const hdrDisplay = window.matchMedia("(dynamic-range: high)").matches;
  items.push({
    label: `HDR ディスプレイ: ${hdrDisplay ? "検出" : "非検出"}`,
    ok: hdrDisplay,
    detail: hdrDisplay ? undefined : "SDR ディスプレイでは HDR 部分の差が見えにくい場合があります。",
  });

  if (!navigator.gpu) {
    items.push({ label: "WebGPU: 非対応", ok: false, detail: "Chrome 113 以降などの対応ブラウザで開いてください。" });
    renderSupportList(items);
    const message = "WebGPU に対応していないため、この項目は表示できません。";
    showUnsupportedMessage(gradientUnsupportedEl, message);
    showUnsupportedMessage(solidUnsupportedEl, message);
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    items.push({ label: "WebGPU アダプター: 取得失敗", ok: false });
    renderSupportList(items);
    const message = "WebGPU アダプターを取得できなかったため、この項目は表示できません。";
    showUnsupportedMessage(gradientUnsupportedEl, message);
    showUnsupportedMessage(solidUnsupportedEl, message);
    return;
  }

  const device = await adapter.requestDevice();
  items.push({ label: "WebGPU: 対応", ok: true });
  renderSupportList(items);

  // グラデーションデモ
  const sdrRenderer = new GradientHDRRenderer(document.getElementById("canvas-sdr") as HTMLCanvasElement, "standard");
  const hdrRenderer = new GradientHDRRenderer(document.getElementById("canvas-hdr") as HTMLCanvasElement, "extended");
  await sdrRenderer.init(device);
  await hdrRenderer.init(device);
  gradientCanvasesEl.classList.remove("hidden");
  gradientCanvasesEl.classList.add("flex");
  gradientControlsEl.classList.remove("hidden");
  gradientControlsEl.classList.add("flex");

  const brightnessInputEl = document.getElementById("brightness") as HTMLInputElement;
  const brightnessValueEl = document.getElementById("brightness-value") as HTMLSpanElement;
  const startTime = performance.now();

  function renderGradientFrame(): void {
    const brightness = Number.parseFloat(brightnessInputEl.value);
    brightnessValueEl.textContent = brightness.toFixed(1);
    const time = (performance.now() - startTime) / 1000;

    sdrRenderer.render(brightness, time);
    hdrRenderer.render(brightness, time);

    requestAnimationFrame(renderGradientFrame);
  }
  renderGradientFrame();

  // 単色デモ（両方ともextendedで輝度の違いを比較）
  const solidSdrRenderer = new SolidColorRenderer(document.getElementById("canvas-solid-sdr") as HTMLCanvasElement, "extended");
  const solidHdrRenderer = new SolidColorRenderer(document.getElementById("canvas-solid-hdr") as HTMLCanvasElement, "extended");
  await solidSdrRenderer.init(device);
  await solidHdrRenderer.init(device);
  solidCanvasesEl.classList.remove("hidden");
  solidCanvasesEl.classList.add("flex");
  solidControlsEl.classList.remove("hidden");
  solidControlsEl.classList.add("flex");

  const colorSelectEl = document.getElementById("color-select") as HTMLSelectElement;
  const solidBrightnessInputEl = document.getElementById("solid-brightness") as HTMLInputElement;
  const solidBrightnessValueEl = document.getElementById("solid-brightness-value") as HTMLSpanElement;
  const hdrBrightnessLabelEl = document.getElementById("hdr-brightness-label") as HTMLSpanElement;

  function updateSolidCanvases(): void {
    const color = colors[colorSelectEl.value] ?? colors.white;
    if (!color) return;
    const solidBrightness = Number.parseFloat(solidBrightnessInputEl.value);
    solidBrightnessValueEl.textContent = solidBrightness.toFixed(1);
    hdrBrightnessLabelEl.textContent = solidBrightness.toFixed(1);

    // 左は常に輝度1.0、右は選択したHDR輝度
    solidSdrRenderer.render(color, 1.0);
    solidHdrRenderer.render(color, solidBrightness);
  }

  colorSelectEl.addEventListener("change", updateSolidCanvases);
  solidBrightnessInputEl.addEventListener("input", updateSolidCanvases);
  updateSolidCanvases();
}

checkDrlSupport();
initWebGpuDemos().catch((error: unknown) => {
  console.error(error);
  renderSupportList([{ label: "WebGPU: 初期化中にエラーが発生しました", ok: false, detail: String(error) }]);
  const message = "初期化中にエラーが発生したため、この項目は表示できません。";
  showUnsupportedMessage(gradientUnsupportedEl, message);
  showUnsupportedMessage(solidUnsupportedEl, message);
});
