// 場面の台本（script.json）の型と検証。
// 台本は LLM が原文から書く想定なので、再生前に形を確かめて、壊れていれば何が悪いかを返す。

export type Vec3 = [number, number, number];

export type ObjectSpec =
  | { id: string; type: 'stars'; count: number; radius: number; seed: number }
  | { id: string; type: 'sunlight'; direction: Vec3; intensity: number }
  | { id: string; type: 'moon'; position: Vec3; radius: number; level?: number }
  | { id: string; type: 'earth'; position: Vec3; radius: number; level?: number }
  | {
      id: string;
      type: 'forceArrows';
      origin: Vec3;
      earth: Vec3;
      moon: Vec3;
      maxLength: number;
      // 0 = 地球の引力だけ、1 = 二つがつり合う。start で 1 へ向かう
      balance: number;
      level?: number;
    }
  | {
      id: string;
      type: 'cabinItems';
      table: Vec3;
      items: { kind: 'book' | 'ashtray' | 'frame'; position: Vec3 }[];
    }
  | {
      id: string;
      type: 'debrisField';
      center: Vec3;
      spread: Vec3;
      count: number;
      size: [number, number];
      drift: number;
      seed: number;
    }
  | {
      id: string;
      type: 'searchlight';
      from: Vec3;
      to: Vec3;
      color: string;
      angle: number;
      intensity: number;
      level?: number;
    }
  | {
      id: string;
      type: 'throwables';
      from: Vec3;
      toward: Vec3;
      count: number;
      speed: [number, number];
      seed: number;
    };

export type TimelineEvent =
  | { t: number; do: 'caption'; text: string; chapter?: string }
  | { t: number; do: 'level'; target: string; to: number; dur: number }
  | { t: number; do: 'start'; target: string; dur: number }
  | { t: number; do: 'end' };

export type Script = {
  title: string;
  source: { work: string; author: string; chapters: string[]; url: string };
  note?: string;
  objects: ObjectSpec[];
  timeline: TimelineEvent[];
};

const OBJECT_TYPES = new Set([
  'stars',
  'sunlight',
  'moon',
  'earth',
  'forceArrows',
  'cabinItems',
  'debrisField',
  'searchlight',
  'throwables',
]);

// 型ごとに必須のキー。値の中身まで厳密に見るより、LLM が書き漏らしやすいキー抜けを確実に拾うことを優先している
const REQUIRED_KEYS: Record<string, string[]> = {
  stars: ['count', 'radius', 'seed'],
  sunlight: ['direction', 'intensity'],
  moon: ['position', 'radius'],
  earth: ['position', 'radius'],
  forceArrows: ['origin', 'earth', 'moon', 'maxLength', 'balance'],
  cabinItems: ['table', 'items'],
  debrisField: ['center', 'spread', 'count', 'size', 'drift', 'seed'],
  searchlight: ['from', 'to', 'color', 'angle', 'intensity'],
  throwables: ['from', 'toward', 'count', 'speed', 'seed'],
};

const VEC3_KEYS = new Set(['position', 'direction', 'origin', 'earth', 'moon', 'table', 'center', 'spread', 'from', 'to', 'toward']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVec3(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function parseScript(raw: unknown): Script {
  const errors: string[] = [];
  if (!isRecord(raw)) throw new Error('台本がオブジェクトではありません');
  if (typeof raw.title !== 'string') errors.push('title がありません');
  if (!isRecord(raw.source)) errors.push('source がありません');
  if (!Array.isArray(raw.objects)) errors.push('objects が配列ではありません');
  if (!Array.isArray(raw.timeline)) errors.push('timeline が配列ではありません');
  if (errors.length > 0) throw new Error(errors.join('\n'));

  const ids = new Set<string>();
  for (const [i, obj] of (raw.objects as unknown[]).entries()) {
    if (!isRecord(obj) || typeof obj.id !== 'string' || typeof obj.type !== 'string') {
      errors.push(`objects[${i}]: id と type が必要です`);
      continue;
    }
    if (!OBJECT_TYPES.has(obj.type)) errors.push(`objects[${i}] (${obj.id}): 知らない type「${obj.type}」`);
    if (ids.has(obj.id)) errors.push(`objects[${i}]: id「${obj.id}」が重複しています`);
    ids.add(obj.id);
    for (const key of REQUIRED_KEYS[obj.type] ?? []) {
      if (!(key in obj)) errors.push(`objects[${i}] (${obj.id}): ${key} がありません`);
      else if (VEC3_KEYS.has(key) && !isVec3(obj[key])) errors.push(`objects[${i}] (${obj.id}): ${key} は [x, y, z] の数値`);
    }
  }

  for (const [i, ev] of (raw.timeline as unknown[]).entries()) {
    if (!isRecord(ev) || typeof ev.t !== 'number' || typeof ev.do !== 'string') {
      errors.push(`timeline[${i}]: t（秒）と do が必要です`);
      continue;
    }
    if (ev.do === 'caption' && typeof ev.text !== 'string') errors.push(`timeline[${i}]: caption には text が必要です`);
    if (ev.do === 'level' || ev.do === 'start') {
      if (typeof ev.target !== 'string' || !ids.has(ev.target)) errors.push(`timeline[${i}]: target「${String(ev.target)}」が objects にありません`);
      if (typeof ev.dur !== 'number') errors.push(`timeline[${i}]: dur（秒）が必要です`);
    }
    if (ev.do === 'level' && typeof ev.to !== 'number') errors.push(`timeline[${i}]: level には to（0〜1）が必要です`);
    if (!['caption', 'level', 'start', 'end'].includes(ev.do)) errors.push(`timeline[${i}]: 知らない do「${ev.do}」`);
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  const script = raw as unknown as Script;
  script.timeline = [...script.timeline].sort((a, b) => a.t - b.t);
  return script;
}
