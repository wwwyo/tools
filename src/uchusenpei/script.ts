// 場面の台本（script.json）の型と検証。台本は「置く物（objects）」と「文ごとの区切り（beats）」でできている。
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
      // 0 は闇に沈む、1 で探照灯に照らされた明るさ
      level?: number;
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

// その文のあいだに起きること。at は文の頭からの秒
export type Action =
  | { at: number; do: 'level'; target: string; to: number; dur: number }
  | { at: number; do: 'start'; target: string; dur: number };

// 台本の 1 区切り = 本文の 1 文（または場面をつなぐ補いの 1 文）
export type Beat = {
  id: string;
  // 原文のどの章の文か
  chapter: string;
  text: string;
  // true なら本文そのまま、false なら場面をつなぐための補い
  quote: boolean;
  // 読み上げの目安の秒数。前の文が終わると次の文が始まる
  seconds: number;
  actions?: Action[];
};

export type Script = {
  title: string;
  source: { work: string; author: string; chapters: string[]; url: string };
  note?: string;
  objects: ObjectSpec[];
  beats: Beat[];
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
  if (!Array.isArray(raw.beats)) errors.push('beats が配列ではありません');
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

  const beatIds = new Set<string>();
  for (const [i, beat] of (raw.beats as unknown[]).entries()) {
    if (!isRecord(beat)) {
      errors.push(`beats[${i}]: オブジェクトではありません`);
      continue;
    }
    const where = `beats[${i}]${typeof beat.id === 'string' ? ` (${beat.id})` : ''}`;
    if (typeof beat.id !== 'string') errors.push(`${where}: id がありません`);
    else if (beatIds.has(beat.id)) errors.push(`${where}: id が重複しています`);
    else beatIds.add(beat.id);
    if (typeof beat.chapter !== 'string') errors.push(`${where}: chapter（原文の章）がありません`);
    if (typeof beat.text !== 'string') errors.push(`${where}: text がありません`);
    if (typeof beat.quote !== 'boolean') errors.push(`${where}: quote（本文そのままか）は true / false`);
    if (typeof beat.seconds !== 'number' || beat.seconds <= 0) errors.push(`${where}: seconds は正の数`);
    if (beat.actions !== undefined && !Array.isArray(beat.actions)) errors.push(`${where}: actions は配列`);
    for (const [j, act] of ((beat.actions as unknown[] | undefined) ?? []).entries()) {
      const at = `${where}.actions[${j}]`;
      if (!isRecord(act) || typeof act.at !== 'number' || typeof act.do !== 'string') {
        errors.push(`${at}: at（秒）と do が必要です`);
        continue;
      }
      if (act.do !== 'level' && act.do !== 'start') errors.push(`${at}: 知らない do「${act.do}」`);
      if (typeof act.target !== 'string' || !ids.has(act.target)) errors.push(`${at}: target「${String(act.target)}」が objects にありません`);
      if (typeof act.dur !== 'number') errors.push(`${at}: dur（秒）が必要です`);
      if (act.do === 'level' && typeof act.to !== 'number') errors.push(`${at}: level には to（0〜1）が必要です`);
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  return raw as unknown as Script;
}
