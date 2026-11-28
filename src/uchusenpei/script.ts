// 場面の台本（script.json）の型と検証。台本は「置く物（objects）」と「文ごとの区切り（beats）」でできている。
// 台本は LLM が原文から書く想定なので、再生前に形を確かめて、壊れていれば何が悪いかを返す。

export type Vec3 = [number, number, number];

// 視点。position は艇（見る人が乗っている）の位置、yaw / pitch は顔の向き（度。yaw は左が正、pitch は上が正）。
// VR では向きは見る人の頭に任せ、position だけを使う
export type Pose = { position: Vec3; yaw: number; pitch: number };

type ObjectKind =
  | { id: string; type: 'stars'; count: number; radius: number; seed: number }
  | { id: string; type: 'sunlight'; direction: Vec3; intensity: number; level?: number }
  | { id: string; type: 'moon'; position: Vec3; radius: number; level?: number }
  | { id: string; type: 'earth'; position: Vec3; radius: number }
  | {
      id: string;
      type: 'forceArrows';
      // 艇の中に浮かべる図。origin は図の中心、span は図の地球から月までの長さ
      origin: Vec3;
      span: number;
      maxLength: number;
      // 艇の位置。0 = 地球と月のあいだの 6 割、1 = 二つの引力がつり合う 9 割。start で 1 へ向かう
      balance: number;
      level?: number;
    }
  | {
      id: string;
      type: 'cabinItems';
      table: Vec3;
      items: { kind: 'book' | 'ashtray' | 'frame'; position: Vec3 }[];
      level?: number;
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
      // 光源は艇に付いている（mount は艇から見た位置）。光は center のまわりを sweep の幅で、sweepSpeed の速さで掃く
      mount: Vec3;
      center: Vec3;
      sweep: Vec3;
      sweepSpeed: number;
      color: string;
      angle: number;
      intensity: number;
      level?: number;
    }
  | {
      id: string;
      type: 'throwables';
      // 投げた時刻の艇の位置から mount だけずれた所から放り出す
      mount: Vec3;
      toward: Vec3;
      count: number;
      speed: [number, number];
      seed: number;
    };

// 艇の中の物（onShip: true）は艇と一緒に動く。ほかは宇宙に置かれたまま
export type ObjectSpec = ObjectKind & { onShip?: boolean };

// その文のあいだに起きること。at は文の頭からの秒
export type Action =
  | { at: number; do: 'level'; target: string; to: number; dur: number }
  | { at: number; do: 'start'; target: string; dur: number }
  // 視点を dur 秒かけて動かす。書いた項目だけが変わる
  | { at: number; do: 'camera'; to: Partial<Pose>; dur: number };

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
  // 始まりの視点
  camera: Pose;
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
  forceArrows: ['origin', 'span', 'maxLength', 'balance'],
  cabinItems: ['table', 'items'],
  debrisField: ['center', 'spread', 'count', 'size', 'drift', 'seed'],
  searchlight: ['mount', 'center', 'sweep', 'sweepSpeed', 'color', 'angle', 'intensity'],
  throwables: ['mount', 'toward', 'count', 'speed', 'seed'],
};

const VEC3_KEYS = new Set(['position', 'direction', 'origin', 'table', 'center', 'spread', 'mount', 'sweep', 'toward']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumbers(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function isVec3(value: unknown): boolean {
  return isNumbers(value, 3);
}

// 視点の検証。partial なら書いた項目だけを見る
function poseErrors(value: unknown, where: string, partial: boolean): string[] {
  if (!isRecord(value)) return [`${where}: 視点は { position, yaw, pitch } で書きます`];
  const errors: string[] = [];
  if ((!partial || 'position' in value) && !isVec3(value.position)) errors.push(`${where}: position は [x, y, z] の数値`);
  for (const key of ['yaw', 'pitch'] as const)
    if ((!partial || key in value) && !(typeof value[key] === 'number' && Number.isFinite(value[key]))) errors.push(`${where}: ${key}（度）は数値`);
  return errors;
}

const PAIR_KEYS = new Set(['size', 'speed']);
const ITEM_KINDS = new Set(['book', 'ashtray', 'frame']);

export function parseScript(raw: unknown): Script {
  const errors: string[] = [];
  if (!isRecord(raw)) throw new Error('台本がオブジェクトではありません');
  if (typeof raw.title !== 'string') errors.push('title がありません');
  if (!isRecord(raw.source)) errors.push('source がありません');
  if (!Array.isArray(raw.objects)) errors.push('objects が配列ではありません');
  if (!Array.isArray(raw.beats)) errors.push('beats が配列ではありません');
  errors.push(...poseErrors(raw.camera, 'camera', false));
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
      else if (PAIR_KEYS.has(key) && !isNumbers(obj[key], 2)) errors.push(`objects[${i}] (${obj.id}): ${key} は [最小, 最大] の数値`);
    }
    if (obj.type === 'cabinItems' && 'items' in obj) {
      if (!Array.isArray(obj.items)) errors.push(`objects[${i}] (${obj.id}): items は配列`);
      else
        for (const [j, item] of (obj.items as unknown[]).entries()) {
          if (!isRecord(item) || typeof item.kind !== 'string' || !ITEM_KINDS.has(item.kind))
            errors.push(`objects[${i}] (${obj.id}).items[${j}]: kind は book / ashtray / frame`);
          else if (!isVec3(item.position)) errors.push(`objects[${i}] (${obj.id}).items[${j}]: position は [x, y, z] の数値`);
        }
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
      if (typeof act.dur !== 'number') errors.push(`${at}: dur（秒）が必要です`);
      if (act.do === 'camera') {
        errors.push(...poseErrors(act.to, `${at}.to`, true));
        continue;
      }
      if (act.do !== 'level' && act.do !== 'start') errors.push(`${at}: 知らない do「${act.do}」`);
      if (typeof act.target !== 'string' || !ids.has(act.target)) errors.push(`${at}: target「${String(act.target)}」が objects にありません`);
      if (act.do === 'level' && typeof act.to !== 'number') errors.push(`${at}: level には to（0〜1）が必要です`);
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  return raw as unknown as Script;
}
