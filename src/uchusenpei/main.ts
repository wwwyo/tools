import '../global.css';
import './styles.css';
import * as THREE from 'three';
import scriptUrl from './script.json?url';
import { parseScript, type Action, type Beat, type Script } from './script';
import { drawCaption } from './textures';
import { buildActor, type Actor } from './world';

const appEl = document.getElementById('app');
if (!appEl) throw new Error('app element not found');

appEl.innerHTML = `
  <div id="stage" class="relative h-[82dvh] w-full overflow-hidden bg-black select-none touch-none">
    <p id="status" class="absolute inset-0 m-0 flex items-center justify-center text-sm text-muted-foreground">場面を組み立てています…</p>
    <div id="caption" class="pointer-events-none absolute inset-x-0 bottom-20 mx-auto hidden max-w-2xl px-5">
      <div class="rounded bg-black/70 px-4 py-3">
        <p id="caption-chapter" class="m-0 text-xs text-muted-foreground"></p>
        <p id="caption-text" class="m-0 font-serif text-base text-foreground"></p>
      </div>
    </div>
    <div class="absolute inset-x-0 bottom-4 flex flex-wrap items-center justify-center gap-2 px-4">
      <button type="button" id="play" class="ctl" disabled>一時停止</button>
      <button type="button" id="restart" class="ctl" disabled>最初から</button>
      <button type="button" id="speech" class="ctl" aria-pressed="false" disabled>読み上げ: 切</button>
      <button type="button" id="vr" class="ctl ctl-primary" hidden>VRで見る</button>
      <span id="clock" class="text-xs text-muted-foreground tabular-nums"></span>
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
const restartBtn = $<HTMLButtonElement>('restart');
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
// 読み上げ中は次の文へ進まない。声の終わりが届かない端末でも止まり続けないよう、待つのは目安の秒数 + SPEECH_GRACE まで
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

// --- 台本の再生（文ごとの区切りを順に進める） ---
type Tween = { actor: Actor; from: number; to: number; dur: number; elapsed: number };
let script: Script | undefined;
let actors = new Map<string, Actor>();
const levels = new Map<string, number>();
let tweens: Tween[] = [];
let beatIndex = -1;
let beatTime = 0;
let pending: Action[] = [];
let playing = false;
let ended = false;
let caption = { chapter: '', text: '' };

function showCaption(chapter: string, text: string) {
  caption = { chapter, text };
  captionChapterEl.textContent = chapter;
  captionTextEl.textContent = text;
  captionEl.classList.toggle('hidden', !text);
  drawCaption(captionCanvas, chapter, text);
  captionTexture.needsUpdate = true;
  speak(text);
}

function runAction(act: Action) {
  const actor = actors.get(act.target);
  if (!actor) return;
  if (act.do === 'level') {
    if (!actor.applyLevel) return;
    tweens.push({ actor, from: levels.get(act.target) ?? 1, to: act.to, dur: Math.max(act.dur, 0.01), elapsed: 0 });
    levels.set(act.target, act.to);
  } else {
    actor.start?.(act.dur);
  }
}

function enterBeat(index: number) {
  beatIndex = index;
  beatTime = 0;
  const beat: Beat | undefined = script?.beats[index];
  if (!beat) {
    ended = true;
    setPlaying(false);
    playBtn.textContent = 'もう一度';
    return;
  }
  pending = [...(beat.actions ?? [])].sort((a, b) => a.at - b.at);
  showCaption(beat.chapter, beat.text);
}

function advance(dt: number) {
  const beat = script?.beats[beatIndex];
  if (!beat) return;
  beatTime += dt;
  while (pending.length > 0 && (pending[0]?.at ?? Infinity) <= beatTime) {
    const act = pending.shift();
    if (act) runAction(act);
  }
  const waitingForVoice = speaking && beatTime < beat.seconds + SPEECH_GRACE;
  if (beatTime >= beat.seconds && !waitingForVoice) {
    // 文の途中で終わらなかった動きは、次の文へ移る前に出しておく
    for (const act of pending) runAction(act);
    enterBeat(beatIndex + 1);
  }
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const m = mesh.material;
    if (m) for (const mm of Array.isArray(m) ? m : [m]) mm.dispose();
  });
}

function build(s: Script) {
  for (const actor of actors.values()) {
    scene.remove(actor.object);
    disposeObject(actor.object);
  }
  actors = new Map();
  levels.clear();
  tweens = [];
  for (const spec of s.objects) {
    const actor = buildActor(spec);
    actors.set(spec.id, actor);
    levels.set(spec.id, 'level' in spec && typeof spec.level === 'number' ? spec.level : 1);
    scene.add(actor.object);
  }
  ended = false;
  enterBeat(0);
}

function setPlaying(next: boolean) {
  playing = next;
  playBtn.textContent = playing ? '一時停止' : '再生';
  if (!canSpeak) return;
  if (playing) window.speechSynthesis.resume();
  else window.speechSynthesis.pause();
}

function togglePlay() {
  if (!script) return;
  if (ended) {
    build(script);
    setPlaying(true);
    return;
  }
  setPlaying(!playing);
}

playBtn.addEventListener('click', togglePlay);
restartBtn.addEventListener('click', () => {
  if (!script) return;
  build(script);
  setPlaying(true);
});
speechBtn.addEventListener('click', () => {
  speechOn = !speechOn;
  speechBtn.setAttribute('aria-pressed', String(speechOn));
  speechBtn.textContent = speechOn ? '読み上げ: 入' : '読み上げ: 切';
  // 入れたときは今の文から読み直す
  speak(caption.text);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    togglePlay();
  }
});

// VR の中では、コントローラの引き金で一時停止・再開
for (const i of [0, 1]) renderer.xr.getController(i).addEventListener('select', togglePlay);

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
    s.addEventListener('end', () => {
      session = null;
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

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing && script) {
    advance(dt);
    tweens = tweens.filter((tw) => {
      tw.elapsed = Math.min(tw.elapsed + dt, tw.dur);
      tw.actor.applyLevel?.(tw.from + (tw.to - tw.from) * (tw.elapsed / tw.dur));
      return tw.elapsed < tw.dur;
    });
    for (const actor of actors.values()) actor.update?.(dt);
  }
  clockEl.textContent = script && !ended ? `${beatIndex + 1} / ${script.beats.length}` : '';

  if (renderer.xr.isPresenting) {
    const xrCamera = renderer.xr.getCamera();
    xrCamera.getWorldPosition(headPos);
    xrCamera.getWorldDirection(headDir);
    headDir.y = 0;
    if (headDir.lengthSq() > 1e-6) headDir.normalize();
    panelTarget.copy(headPos).addScaledVector(headDir, 2).add(new THREE.Vector3(0, -0.55, 0));
    captionPanel.position.lerp(panelTarget, 1 - Math.exp(-dt * 1.5));
    captionPanel.lookAt(headPos.x, captionPanel.position.y, headPos.z);
    captionPanel.visible = caption.text !== '';
  } else {
    camera.rotation.set(pitch * -1, -yaw, 0);
  }
  renderer.render(scene, camera);
});

// --- 起動 ---
async function boot() {
  try {
    const res = await fetch(scriptUrl);
    const parsed = parseScript(await res.json());
    script = parsed;
    // 月と地球の表面の生成は重いので、「組み立てています」を一度描いてから始める
    await new Promise((r) => setTimeout(r, 30));
    build(parsed);
    statusEl.remove();
    playBtn.disabled = false;
    restartBtn.disabled = false;
    speechBtn.disabled = !canSpeak;
    if (!canSpeak) speechBtn.textContent = '読み上げ: 使えません';
    setPlaying(true);
    await setupVr();
  } catch (err) {
    statusEl.textContent = `台本を読めませんでした: ${err instanceof Error ? err.message : String(err)}`;
  }
}
void boot();
