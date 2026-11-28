// 台本の objects を three.js の物に組み立てる。
// 物は render(state, ctx) だけを持ち、見た目を「その時刻の状態」だけから決める（前のフレームに依存しない）。
// state は timeline.ts が台本から計算する: 台本の時刻 t、見え方 level（0〜1）、直近の start からの経過 since。
// ctx.poseAt は艇の位置。艇から出る光や物は、それを使って「その時刻に艇がどこにいたか」から決める。

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ObjectSpec, Pose, Vec3 } from './script';
import { makeEarthTexture, makeMoonTextures, mulberry32 } from './textures';
import type { ActorState } from './timeline';

export type RenderContext = { poseAt: (t: number) => Pose };

export type Actor = {
  object: THREE.Object3D;
  render?: (state: ActorState, ctx: RenderContext) => void;
};

// start からの進み具合（0〜1）。まだ始まっていなければ 0
const progress = (s: ActorState) => (s.since === null ? 0 : Math.min(s.since / s.dur, 1));

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

// 太陽の向き。地球の大気の光り方に使うので、sunlight が組み立てられたときに書き込む
const sunDirection = new THREE.Vector3(1, 0, 0);

// 手続き生成は Quest だと数秒かかるので、最初からやり直しても作り直さない
let moonCache: { color: THREE.Texture; bump: THREE.Texture } | undefined;
let earthCache: THREE.Texture | undefined;
let glowCache: THREE.Texture | undefined;

function moonTextures() {
  if (!moonCache) {
    const { color, bump } = makeMoonTextures();
    const colorTex = new THREE.CanvasTexture(color);
    colorTex.colorSpace = THREE.SRGBColorSpace;
    colorTex.anisotropy = 4;
    moonCache = { color: colorTex, bump: new THREE.CanvasTexture(bump) };
  }
  return moonCache;
}

function earthTexture() {
  if (!earthCache) {
    earthCache = new THREE.CanvasTexture(makeEarthTexture());
    earthCache.colorSpace = THREE.SRGBColorSpace;
  }
  return earthCache;
}

// 中心が明るく、外へ向かってなめらかに消える丸。太陽・星・光源のにじみに使う
function glowTexture() {
  if (!glowCache) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.12, 'rgba(255,255,255,0.75)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }
    glowCache = new THREE.CanvasTexture(canvas);
    glowCache.colorSpace = THREE.SRGBColorSpace;
  }
  return glowCache;
}

function glowSprite(color: THREE.ColorRepresentation, size: number, opacity = 1): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

function stars(spec: Extract<ObjectSpec, { type: 'stars' }>): Actor {
  const rand = mulberry32(spec.seed);
  const group = new THREE.Group();
  // 細かい星と、少数の明るくにじむ星の二層
  const layers = [
    { count: spec.count, size: 1.5, map: null, bright: 0.5 },
    { count: Math.round(spec.count / 10), size: 7, map: glowTexture(), bright: 1 },
  ];
  for (const layer of layers) {
    const positions = new Float32Array(layer.count * 3);
    const colors = new Float32Array(layer.count * 3);
    for (let i = 0; i < layer.count; i++) {
      const u = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      positions.set([s * Math.cos(a) * spec.radius, u * spec.radius, s * Math.sin(a) * spec.radius], i * 3);
      // 「寒そうな光」: 大半は青白く、たまに暖色
      const b = layer.bright * (0.45 + Math.pow(rand(), 3) * 0.55);
      const warm = rand() < 0.12;
      colors.set(warm ? [b, b * 0.85, b * 0.7] : [b * 0.82, b * 0.9, b], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: layer.size,
      sizeAttenuation: false,
      vertexColors: true,
      map: layer.map,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    group.add(new THREE.Points(geometry, material));
  }
  return { object: group };
}

function sunlight(spec: Extract<ObjectSpec, { type: 'sunlight' }>): Actor {
  sunDirection.copy(v3(spec.direction).normalize());
  const light = new THREE.DirectionalLight(0xfff4e6, spec.intensity);
  light.position.copy(sunDirection).multiplyScalar(500);
  const ambient = new THREE.AmbientLight(0x3a4660, 0.12);
  const group = new THREE.Group();
  group.add(light, light.target, ambient);
  // 太陽そのもの。星より遠く、まぶしいにじみを重ねる
  const disc = new THREE.Group();
  disc.position.copy(sunDirection).multiplyScalar(1400);
  disc.add(glowSprite(0xffffff, 70), glowSprite(0xffe2b0, 260, 0.6), glowSprite(0xffc890, 900, 0.18));
  group.add(disc);
  return {
    object: group,
    // level は艇のまわりの明るさ（宇宙の墓地では暗くなり、探照灯だけが照らす）
    render: (s) => {
      light.intensity = spec.intensity * s.level;
      ambient.intensity = 0.04 + 0.08 * s.level;
    },
  };
}

function moon(spec: Extract<ObjectSpec, { type: 'moon' }>): Actor {
  const tex = moonTextures();
  const material = new THREE.MeshStandardMaterial({
    map: tex.color,
    bumpMap: tex.bump,
    bumpScale: 1.6,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radius, 128, 96), material);
  mesh.position.copy(v3(spec.position));
  // 「青白く輝き」: 月のまわりに淡い青白いにじみ
  const halo = glowSprite(0xb8d0ff, spec.radius * 3.4, 0);
  halo.position.copy(mesh.position);
  const group = new THREE.Group();
  group.add(mesh, halo);
  const base = new THREE.Color(0xe6eeff);
  // level は月の明るさ（展望室で見えてくる）
  return {
    object: group,
    render: (s) => {
      material.color.copy(base).multiplyScalar(0.3 + 0.9 * s.level);
      halo.material.opacity = 0.22 * s.level;
      mesh.rotation.y = -0.6 + s.t * 0.004;
    },
  };
}

// 地球の大気。ふちほど明るく、太陽側ほど強く光る
function atmosphereMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { sun: { value: sunDirection }, tint: { value: color } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sun;
      uniform vec3 tint;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 view = normalize(cameraPosition - vWorld);
        float rim = pow(1.0 - abs(dot(vNormal, view)), 2.5);
        float lit = smoothstep(-0.35, 0.5, dot(vNormal, sun));
        gl_FragColor = vec4(tint * rim * (0.08 + 1.8 * lit), 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

function earth(spec: Extract<ObjectSpec, { type: 'earth' }>): Actor {
  const material = new THREE.MeshStandardMaterial({ map: earthTexture(), roughness: 0.75 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radius, 96, 64), material);
  mesh.position.copy(v3(spec.position));
  const air = new THREE.Mesh(new THREE.SphereGeometry(spec.radius * 1.045, 96, 64), atmosphereMaterial(new THREE.Color(0x5b9bff)));
  air.position.copy(mesh.position);
  const group = new THREE.Group();
  group.add(mesh, air);
  return { object: group, render: (s) => (mesh.rotation.y = s.t * 0.02) };
}

function label(text: string, color: string, height = 0.07): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = '600 52px "Sawarabi Gothic", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    ctx.fillText(text, 256, 56);
    ctx.shadowBlur = 0;
    ctx.fillText(text, 256, 56);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }),
  );
  sprite.scale.set(height * (512 / 112), height, 1);
  sprite.renderOrder = 5;
  return sprite;
}

// 太い矢印。長さは setLength で変える。+x を向いた形で作り、向きは親で決める
function makeArrow(color: THREE.ColorRepresentation) {
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, toneMapped: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 1, 12), material);
  shaft.rotation.z = -Math.PI / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 20), material);
  head.rotation.z = -Math.PI / 2;
  const group = new THREE.Group();
  group.add(shaft, head);
  return {
    group,
    setLength(length: number) {
      const body = Math.max(length - 0.07, 0.001);
      shaft.scale.y = body;
      shaft.position.x = body / 2;
      head.position.x = body + 0.035;
      group.visible = length > 0.02;
    },
  };
}

// 地球と月それぞれへの引力を、艇の中に浮かぶ図で見せる。
// 左に地球、右に月。艇の点が月へ近づくと、引力（距離の自乗に反比例、地球の質量は月の 81 倍）がつり合っていく
function forceArrows(spec: Extract<ObjectSpec, { type: 'forceArrows' }>): Actor {
  const group = new THREE.Group();
  group.position.copy(v3(spec.origin));
  const half = spec.span / 2;
  const earthBody = new THREE.Mesh(new THREE.SphereGeometry(0.06, 32, 24), new THREE.MeshBasicMaterial({ map: earthTexture() }));
  earthBody.position.x = -half;
  earthBody.add(glowSprite(0x6fa8ff, 0.3, 0.5));
  const moonBody = new THREE.Mesh(new THREE.SphereGeometry(0.035, 32, 24), new THREE.MeshBasicMaterial({ map: moonTextures().color }));
  moonBody.position.x = half;
  moonBody.add(glowSprite(0xdde6ff, 0.18, 0.4));
  const track = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-half, 0, 0), new THREE.Vector3(half, 0, 0)]),
    new THREE.LineBasicMaterial({ color: 0x8fb3e8, transparent: true, opacity: 0.35 }),
  );
  const ship = new THREE.Mesh(new THREE.OctahedronGeometry(0.022), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
  ship.add(glowSprite(0xffffff, 0.14, 0.6));
  const toEarth = makeArrow(0x6fa8ff);
  toEarth.group.rotation.z = Math.PI;
  const toMoon = makeArrow(0xf0f3fa);
  ship.add(toEarth.group, toMoon.group);
  const earthLabel = label('地球の引力', '#9cc3ff');
  const moonLabel = label('月の引力', '#f0f3fa');
  const earthName = label('地球', '#9cc3ff', 0.05);
  earthName.position.set(-half, -0.12, 0);
  const moonName = label('月', '#dfe5f0', 0.05);
  moonName.position.set(half, -0.12, 0);
  const balanceLabel = label('重力平衡圏', '#ffe6a8', 0.08);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.05, 0.058, 48),
    new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, side: THREE.DoubleSide, toneMapped: false }),
  );
  group.add(track, earthBody, moonBody, ship, earthLabel, moonLabel, earthName, moonName, balanceLabel, ring);

  const materials: THREE.Material[] = [];
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m)
      for (const mm of Array.isArray(m) ? m : [m]) {
        mm.transparent = true;
        mm.userData.baseOpacity = mm.opacity;
        materials.push(mm);
      }
  });

  return {
    object: group,
    render: (s) => {
      group.visible = s.level > 0.001;
      if (!group.visible) return;
      const balance = spec.balance + (1 - spec.balance) * smooth(progress(s));
      // 地球から月までを 1 として、艇は 0.6 から 0.9（つり合う所）へ
      const f = 0.6 + 0.3 * balance;
      const fe = 81 / (f * f);
      const fm = 1 / ((1 - f) * (1 - f));
      const strongest = Math.max(fe, fm);
      const x = -half + spec.span * f;
      ship.position.x = x;
      const lenE = spec.maxLength * (fe / strongest);
      const lenM = spec.maxLength * (fm / strongest);
      toEarth.setLength(lenE);
      toMoon.setLength(lenM);
      earthLabel.position.set(x - Math.max(lenE, 0.2) * 0.55, 0.075, 0);
      moonLabel.position.set(x + Math.max(lenM, 0.2) * 0.55, -0.075, 0);
      const equal = clamp01((balance - 0.94) / 0.06);
      ring.position.x = x;
      ring.scale.setScalar(1 + 0.25 * Math.sin(s.t * 3));
      balanceLabel.position.set(x, 0.17, 0);
      for (const m of materials) m.opacity = (m.userData.baseOpacity as number) * s.level;
      ring.material.opacity = equal * s.level;
      balanceLabel.material.opacity = equal * s.level;
    },
  };
}

// 卓子の上の本・灰皿・額。start で浮き上がり、ある高さで止まる（本文「じっと停ってしまう」）
function cabinItems(spec: Extract<ObjectSpec, { type: 'cabinItems' }>): Actor {
  const group = new THREE.Group();
  const tablePos = v3(spec.table);
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.025, 0.36),
    new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.4, metalness: 0.6 }),
  );
  table.position.copy(tablePos);
  // 卓子のふちの明かり。暗い室内で形が分かるように
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.004, 0.004), new THREE.MeshBasicMaterial({ color: 0x7fb4ff, toneMapped: false }));
  edge.position.copy(tablePos).add(new THREE.Vector3(0, 0.014, 0.18));
  group.add(table, edge);
  // 室内の明かり（外の暗さと分けるため、手元だけを照らす）
  const lamp = new THREE.PointLight(0xffe2c0, 1.4, 2.5, 1.5);
  lamp.position.copy(tablePos).add(new THREE.Vector3(0, 0.9, 0.2));
  group.add(lamp);

  const items = spec.items.map((item, i) => {
    let mesh: THREE.Mesh;
    if (item.kind === 'book') {
      const cover = new THREE.MeshStandardMaterial({ color: 0x8a2f28, roughness: 0.6 });
      const pages = new THREE.MeshStandardMaterial({ color: 0xe8dfc8, roughness: 0.9 });
      // 表紙は赤、小口は紙の色
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.03, 0.21), [pages, cover, cover, cover, pages, pages]);
    } else if (item.kind === 'ashtray') {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.042, 0.02, 24),
        new THREE.MeshStandardMaterial({ color: 0xb9bcc2, metalness: 0.85, roughness: 0.3 }),
      );
    } else {
      // 額は本文で「九十度横に曲ったまま」
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.012), new THREE.MeshStandardMaterial({ color: 0x8a6a3a }));
      mesh.rotation.z = Math.PI / 2;
    }
    const base = v3(item.position);
    mesh.position.copy(base);
    group.add(mesh);
    // 本は目の高さ近くまで上がる。ほかは少しだけ
    const rise = item.kind === 'book' ? 0.3 : item.kind === 'ashtray' ? 0.15 : 0;
    return { mesh, base, baseZ: mesh.rotation.z, rise, spin: (i + 1) * 0.35, toward: item.kind === 'book' ? 0.1 : 0.03 };
  });

  const materials: THREE.Material[] = [];
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) for (const mm of Array.isArray(m) ? m : [m]) materials.push(mm);
  });
  return {
    object: group,
    render: (s) => {
      // level は室内の見え方。外の景色へ目を移す場面では消す
      group.visible = s.level > 0.001;
      lamp.intensity = 1.4 * s.level;
      for (const m of materials) {
        m.transparent = s.level < 1;
        m.opacity = s.level;
      }
      // 減速しながら上がり、止まる
      const k = 1 - Math.pow(1 - progress(s), 3);
      for (const it of items) {
        it.mesh.position.y = it.base.y + it.rise * k;
        it.mesh.position.z = it.base.z + it.toward * k;
        it.mesh.rotation.x = it.spin * k * 0.7;
        it.mesh.rotation.z = it.baseZ + it.spin * k * 0.25;
      }
    },
  };
}

// でこぼこの岩。球の表面を、向きごとに決まる大小の凹凸で押し引きする（同じ向きの頂点は同じだけ動くので、ひびが入らない）
function rockGeometry(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, 2));
  const pos = geometry.getAttribute('position');
  const bumps = Array.from({ length: 9 }, () => ({
    dir: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
    size: 0.3 + rand() * 0.5,
    depth: (rand() - 0.6) * 0.5,
  }));
  const squash = new THREE.Vector3(1, 0.55 + rand() * 0.35, 0.75 + rand() * 0.25);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let r = 1;
    for (const b of bumps) r += b.depth * Math.max(0, 1 - v.distanceTo(b.dir) / b.size);
    r += (Math.sin(v.x * 9 + seed) * Math.sin(v.y * 11) * Math.sin(v.z * 7)) * 0.05;
    v.multiplyScalar(r).multiply(squash);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// 宇宙の墓地: 平衡点に溜まった隕石。探照灯が当たるまでは闇に沈んでいる
function debrisField(spec: Extract<ObjectSpec, { type: 'debrisField' }>): Actor {
  const rand = mulberry32(spec.seed);
  const material = new THREE.MeshStandardMaterial({ color: 0x5d6068, roughness: 0.95, flatShading: true });
  const center = v3(spec.center);
  // 形の違う岩を三種類。同じ形の岩はまとめて描く（InstancedMesh）
  const shapes = [0, 1, 2].map((k) => rockGeometry(spec.seed + k * 17));
  const group = new THREE.Group();
  // 中心ほど密に（ガウス分布に近い）。spread はおおよその半径
  const g = () => (rand() + rand() + rand() - 1.5) / 1.5;
  const rocks = Array.from({ length: spec.count }, (_, i) => ({
    shape: i % shapes.length,
    p: new THREE.Vector3(g() * spec.spread[0], g() * spec.spread[1], g() * spec.spread[2]).add(center),
    s: spec.size[0] + Math.pow(rand(), 3) * (spec.size[1] - spec.size[0]),
    rot: new THREE.Euler(rand() * 6, rand() * 6, rand() * 6),
    spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.12),
    phase: rand() * Math.PI * 2,
  }));
  const meshes = shapes.map((geometry, k) => {
    const mesh = new THREE.InstancedMesh(geometry, material, rocks.filter((r) => r.shape === k).length);
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const half = spec.spread[0];
  const span = half * 2;
  const write = (time: number) => {
    const counters = [0, 0, 0];
    for (const r of rocks) {
      // 「並んでしずかに動いている」: 横へゆっくり流れ、端まで行ったら反対側へ戻る
      const x = ((((r.p.x - center.x + time * spec.drift + half) % span) + span) % span) - half;
      e.set(r.rot.x + r.spin.x * time, r.rot.y + r.spin.y * time, r.rot.z + r.spin.z * time);
      q.setFromEuler(e);
      scale.setScalar(r.s);
      p.set(center.x + x, r.p.y + Math.sin(time * 0.1 + r.phase) * 0.4, r.p.z);
      m.compose(p, q, scale);
      const index = counters[r.shape] ?? 0;
      meshes[r.shape]?.setMatrixAt(index, m);
      counters[r.shape] = index + 1;
    }
    for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
  };
  const base = material.color.clone();
  return {
    object: group,
    render: (s) => {
      material.color.copy(base).multiplyScalar(0.12 + 0.88 * s.level);
      write(s.t);
    },
  };
}

// 艇の探照灯。光源は艇と一緒に動き、光は墓地の上をゆっくり掃く
function searchlight(spec: Extract<ObjectSpec, { type: 'searchlight' }>): Actor {
  const group = new THREE.Group();
  const color = new THREE.Color(spec.color);
  const mount = v3(spec.mount);
  const center = v3(spec.center);
  const light = new THREE.SpotLight(color, 0, 0, spec.angle, 1, 0);
  group.add(light, light.target);

  // 光の筋。先端が原点、底面が -y の 1 の位置にある円錐を、毎フレーム向きと長さに合わせて伸ばす。
  // 光源に近いほど明るく先へ行くほど消え、筋のふち（視線と平行に近い面）ほど薄くして、霧の中の光の柱に見せる
  const cone = new THREE.ConeGeometry(1, 1, 48, 1, true);
  cone.translate(0, -0.5, 0);
  const beamOpacity = { value: 0 };
  const beamMaterial = new THREE.ShaderMaterial({
    uniforms: { tint: { value: color }, opacity: beamOpacity },
    vertexShader: /* glsl */ `
      varying float vAlong;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vAlong = -position.y;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 tint;
      uniform float opacity;
      varying float vAlong;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 view = normalize(cameraPosition - vWorld);
        // 筋の中心（視線に向いた面）ほど濃く、ふちほど薄い
        float facing = abs(dot(normalize(vNormal), view));
        float fade = pow(1.0 - clamp(vAlong, 0.0, 1.0), 2.5);
        gl_FragColor = vec4(tint * facing * fade * opacity, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const beam = new THREE.Mesh(cone, beamMaterial);
  beam.frustumCulled = false;
  const lamp = glowSprite(color, 0.6, 0);
  group.add(beam, lamp);

  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
  return {
    object: group,
    render: (s, ctx) => {
      group.visible = s.level > 0.001;
      if (!group.visible) return;
      from.copy(v3(ctx.poseAt(s.t).position)).add(mount);
      const w = s.t * spec.sweepSpeed;
      to.set(Math.sin(w) * spec.sweep[0], Math.sin(w * 0.63 + 1) * spec.sweep[1], Math.cos(w * 0.81) * spec.sweep[2]).add(center);
      light.position.copy(from);
      light.target.position.copy(to);
      light.intensity = spec.intensity * s.level;
      const length = from.distanceTo(to) * 0.95;
      const radius = Math.tan(spec.angle) * length;
      beam.position.copy(from);
      beam.quaternion.setFromUnitVectors(down, dir.copy(to).sub(from).normalize());
      beam.scale.set(radius, length, radius);
      beamOpacity.value = 0.4 * s.level;
      lamp.position.copy(from);
      lamp.material.opacity = s.level;
    },
  };
}

// 艇から放り出す物。初速を持って出ていき、平衡点で減速してその場に止まる
function throwables(spec: Extract<ObjectSpec, { type: 'throwables' }>): Actor {
  const rand = mulberry32(spec.seed);
  const group = new THREE.Group();
  const mount = v3(spec.mount);
  const toward = v3(spec.toward);
  const geometries = [
    new THREE.BoxGeometry(0.35, 0.35, 0.35),
    new THREE.CylinderGeometry(0.15, 0.15, 0.45, 16),
    new THREE.BoxGeometry(0.6, 0.14, 0.3),
  ];
  // 探照灯の青白い光の中で見分けられるよう、少し自分で光らせる
  const material = new THREE.MeshStandardMaterial({ color: 0xd8dde4, roughness: 0.4, metalness: 0.5, emissive: 0x1c2733 });
  const items = Array.from({ length: spec.count }, (_, i) => {
    const geometry = geometries[i % geometries.length] ?? geometries[0];
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    group.add(mesh);
    const offset = new THREE.Vector3((rand() - 0.5) * 30, (rand() - 0.5) * 10, (rand() - 0.5) * 20);
    const speed = spec.speed[0] + rand() * (spec.speed[1] - spec.speed[0]);
    return { mesh, offset, speed, spin: new THREE.Vector3(rand(), rand(), rand()) };
  });
  const k = 0.12; // 減速の強さ。到達距離は speed / k
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3();
  return {
    object: group,
    render: (s, ctx) => {
      for (const [i, it] of items.entries()) {
        // start の長さのあいだに 1 つずつ放り出す。投げた時刻の艇の位置から出る
        const age = s.since === null ? -1 : s.since - (i / items.length) * s.dur;
        it.mesh.visible = age >= 0;
        if (age < 0) continue;
        from.copy(v3(ctx.poseAt(s.t - age).position)).add(mount);
        dir.copy(toward).add(it.offset).sub(from).normalize();
        const travelled = (it.speed * (1 - Math.exp(-k * age))) / k;
        it.mesh.position.copy(from).addScaledVector(dir, travelled);
        // 回転も移動と一緒に止まる
        it.mesh.rotation.set(it.spin.x * travelled * 0.2, it.spin.y * travelled * 0.2, it.spin.z * travelled * 0.2);
      }
    },
  };
}

export function buildActor(spec: ObjectSpec): Actor {
  switch (spec.type) {
    case 'stars':
      return stars(spec);
    case 'sunlight':
      return sunlight(spec);
    case 'moon':
      return moon(spec);
    case 'earth':
      return earth(spec);
    case 'forceArrows':
      return forceArrows(spec);
    case 'cabinItems':
      return cabinItems(spec);
    case 'debrisField':
      return debrisField(spec);
    case 'searchlight':
      return searchlight(spec);
    case 'throwables':
      return throwables(spec);
  }
}
