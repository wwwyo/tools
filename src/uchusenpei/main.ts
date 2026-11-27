import '../global.css';
import './styles.css';
import * as THREE from 'three';
import scriptUrl from './script.json?url';
import { parseScript } from './script';
import { drawCaption } from './textures';
import { compile, type Timeline } from './timeline';
import { buildActor, type Actor } from './world';

const appEl = document.getElementById('app');
if (!appEl) throw new Error('app element not found');

appEl.innerHTML = `
  <div id="stage" class="relative h-[82dvh] w-full overflow-hidden bg-black select-none touch-none">
    <p id="status" class="absolute inset-0 m-0 flex items-center justify-center text-sm text-muted-foreground">場面を組み立てています…</p>
    <div id="caption" class="pointer-events-none absolute inset-x-0 bottom-28 mx-auto hidden max-w-2xl px-5">
      <div class="rounded bg-black/70 px-4 py-3">
        <p id="caption-chapter" class="m-0 text-xs text-muted-foreground"></p>
        <p id="caption-text" class="m-0 font-serif text-base text-foreground"></p>
      </div>
    </div>
    <div class="absolute inset-x-0 bottom-3 mx-auto flex max-w-2xl flex-col gap-2 px-4">
      <input type="range" id="seek" class="w-full accent-primary" min="0" max="1" step="0.1" value="0" aria-label="場面の位置" disabled>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <button type="button" id="prev" class="ctl" disabled>前の文</button>
        <button type="button" id="play" class="ctl" disabled>一時停止</button>
        <button type="button" id="next" class="ctl" disabled>次の文</button>
        <button type="button" id="speech" class="ctl" aria-pressed="false" disabled>読み上げ: 切</button>
        <button type="button" id="vr" class="ctl ctl-primary" hidden>VRで見る</button>
        <span id="clock" class="text-xs text-muted-foreground tabular-nums"></span>
      </div>
    </div>
  </div>
`;

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};
const stage = $('stage');
const statusEl = $('status');
const captionEl = $('caption');
const captionChapterEl = $('caption-chapter');
const captionTextEl = $('caption-text');
const playBtn = $<HTMLButtonElement>('play');
const prevBtn = $<HTMLButtonElement>('prev');
const nextBtn = $<HTMLButtonElement>('next');
const seekEl = $<HTMLInputElement>('seek');
const speechBtn = $<HTMLButtonElement>('speech');
const vrBtn = $<HTMLButtonElement>('vr');
const clockEl = $('clock');

// --- renderer / camera ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
// 座っても立っても使えるよう、床ではなく開始時の頭の位置を原点にする
renderer.xr.setReferenceSpaceType('local');
stage.prepend(renderer.domElement);
renderer.domElement.classList.add('block', 'h-full', 'w-full');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2500);
camera.rotation.order = 'YXZ';

function resize() {
  const { clientWidth: w, clientHeight: h } = stage;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

// --- 画面の上でドラッグして見回す（VR 以外） ---
let yaw = 0;
let pitch = 0.08;
let dragging: { x: number; y: number } | undefined;
renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = { x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw += (e.clientX - dragging.x) * 0.004;
  pitch = THREE.MathUtils.clamp(pitch + (e.clientY - dragging.y) * 0.004, -1.4, 1.4);
  dragging = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', () => (dragging = undefined));
renderer.domElement.addEventListener('pointercancel', () => (dragging = undefined));

// --- VR 内の字幕（頭の向きにゆっくり付いてくる板） ---
const captionCanvas = document.createElement('canvas');
captionCanvas.width = 1280;
captionCanvas.height = 300;
const captionTexture = new THREE.CanvasTexture(captionCanvas);
captionTexture.colorSpace = THREE.SRGBColorSpace;
const captionPanel = new THREE.Mesh(
  new THREE.PlaneGeometry(1.6, 0.375),
  new THREE.MeshBasicMaterial({ map: captionTexture, transparent: true, depthTest: false }),
);
captionPanel.renderOrder = 10;
captionPanel.visible = false;
scene.add(captionPanel);

// --- 読み上げ（ブラウザ内蔵の音声合成。外部サービスは使わない） ---
const canSpeak = 'speechSynthesis' in window;
let speechOn = false;
// 読み上げ中は文の終わりで台本の時計を止めて待つ。声の終わりが届かない端末でも止まり続けないよう、待つのは SPEECH_GRACE 秒まで
let speaking = false;
const SPEECH_GRACE = 15;
function speak(text: string) {
  if (!canSpeak) return;
  window.speechSynthesis.cancel();
  speaking = false;
  if (!speechOn || !text) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[（）]/g, ''));
  u.lang = 'ja-JP';
  u.rate = 1;
  u.onend = () => (speaking = false);
  u.onerror = () => (speaking = false);
  speaking = true;
  window.speechSynthesis.speak(u);
}

// --- 台本の再生 ---
// 台本の時計 time だけを進め、毎フレーム「time での状態」を台本から計算して描く。
// 途中の状態を積み上げないので、どの文・どの時刻へ飛んでも、そこまで再生したときと同じ見え方になる。
let timeline: Timeline | undefined;
const actors = new Map<string, Actor>();
let time = 0;
let beatIndex = -1;
let holding = 0;
let playing = false;
let seeking = false;

function showBeat(index: number) {
  const span = timeline?.beats[index];
  beatIndex = index;
  holding = 0;
  const chapter = span?.beat.chapter ?? '';
  const text = span?.beat.text ?? '';
  captionChapterEl.textContent = chapter;
  captionTextEl.textContent = text;
  captionEl.classList.toggle('hidden', !text);
  drawCaption(captionCanvas, chapter, text);
  captionTexture.needsUpdate = true;
  speak(text);
  // 今の文を URL に残す。開き直すとこの文から始まる
  if (span) history.replaceState(null, '', `#${span.beat.id}`);
}

function seek(t: number) {
  if (!timeline) return;
  time = Math.min(Math.max(t, 0), timeline.total);
  const index = timeline.beatAt(time);
  if (index !== beatIndex) showBeat(index);
}

function seekBeat(index: number) {
  const span = timeline?.beats[Math.min(Math.max(index, 0), (timeline?.beats.length ?? 1) - 1)];
  if (!span) return;
  beatIndex = -1; // 同じ文でも読み直す
  seek(span.start);
}

function setPlaying(next: boolean) {
  playing = next;
  playBtn.textContent = playing ? '一時停止' : '再生';
  if (!canSpeak) return;
  if (playing) window.speechSynthesis.resume();
  else window.speechSynthesis.pause();
}

function togglePlay() {
  if (!timeline) return;
  if (!playing && time >= timeline.total) seekBeat(0);
  setPlaying(!playing);
}

function tick(dt: number) {
  if (!timeline || !playing) return;
  const span = timeline.beats[beatIndex];
  let next = time + dt;
  if (span && next >= span.end && speaking && holding < SPEECH_GRACE) {
    // 声がまだ続いているので、文の終わりの手前で時計を止めて待つ
    holding += dt;
    next = Math.max(time, span.end - 0.001);
  }
  seek(next);
  if (time >= timeline.total) {
    setPlaying(false);
    playBtn.textContent = 'もう一度';
  }
}

playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', () => seekBeat(beatIndex - 1));
nextBtn.addEventListener('click', () => seekBeat(beatIndex + 1));
seekEl.addEventListener('input', () => {
  seeking = true;
  seek(Number(seekEl.value));
});
seekEl.addEventListener('change', () => (seeking = false));
speechBtn.addEventListener('click', () => {
  speechOn = !speechOn;
  speechBtn.setAttribute('aria-pressed', String(speechOn));
  speechBtn.textContent = speechOn ? '読み上げ: 入' : '読み上げ: 切';
  // 入れたときは今の文から読み直す
  speak(captionTextEl.textContent ?? '');
  if (!playing && canSpeak) window.speechSynthesis.pause();
});
window.addEventListener('keydown', (e) => {
  if (e.target !== document.body) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'ArrowRight') {
    seekBeat(beatIndex + 1);
  } else if (e.code === 'ArrowLeft') {
    seekBeat(beatIndex - 1);
  }
});

// VR の中では、引き金で一時停止・再開、握りボタンで次の文
for (const i of [0, 1]) {
  const controller = renderer.xr.getController(i);
  controller.addEventListener('select', togglePlay);
  controller.addEventListener('squeeze', () => seekBeat(beatIndex + 1));
}

// --- WebXR ---
async function setupVr() {
  if (!navigator.xr) return;
  const supported = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!supported) return;
  vrBtn.hidden = false;
  let session: XRSession | null = null;
  vrBtn.addEventListener('click', async () => {
    if (session) {
      await session.end();
      return;
    }
    const s = await navigator.xr?.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    if (!s) return;
    session = s;
    // VR 中は頭の位置が camera.position に書き込まれるので、終えたら画面での視点に戻す
    const desktopPosition = camera.position.clone();
    s.addEventListener('end', () => {
      session = null;
      camera.position.copy(desktopPosition);
      vrBtn.textContent = 'VRで見る';
      captionPanel.visible = false;
    });
    await renderer.xr.setSession(s);
    vrBtn.textContent = 'VRを終える';
    captionPanel.visible = true;
  });
}

// --- 毎フレーム ---
const clock = new THREE.Clock();
const headPos = new THREE.Vector3();
const headDir = new THREE.Vector3();
const panelTarget = new THREE.Vector3();
const panelOffset = new THREE.Vector3(0, -0.55, 0);

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  tick(dt);
  if (timeline) {
    for (const [id, actor] of actors) actor.render?.(timeline.stateAt(id, time));
    if (!seeking) seekEl.value = String(time);
    clockEl.textContent = `${beatIndex + 1} / ${timeline.beats.length}`;
  }

  if (renderer.xr.isPresenting) {
    const xrCamera = renderer.xr.getCamera();
    xrCamera.getWorldPosition(headPos);
    xrCamera.getWorldDirection(headDir);
    headDir.y = 0;
    if (headDir.lengthSq() > 1e-6) headDir.normalize();
    panelTarget.copy(headPos).addScaledVector(headDir, 2).add(panelOffset);
    captionPanel.position.lerp(panelTarget, 1 - Math.exp(-dt * 1.5));
    captionPanel.lookAt(headPos.x, captionPanel.position.y, headPos.z);
    captionPanel.visible = !captionEl.classList.contains('hidden');
  } else {
    camera.rotation.set(-pitch, -yaw, 0);
  }
  renderer.render(scene, camera);
});

// --- 起動 ---
async function boot() {
  try {
    const res = await fetch(scriptUrl);
    const script = parseScript(await res.json());
    // 月と地球の表面の生成は重いので、「組み立てています」を一度描いてから始める
    await new Promise((r) => setTimeout(r, 30));
    for (const spec of script.objects) {
      const actor = buildActor(spec);
      actors.set(spec.id, actor);
      scene.add(actor.object);
    }
    timeline = compile(script);
    seekEl.max = String(timeline.total);
    statusEl.remove();
    for (const el of [playBtn, prevBtn, nextBtn, seekEl]) el.disabled = false;
    speechBtn.disabled = !canSpeak;
    if (!canSpeak) speechBtn.textContent = '読み上げ: 使えません';
    // URL の #b06 のような文の id があれば、その文から始める
    const startId = decodeURIComponent(location.hash.slice(1));
    const startIndex = timeline.beats.findIndex((b) => b.beat.id === startId);
    seekBeat(startIndex === -1 ? 0 : startIndex);
    setPlaying(true);
    await setupVr();
  } catch (err) {
    statusEl.textContent = `台本を読めませんでした: ${err instanceof Error ? err.message : String(err)}`;
  }
}
void boot();
