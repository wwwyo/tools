/**
 * 「HDR が明るく見える仕組み」の解説デモ（CSS dynamic-range-limit / HDR PNG / WebGPU 比較）。
 * 変換ツール本体（main.ts）とは独立した読み物パートなので、HTML 断片とロジックをここに閉じ込める。
 * WebGPU の初期化はコストがあるため、呼び出し側（main.ts）が <details> の初回 open 時にのみ
 * initDemos() を呼ぶ想定。
 */
import ultraHdrJpg from "./ultra-hdr.jpg";
import hdrPng from "./hdr.png";

/** disclosure に差し込む HTML。id は本体側（main.ts）の要素と衝突しないよう demo- 接頭辞を付ける */
export function demosSectionHtml(): string {
  return `
    <section class="flex flex-col gap-2 rounded border border-border bg-card px-4 py-3">
      <h3 class="text-sm font-bold text-muted-foreground">デモの動作状況</h3>
      <ul id="demo-support-list" class="flex flex-col gap-1 text-sm"></ul>
    </section>

    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <h3 class="text-lg font-bold">1. CSS の dynamic-range-limit で切り替える</h3>
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
          ここで使っているのは UltraHDR 形式の JPEG で、通常の JPEG に加えて
          「どこをどれだけ持ち上げるか」を記録したゲインマップを内包しています。
        </p>
        <p class="text-xs text-muted-foreground">
          この項目のデモとサンプル画像は
          <a
            href="https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/dynamic-range-limit"
            target="_blank"
            rel="noreferrer"
            class="underline underline-offset-2 hover:text-foreground"
          >MDN Web Docs: dynamic-range-limit</a>
          の例をもとにしています。画像は
          <a
            href="https://mdn.github.io/shared-assets/images/examples/ultra-hdr.jpg"
            target="_blank"
            rel="noreferrer"
            class="underline underline-offset-2 hover:text-foreground"
          >mdn/shared-assets の ultra-hdr.jpg</a>
          です。
        </p>
      </div>
      <div id="demo-drl-unsupported" class="hidden rounded border border-dashed border-border px-4 py-3 text-sm text-muted-foreground"></div>
      <div class="flex flex-col gap-6 sm:flex-row">
        <figure class="flex flex-1 flex-col gap-2">
          <img
            src="${ultraHdrJpg}"
            alt="UltraHDR形式のサンプル写真。ホバーまたはフォーカスすると白い部分の明るさが変わる"
            tabindex="0"
            class="drl-hover w-full rounded border border-border"
          />
          <figcaption class="text-xs text-muted-foreground">ホバー / フォーカスで standard ⇔ no-limit</figcaption>
        </figure>
        <figure class="flex flex-1 flex-col gap-2">
          <img
            src="${ultraHdrJpg}"
            alt="同じUltraHDR写真をno-limit固定で表示したもの。常に最大輝度で表示される"
            class="drl-no-limit w-full rounded border border-border"
          />
          <figcaption class="text-xs text-muted-foreground">常に no-limit（比較用）</figcaption>
        </figure>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <h3 class="text-lg font-bold">2. HDR 画像をそのまま埋め込む</h3>
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
        <h3 class="text-lg font-bold">3. WebGPU で SDR と HDR を並べて描く</h3>
        <p class="text-sm text-muted-foreground">
          左は <code>format: navigator.gpu.getPreferredCanvasFormat()</code>（8bit）の canvas です。
          8bit フォーマットは 1.0 を超える値を物理的に保持できないため、レンダーターゲットへの
          書き込み時点でクランプが確定します。<code>toneMapping</code> の実装差にもコンポジタの
          挙動にも依存しない、本物の SDR パイプラインです。右は <code>format: "rgba16float"</code> +
          <code>toneMapping: { mode: "extended" }</code> で、1.0 を超えるコード値をそのまま出力できます。
        </p>
        <p class="text-sm text-muted-foreground">
          比べるべきは「明るさ」ではなく、上半分のランプがどこまで伸びるかです。左は
          100 cd/m²（SDR の白）に到達すると、そこから右がずっと平坦になります。右は端まで明るくなり続けます。
          「どこで階調が止まったか」が差になります。HDR 非対応のディスプレイ・ブラウザでは
          両方同じ見た目になるのが正しい挙動です。
        </p>
        <p class="text-sm text-muted-foreground">
          スライダーはディスプレイが実際に出す明るさの単位である cd/m² で指定しますが、canvas
          に渡す値は輝度そのものではなく extended sRGB のコード値なので、内部で換算しています。
          SDR の白は 100 cd/m²（コード値 1.0）が基準です。指定した輝度が実際に出るかはディスプレイの
          ヘッドルーム次第で、XDR でもピーク輝度は 1600 cd/m² 程度なので、上限付近では頭打ちになります。
        </p>
      </div>
      <div id="demo-gradient-unsupported" class="hidden rounded border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"></div>
      <div id="demo-gradient-canvases" class="hidden flex-col gap-6 sm:flex-row">
        <div class="flex flex-1 flex-col gap-2">
          <h4 class="text-sm font-bold text-muted-foreground">SDR（8bit・クランプ確定）</h4>
          <canvas id="demo-canvas-sdr" width="400" height="300" class="w-full rounded border border-border"></canvas>
        </div>
        <div class="flex flex-1 flex-col gap-2">
          <h4 class="text-sm font-bold text-muted-foreground">HDR（rgba16float・extended）</h4>
          <canvas id="demo-canvas-hdr" width="400" height="300" class="w-full rounded border border-border"></canvas>
        </div>
      </div>
      <label id="demo-gradient-controls" class="hidden flex-col gap-1.5 text-sm sm:flex-row sm:items-center sm:gap-3">
        <span class="text-muted-foreground">ランプ右端の輝度（cd/m²）</span>
        <input type="range" id="demo-brightness" min="100" max="2000" step="50" value="400" class="w-full accent-primary sm:max-w-64" />
        <span id="demo-brightness-value" class="font-mono text-xs tabular-nums">400 cd/m²</span>
      </label>
    </section>

    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <h3 class="text-lg font-bold">4. 単色で輝度だけを比較する</h3>
        <p class="text-sm text-muted-foreground">
          形や模様を取り除き、同じ色を輝度だけ変えて並べます。左は 100 cd/m²（SDR の白）に固定、
          右はスライダーで選んだ輝度（cd/m²）です。HDR ディスプレイでは右側がより明るく光って見えます。
        </p>
        <p class="text-sm text-muted-foreground">
          ここも指定は cd/m² ですが、canvas に渡すのは extended sRGB のコード値なので内部で
          換算しています。SDR の白は 100 cd/m²（コード値 1.0）基準で、XDR でもピーク輝度は
          1600 cd/m² 程度なので、上限付近では指定どおりの明るさにならず頭打ちになります。
        </p>
      </div>
      <div id="demo-solid-unsupported" class="hidden rounded border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"></div>
      <div id="demo-solid-canvases" class="hidden flex-col gap-6 sm:flex-row">
        <div class="flex flex-1 flex-col gap-2">
          <h4 class="text-sm font-bold text-muted-foreground">100 cd/m²（SDR の白）</h4>
          <canvas id="demo-canvas-solid-sdr" width="400" height="200" class="w-full rounded border border-border"></canvas>
        </div>
        <div class="flex flex-1 flex-col gap-2">
          <h4 class="text-sm font-bold text-muted-foreground"><span id="demo-hdr-brightness-label">400</span> cd/m²（HDR）</h4>
          <canvas id="demo-canvas-solid-hdr" width="400" height="200" class="w-full rounded border border-border"></canvas>
        </div>
      </div>
      <div id="demo-solid-controls" class="hidden flex-col gap-3 text-sm sm:flex-row sm:items-center">
        <label class="flex items-center gap-2">
          <span class="text-muted-foreground">色</span>
          <select id="demo-color-select" class="rounded border border-border bg-card px-2 py-1 text-foreground">
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
          <span class="text-muted-foreground">輝度（cd/m²）</span>
          <input type="range" id="demo-solid-brightness" min="100" max="2000" step="50" value="400" class="w-full accent-primary" />
          <span id="demo-solid-brightness-value" class="font-mono text-xs tabular-nums">400 cd/m²</span>
        </label>
      </div>
    </section>
  `;
}

type SupportItem = { label: string; ok: boolean; detail?: string };

function renderSupportList(el: HTMLUListElement, items: SupportItem[]): void {
  el.innerHTML = items
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

/** SDR の基準白の輝度。Rec.709 / sRGB のスタジオ基準値 */
const SDR_WHITE_CD = 100;

/**
 * cd/m² を extended sRGB のコード値へ変換する。
 * canvas の値は線形光ではなく sRGB 伝達関数でエンコードされたコード値として
 * 解釈されるため、輝度をそのまま渡すと桁違いに明るくなる。
 */
function cdToCodeValue(cd: number): number {
  const linear = cd / SDR_WHITE_CD;
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
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

    // WebGPU の NDC→フレームバッファ変換により、uv.y は 0 が画面上端・1 が画面下端になる。
    // 輝度ランプを画面上半分（uv.y < 0.5）に大きく取り、SDR/HDR の差の主役にする。
    // 装飾の円と離すことで、SDR 側が「どこで階調が止まるか」を邪魔されずに見せる。
    if (uv.y < 0.5) {
      let barLuminance = uv.x * brightness * 2.0;
      color = vec3f(barLuminance);

      // 目盛り線: 0.25 / 0.5 / 0.75 の位置に細い基準線を引く（暗めのグレーで、飽和しても潰れない）
      let grid1 = 1.0 - smoothstep(0.0, 0.0015, abs(uv.x - 0.25));
      let grid2 = 1.0 - smoothstep(0.0, 0.0015, abs(uv.x - 0.5));
      let grid3 = 1.0 - smoothstep(0.0, 0.0015, abs(uv.x - 0.75));
      color = mix(color, vec3f(0.4), (grid1 + grid2 + grid3) * 0.4);

      // barLuminance = uv.x * brightness * 2.0 が 1.0 と交わる x 位置 = 1.0 / (brightness * 2.0)。
      // ここが SDR の白 = 100 cd/m²（コード値 1.0）に一致する位置なので、目印として示す。
      // 輝度を 1.0 未満（0.9, 0.35, 0.05）に抑えているので、SDR 側でも飽和せず目印として見える。
      let thresholdX = 1.0 / (brightness * 2.0);
      if (thresholdX <= 1.0) {
        let distToThreshold = abs(uv.x - thresholdX);
        let marker = 1.0 - smoothstep(0.0, 0.004, distToThreshold);
        color = mix(color, vec3f(0.9, 0.35, 0.05), marker);
      }
    }

    // 輝く円たち（画面下半分に配置。ランプ帯（uv.y<0.5）を汚さないよう境界に余白を残す）
    let aspect = 400.0 / 300.0;
    let p = vec2f(uv.x * aspect, uv.y);

    // 赤い円
    let redCenter = vec2f(0.33 * aspect, 0.86);
    let redGlow = smoothCircle(p, redCenter, 0.12, 0.15);
    let redColor = vec3f(brightness * 1.5, 0.1, 0.1) * redGlow;
    color += redColor;

    // 緑の円
    let greenCenter = vec2f(0.5 * aspect, 0.86);
    let greenGlow = smoothCircle(p, greenCenter, 0.12, 0.15);
    let greenColor = vec3f(0.1, brightness * 1.5, 0.1) * greenGlow;
    color += greenColor;

    // 青い円
    let blueCenter = vec2f(0.67 * aspect, 0.86);
    let blueGlow = smoothCircle(p, blueCenter, 0.12, 0.15);
    let blueColor = vec3f(0.1, 0.1, brightness * 1.5) * blueGlow;
    color += blueColor;

    // 白い輝く円 - 係数を 2.5 から 0.6 に下げた。スライダー既定値(1.5)で 0.9 と 1.0 未満に収まり、
    // SDR 側でも階調を保ったまま光る。ここが飽和すると「白飽和 vs 白超え」の差になり、
    // 主役であるランプの「階調が止まる/止まらない」という構造の差が霞んでしまうため。
    let whiteCenter = vec2f(0.5 * aspect, 0.72);
    let whiteGlow = smoothCircle(p, whiteCenter, 0.1, 0.12);
    let whiteColor = vec3f(brightness * 0.6) * whiteGlow;
    color += whiteColor;

    // パルスする輝点（アニメーション）
    let pulseIntensity = 0.5 + 0.5 * sin(time * 2.0);
    let sparkleCenter = vec2f(0.5 * aspect, 0.95);
    let sparkleGlow = smoothCircle(p, sparkleCenter, 0.03, 0.05);
    let sparkleColor = vec3f(brightness * 3.0 * pulseIntensity) * sparkleGlow;
    color += sparkleColor;

    return vec4f(color, 1.0);
  }
`;

type ToneMappingMode = "standard" | "extended";

/**
 * canvas に適用する WebGPU の描画設定。
 * SDR 側は 8bit フォーマット（クランプが GPU 側で確定する）、HDR 側は rgba16float +
 * extended という異なる設定を使うため、レンダラーの外から可変にする。
 * `fragment.targets[0].format` は canvas の configure() の format と一致している必要があるため、
 * このオブジェクト1つを両方に使い回すことで不一致を構造的に防ぐ。
 */
type CanvasRenderConfig = {
  readonly format: GPUTextureFormat;
  readonly toneMapping?: ToneMappingMode;
};

/** getConfiguration() から読み取った、実際に適用されている設定の自己診断結果 */
type ConfigDiagnostics = { readonly ok: boolean; readonly detail: string };

/** グラデーションの輝く円たちを描くレンダラー */
class GradientHDRRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderConfig: CanvasRenderConfig;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  constructor(canvas: HTMLCanvasElement, renderConfig: CanvasRenderConfig) {
    this.canvas = canvas;
    this.renderConfig = renderConfig;
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
      format: this.renderConfig.format,
      // SDR 側は toneMapping を指定しない（既定 = standard 相当）。8bit フォーマット自体が
      // 1.0 超えの値を保持できないため、toneMapping の実装差に関係なくクランプが確定する。
      ...(this.renderConfig.toneMapping ? { toneMapping: { mode: this.renderConfig.toneMapping } } : {}),
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
        // canvas の configure() に渡した format と必ず一致させる（不一致は実行時例外になる）
        targets: [{ format: this.renderConfig.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  /** getConfiguration()（Chrome 131+）で実際に適用された format / toneMapping.mode を読む自己診断 */
  getConfigDiagnostics(): ConfigDiagnostics {
    if (!this.context || typeof this.context.getConfiguration !== "function") {
      return { ok: false, detail: "確認できません（getConfiguration 未対応。Chrome 131 以降が必要です）" };
    }
    const configuration = this.context.getConfiguration();
    if (!configuration) {
      return { ok: false, detail: "確認できません（context が未設定です）" };
    }
    const toneModeText = configuration.toneMapping?.mode ?? "指定なし（既定 = standard 相当）";
    return { ok: true, detail: `format: ${configuration.format} / toneMapping.mode: ${toneModeText}` };
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

function checkDrlSupport(drlUnsupportedEl: HTMLDivElement): void {
  if (typeof CSS === "undefined" || !CSS.supports("dynamic-range-limit", "standard")) {
    showUnsupportedMessage(
      drlUnsupportedEl,
      "このブラウザは dynamic-range-limit に対応していません。画像は常に標準の明るさで表示されます。",
    );
  }
}

async function initWebGpuDemos(): Promise<void> {
  const supportListEl = document.getElementById("demo-support-list") as HTMLUListElement;
  const gradientUnsupportedEl = document.getElementById("demo-gradient-unsupported") as HTMLDivElement;
  const gradientCanvasesEl = document.getElementById("demo-gradient-canvases") as HTMLDivElement;
  const gradientControlsEl = document.getElementById("demo-gradient-controls") as HTMLLabelElement;
  const solidUnsupportedEl = document.getElementById("demo-solid-unsupported") as HTMLDivElement;
  const solidCanvasesEl = document.getElementById("demo-solid-canvases") as HTMLDivElement;
  const solidControlsEl = document.getElementById("demo-solid-controls") as HTMLDivElement;

  const items: SupportItem[] = [];

  const hdrDisplay = window.matchMedia("(dynamic-range: high)").matches;
  items.push({
    label: `HDR ディスプレイ: ${hdrDisplay ? "検出" : "非検出"}`,
    ok: hdrDisplay,
    detail: hdrDisplay ? undefined : "SDR ディスプレイでは HDR 部分の差が見えにくい場合があります。",
  });

  if (!navigator.gpu) {
    items.push({ label: "WebGPU: 非対応", ok: false, detail: "Chrome 113 以降などの対応ブラウザで開いてください。" });
    renderSupportList(supportListEl, items);
    const message = "WebGPU に対応していないため、この項目は表示できません。";
    showUnsupportedMessage(gradientUnsupportedEl, message);
    showUnsupportedMessage(solidUnsupportedEl, message);
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    items.push({ label: "WebGPU アダプター: 取得失敗", ok: false });
    renderSupportList(supportListEl, items);
    const message = "WebGPU アダプターを取得できなかったため、この項目は表示できません。";
    showUnsupportedMessage(gradientUnsupportedEl, message);
    showUnsupportedMessage(solidUnsupportedEl, message);
    return;
  }

  const device = await adapter.requestDevice();
  items.push({ label: "WebGPU: 対応", ok: true });
  renderSupportList(supportListEl, items);

  // グラデーションデモ
  // SDR 側: 8bit フォーマット（通常 bgra8unorm）。1.0 超えの値を物理的に保持できないため、
  // GPU 側の書き込み時点でクランプが確定する。toneMapping は指定しない（既定 = standard 相当）
  const sdrRenderer = new GradientHDRRenderer(document.getElementById("demo-canvas-sdr") as HTMLCanvasElement, {
    format: navigator.gpu.getPreferredCanvasFormat(),
  });
  // HDR 側: rgba16float + extended。1.0 超えの輝度値をそのまま保持・出力できる
  const hdrRenderer = new GradientHDRRenderer(document.getElementById("demo-canvas-hdr") as HTMLCanvasElement, {
    format: "rgba16float",
    toneMapping: "extended",
  });
  await sdrRenderer.init(device);
  await hdrRenderer.init(device);
  gradientCanvasesEl.classList.remove("hidden");
  gradientCanvasesEl.classList.add("flex");
  gradientControlsEl.classList.remove("hidden");
  gradientControlsEl.classList.add("flex");

  // 自己診断: getConfiguration() で実際に適用された設定を読み、ブラウザが toneMapping を
  // 無視しているようなケースを一目で切り分けられるようにする
  const sdrDiagnostics = sdrRenderer.getConfigDiagnostics();
  items.push({ label: "SDR canvas の適用設定", ok: sdrDiagnostics.ok, detail: sdrDiagnostics.detail });
  const hdrDiagnostics = hdrRenderer.getConfigDiagnostics();
  items.push({ label: "HDR canvas の適用設定", ok: hdrDiagnostics.ok, detail: hdrDiagnostics.detail });
  renderSupportList(supportListEl, items);

  const brightnessInputEl = document.getElementById("demo-brightness") as HTMLInputElement;
  const brightnessValueEl = document.getElementById("demo-brightness-value") as HTMLSpanElement;
  const startTime = performance.now();

  function renderGradientFrame(): void {
    const brightnessCd = Number.parseFloat(brightnessInputEl.value);
    brightnessValueEl.textContent = `${brightnessCd.toFixed(0)} cd/m²`;
    const time = (performance.now() - startTime) / 1000;

    // ランプ右端（uv.x = 1）のコード値が brightness * 2.0 になる（シェーダ側の式）ため、
    // 右端の輝度が指定した cd/m² と一致するよう半分にして渡す
    const brightnessCode = cdToCodeValue(brightnessCd) / 2.0;
    sdrRenderer.render(brightnessCode, time);
    hdrRenderer.render(brightnessCode, time);

    requestAnimationFrame(renderGradientFrame);
  }
  renderGradientFrame();

  // 単色デモ（両方ともextendedで輝度の違いを比較）
  const solidSdrRenderer = new SolidColorRenderer(document.getElementById("demo-canvas-solid-sdr") as HTMLCanvasElement, "extended");
  const solidHdrRenderer = new SolidColorRenderer(document.getElementById("demo-canvas-solid-hdr") as HTMLCanvasElement, "extended");
  await solidSdrRenderer.init(device);
  await solidHdrRenderer.init(device);
  solidCanvasesEl.classList.remove("hidden");
  solidCanvasesEl.classList.add("flex");
  solidControlsEl.classList.remove("hidden");
  solidControlsEl.classList.add("flex");

  const colorSelectEl = document.getElementById("demo-color-select") as HTMLSelectElement;
  const solidBrightnessInputEl = document.getElementById("demo-solid-brightness") as HTMLInputElement;
  const solidBrightnessValueEl = document.getElementById("demo-solid-brightness-value") as HTMLSpanElement;
  const hdrBrightnessLabelEl = document.getElementById("demo-hdr-brightness-label") as HTMLSpanElement;

  function updateSolidCanvases(): void {
    const color = colors[colorSelectEl.value] ?? colors.white;
    if (!color) return;
    const solidBrightnessCd = Number.parseFloat(solidBrightnessInputEl.value);
    solidBrightnessValueEl.textContent = `${solidBrightnessCd.toFixed(0)} cd/m²`;
    hdrBrightnessLabelEl.textContent = solidBrightnessCd.toFixed(0);

    // 左は常に SDR の白（100 cd/m² = コード値 1.0）、右は選択した輝度をコード値に変換して描画
    solidSdrRenderer.render(color, 1.0);
    solidHdrRenderer.render(color, cdToCodeValue(solidBrightnessCd));
  }

  colorSelectEl.addEventListener("change", updateSolidCanvases);
  solidBrightnessInputEl.addEventListener("input", updateSolidCanvases);
  updateSolidCanvases();
}

let demosInitialized = false;

/**
 * デモ一式を初期化する。WebGPU の adapter/device 取得はコストがあるため、
 * 呼び出し側は <details> が初めて開かれたタイミングでのみこれを呼ぶこと。
 * 2 回目以降の呼び出しは no-op（副作用の重複実行を防ぐ）。
 */
export function initDemos(): void {
  if (demosInitialized) return;
  demosInitialized = true;

  const drlUnsupportedEl = document.getElementById("demo-drl-unsupported") as HTMLDivElement;
  checkDrlSupport(drlUnsupportedEl);

  initWebGpuDemos().catch((error: unknown) => {
    console.error(error);
    const supportListEl = document.getElementById("demo-support-list") as HTMLUListElement;
    renderSupportList(supportListEl, [{ label: "WebGPU: 初期化中にエラーが発生しました", ok: false, detail: String(error) }]);
    const message = "初期化中にエラーが発生したため、この項目は表示できません。";
    showUnsupportedMessage(document.getElementById("demo-gradient-unsupported") as HTMLDivElement, message);
    showUnsupportedMessage(document.getElementById("demo-solid-unsupported") as HTMLDivElement, message);
  });
}
