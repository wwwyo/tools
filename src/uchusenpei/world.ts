// 台本の objects を three.js の物に組み立てる。
// 物ごとに「level（0〜1 の見え方・明るさ）」と「start（その物の動きを始める）」の 2 つだけを外に出し、
// 台本の timeline はこの 2 つと字幕だけで場面を進める。

import * as THREE from 'three';
import type { ObjectSpec, Vec3 } from './script';
import { makeEarthTexture, makeMoonTextures, mulberry32 } from './textures';

export type Actor = {
  object: THREE.Object3D;
  applyLevel?: (level: number) => void;
  start?: (dur: number) => void;
  update?: (dt: number) => void;
};

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);
const smooth = (t: number) => t * t * (3 - 2 * t);

// 手続き生成は Quest だと数秒かかるので、最初からやり直しても作り直さない
let moonCache: { color: THREE.Texture; bump: THREE.Texture } | undefined;
let earthCache: THREE.Texture | undefined;

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

function stars(spec: Extract<ObjectSpec, { type: 'stars' }>): Actor {
  const rand = mulberry32(spec.seed);
  const positions = new Float32Array(spec.count * 3);
  const colors = new Float32Array(spec.count * 3);
  for (let i = 0; i < spec.count; i++) {
    const u = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    positions.set([s * Math.cos(a) * spec.radius, u * spec.radius, s * Math.sin(a) * spec.radius], i * 3);
    // 「寒そうな光」: 大半は青白く、たまに暖色
    const b = 0.35 + Math.pow(rand(), 4) * 0.65;
    const warm = rand() < 0.12;
    colors.set(warm ? [b, b * 0.85, b * 0.7] : [b * 0.85, b * 0.92, b], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true });
  return { object: new THREE.Points(geometry, material) };
}

function sunlight(spec: Extract<ObjectSpec, { type: 'sunlight' }>): Actor {
  const light = new THREE.DirectionalLight(0xfff6ea, spec.intensity);
  light.position.copy(v3(spec.direction).normalize().multiplyScalar(500));
  const group = new THREE.Group();
  group.add(light, light.target, new THREE.AmbientLight(0x2a3242, 0.06));
  return { object: group };
}

function moon(spec: Extract<ObjectSpec, { type: 'moon' }>): Actor {
  const tex = moonTextures();
  const material = new THREE.MeshStandardMaterial({
    map: tex.color,
    bumpMap: tex.bump,
    bumpScale: 3,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radius, 96, 64), material);
  mesh.position.copy(v3(spec.position));
  mesh.rotation.y = -0.6;
  // level は月の明るさ（展望室で見えてくる）
  const applyLevel = (level: number) => {
    material.color.setScalar(0.25 + 0.75 * level);
  };
  applyLevel(spec.level ?? 1);
  return { object: mesh, applyLevel, update: (dt) => (mesh.rotation.y += dt * 0.004) };
}

function earth(spec: Extract<ObjectSpec, { type: 'earth' }>): Actor {
  const material = new THREE.MeshStandardMaterial({ map: earthTexture(), roughness: 0.8 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radius, 48, 32), material);
  mesh.position.copy(v3(spec.position));
  // 大気のふち
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(spec.radius * 1.06, 48, 32),
    new THREE.MeshBasicMaterial({ color: 0x6fa8ff, transparent: true, opacity: 0.18, side: THREE.BackSide }),
  );
  mesh.add(glow);
  return { object: mesh, update: (dt) => (mesh.rotation.y += dt * 0.02) };
}

function label(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = '34px sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, 128, 44);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(0.5, 0.125, 1);
  return sprite;
}

// 地球と月それぞれへの引力を矢印で見せる。長さは引力の大きさ。start で二つが同じ長さへ近づく
function forceArrows(spec: Extract<ObjectSpec, { type: 'forceArrows' }>): Actor {
  const group = new THREE.Group();
  const origin = v3(spec.origin);
  const toEarth = v3(spec.earth).sub(origin).normalize();
  const toMoon = v3(spec.moon).sub(origin).normalize();
  const earthArrow = new THREE.ArrowHelper(toEarth, origin, 1, 0x6fa8ff, 0.18, 0.1);
  const moonArrow = new THREE.ArrowHelper(toMoon, origin, 1, 0xd9dde6, 0.18, 0.1);
  const earthLabel = label('地球の引力', '#9cc3ff');
  const moonLabel = label('月の引力', '#e6e9f0');
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  dot.position.copy(origin);
  group.add(earthArrow, moonArrow, earthLabel, moonLabel, dot);
  const materials: THREE.Material[] = [];
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) for (const mm of Array.isArray(m) ? m : [m]) materials.push(mm);
  });
  for (const m of materials) m.transparent = true;

  let balance = spec.balance;
  let from = balance;
  let elapsed = 0;
  let dur = 0;
  const layout = () => {
    // balance=0 で地球側が最大・月側が最小、balance=1 で同じ長さ
    const earthLen = spec.maxLength * (1 - 0.45 * balance);
    const moonLen = spec.maxLength * (0.2 + 0.35 * balance);
    earthArrow.setLength(earthLen, 0.18, 0.1);
    moonArrow.setLength(moonLen, 0.18, 0.1);
    earthLabel.position.copy(origin).addScaledVector(toEarth, earthLen + 0.25);
    moonLabel.position.copy(origin).addScaledVector(toMoon, moonLen + 0.25);
  };
  layout();
  const applyLevel = (level: number) => {
    for (const m of materials) m.opacity = level;
    group.visible = level > 0.001;
  };
  applyLevel(spec.level ?? 1);
  return {
    object: group,
    applyLevel,
    start: (d) => {
      from = balance;
      elapsed = 0;
      dur = Math.max(d, 0.01);
    },
    update: (dt) => {
      if (dur === 0) return;
      elapsed = Math.min(elapsed + dt, dur);
      balance = from + (1 - from) * smooth(elapsed / dur);
      layout();
      if (elapsed >= dur) dur = 0;
    },
  };
}

// 卓子の上の本・灰皿・額。start で浮き上がり、ある高さで止まる（本文「じっと停ってしまう」）
function cabinItems(spec: Extract<ObjectSpec, { type: 'cabinItems' }>): Actor {
  const group = new THREE.Group();
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.04, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x3b2f27, roughness: 0.7 }),
  );
  table.position.copy(v3(spec.table));
  group.add(table);
  // 室内の明かり（外の暗さと分けるため、手元だけを照らす）
  const lamp = new THREE.PointLight(0xffe2c0, 1.2, 3, 1.5);
  lamp.position.set(0, 0.6, -0.6);
  group.add(lamp);

  const items = spec.items.map((item, i) => {
    let mesh: THREE.Mesh;
    if (item.kind === 'book') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.28), new THREE.MeshStandardMaterial({ color: 0x7a2e2a }));
    } else if (item.kind === 'ashtray') {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.06, 0.025, 24),
        new THREE.MeshStandardMaterial({ color: 0xb9bcc2, metalness: 0.8, roughness: 0.35 }),
      );
    } else {
      // 額は本文で「九十度横に曲ったまま」
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.26, 0.02), new THREE.MeshStandardMaterial({ color: 0x8a6a3a }));
      mesh.rotation.z = Math.PI / 2;
    }
    const base = v3(item.position);
    mesh.position.copy(base);
    group.add(mesh);
    return { mesh, base, rise: item.kind === 'frame' ? 0 : 0.18 + i * 0.07, spin: (i + 1) * 0.25 };
  });

  let elapsed = 0;
  let dur = 0;
  return {
    object: group,
    start: (d) => {
      elapsed = 0;
      dur = Math.max(d, 0.01);
    },
    update: (dt) => {
      if (dur === 0) return;
      elapsed = Math.min(elapsed + dt, dur);
      // 減速しながら上がり、止まる
      const k = 1 - Math.pow(1 - elapsed / dur, 3);
      for (const it of items) {
        it.mesh.position.y = it.base.y + it.rise * k;
        it.mesh.rotation.x = it.spin * k * 0.6;
      }
    },
  };
}

function rockGeometry(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const pos = geometry.getAttribute('position');
  // 同じ頂点（面ごとに複製されている）には同じ変位を与えて、ひびが入らないようにする
  const offsets = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let o = offsets.get(key);
    if (o === undefined) {
      o = 0.7 + rand() * 0.6;
      offsets.set(key, o);
    }
    pos.setXYZ(i, pos.getX(i) * o, pos.getY(i) * o * 0.75, pos.getZ(i) * o);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// 宇宙の墓地: 平衡点に溜まった隕石。探照灯が当たるまでは闇に沈んでいる
function debrisField(spec: Extract<ObjectSpec, { type: 'debrisField' }>): Actor {
  const rand = mulberry32(spec.seed);
  const material = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.95, flatShading: true });
  const mesh = new THREE.InstancedMesh(rockGeometry(spec.seed), material, spec.count);
  const center = v3(spec.center);
  const rocks = Array.from({ length: spec.count }, () => {
    const p = new THREE.Vector3(
      (rand() - 0.5) * spec.spread[0],
      (rand() - 0.5) * spec.spread[1],
      (rand() - 0.5) * spec.spread[2],
    ).add(center);
    const s = spec.size[0] + Math.pow(rand(), 2.5) * (spec.size[1] - spec.size[0]);
    return {
      p,
      s,
      rot: new THREE.Euler(rand() * 6, rand() * 6, rand() * 6),
      spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.1),
      phase: rand() * Math.PI * 2,
    };
  });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  let time = 0;
  const write = () => {
    for (const [i, r] of rocks.entries()) {
      // 「並んでしずかに動いている」: 横へゆっくり流れ、端まで行ったら反対側へ戻る
      const half = spec.spread[0] / 2;
      const x = ((((r.p.x - center.x + time * spec.drift + half) % spec.spread[0]) + spec.spread[0]) % spec.spread[0]) - half;
      q.setFromEuler(new THREE.Euler(r.rot.x + r.spin.x * time, r.rot.y + r.spin.y * time, r.rot.z + r.spin.z * time));
      scale.setScalar(r.s);
      m.compose(new THREE.Vector3(center.x + x, r.p.y + Math.sin(time * 0.1 + r.phase) * 0.3, r.p.z), q, scale);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  write();
  return {
    object: mesh,
    update: (dt) => {
      time += dt;
      write();
    },
  };
}

function searchlight(spec: Extract<ObjectSpec, { type: 'searchlight' }>): Actor {
  const group = new THREE.Group();
  const from = v3(spec.from);
  const to = v3(spec.to);
  const color = new THREE.Color(spec.color);
  const light = new THREE.SpotLight(color, 0, 0, spec.angle, 0.5, 0);
  light.position.copy(from);
  light.target.position.copy(to);
  group.add(light, light.target);

  // 光の筋。光源から目標まで伸びる、先が開いた半透明の円錐
  const length = from.distanceTo(to);
  const radius = Math.tan(spec.angle) * length;
  const beamMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(new THREE.ConeGeometry(radius, length, 32, 1, true), beamMaterial);
  // ConeGeometry は +y が先端。先端を光源に、底面を目標に向ける
  beam.position.copy(from).lerp(to, 0.5);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from).normalize());
  group.add(beam);

  const applyLevel = (level: number) => {
    light.intensity = spec.intensity * level;
    beamMaterial.opacity = 0.05 * level;
  };
  applyLevel(spec.level ?? 1);
  return { object: group, applyLevel };
}

// 艇から放り出す物。初速を持って出ていき、平衡点で減速してその場に止まる
function throwables(spec: Extract<ObjectSpec, { type: 'throwables' }>): Actor {
  const rand = mulberry32(spec.seed);
  const group = new THREE.Group();
  const from = v3(spec.from);
  const toward = v3(spec.toward);
  const geometries = [
    new THREE.BoxGeometry(0.5, 0.5, 0.5),
    new THREE.CylinderGeometry(0.25, 0.25, 0.7, 16),
    new THREE.BoxGeometry(0.9, 0.2, 0.4),
  ];
  const material = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.3 });
  const items = Array.from({ length: spec.count }, (_, i) => {
    const geometry = geometries[i % geometries.length] ?? geometries[0];
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    group.add(mesh);
    const target = toward
      .clone()
      .add(new THREE.Vector3((rand() - 0.5) * 30, (rand() - 0.5) * 6, (rand() - 0.5) * 20));
    const dir = target.sub(from).normalize();
    const speed = spec.speed[0] + rand() * (spec.speed[1] - spec.speed[0]);
    return { mesh, velocity: dir.multiplyScalar(speed), delay: 0, spin: new THREE.Vector3(rand(), rand(), rand()), age: -1 };
  });
  const k = 0.12; // 減速の強さ。到達距離は speed / k
  let dur = 0;
  let elapsed = 0;
  return {
    object: group,
    start: (d) => {
      dur = Math.max(d, 0.01);
      elapsed = 0;
      items.forEach((it, i) => {
        it.delay = (i / items.length) * dur;
        it.age = -1;
        it.mesh.visible = false;
      });
    },
    update: (dt) => {
      if (dur === 0) return;
      elapsed += dt;
      for (const it of items) {
        if (elapsed < it.delay) continue;
        if (it.age < 0) {
          it.age = 0;
          it.mesh.visible = true;
        }
        it.age += dt;
        const travelled = (1 - Math.exp(-k * it.age)) / k;
        it.mesh.position.copy(from).addScaledVector(it.velocity, travelled);
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
