// 台本を「時刻 → 状態」の表に直す。
// 再生は前の状態を少しずつ積み上げるのではなく、毎フレーム「台本の時刻 t での状態」を台本から計算し直す。
// だから任意の文・任意の時刻へ飛んでも、そこまで再生したときと同じ見え方になる。

import type { Beat, Pose, Script, Vec3 } from './script';

export type BeatSpan = { beat: Beat; start: number; end: number };

// 物ひとつの、ある時刻での状態
export type ActorState = {
  // 台本の時刻（秒）。星の流れや自転など、ずっと続く動きはこれで決める
  t: number;
  // 0〜1 の見え方・明るさ
  level: number;
  // 直近の start からの経過秒と、その start の長さ。まだ start していなければ since は null
  since: number | null;
  dur: number;
};

// from は、その指定が始まった時刻の見え方。後から始まった指定はそこから補間し、前の指定はそこで打ち切る
type LevelKey = { t: number; from: number; to: number; dur: number };
type StartKey = { t: number; dur: number };

// 視点の指定。from はその指定が始まった時刻の視点
// given は台本に書かれた項目だけ。書かれていない項目は直前の視点を引き継ぐ
type CameraKey = { t: number; given: Partial<Pose>; from: Pose; to: Pose; dur: number };

export type Timeline = {
  beats: BeatSpan[];
  total: number;
  beatAt: (t: number) => number;
  stateAt: (id: string, t: number) => ActorState;
  // 台本の時刻 t での艇の位置と顔の向き。cut なら補間せず、その時点で効いている指定の行き先へ飛ぶ（動きを減らす設定のとき）
  poseAt: (t: number, cut?: boolean) => Pose;
};

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);
// ゆっくり動き出し、ゆっくり止まる
const ease = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpPose = (a: Pose, b: Pose, k: number): Pose => ({
  position: a.position.map((v, i) => lerp(v, b.position[i] ?? v, k)) as Vec3,
  yaw: lerp(a.yaw, b.yaw, k),
  pitch: lerp(a.pitch, b.pitch, k),
});

export function compile(script: Script): Timeline {
  const beats: BeatSpan[] = [];
  let cursor = 0;
  for (const beat of script.beats) {
    beats.push({ beat, start: cursor, end: cursor + beat.seconds });
    cursor += beat.seconds;
  }
  const total = cursor;

  const initialLevel = new Map<string, number>();
  for (const spec of script.objects) {
    initialLevel.set(spec.id, 'level' in spec && typeof spec.level === 'number' ? spec.level : 1);
  }
  const levelKeys = new Map<string, LevelKey[]>();
  const startKeys = new Map<string, StartKey[]>();
  const cameraKeys: CameraKey[] = [];
  for (const span of beats) {
    for (const act of span.beat.actions ?? []) {
      const t = span.start + act.at;
      if (act.do === 'camera') {
        // from と to は下で、前の指定から順に埋める
        cameraKeys.push({ t, given: act.to, from: script.camera, to: script.camera, dur: Math.max(act.dur, 0.01) });
      } else if (act.do === 'level') {
        const list = levelKeys.get(act.target) ?? [];
        list.push({ t, from: 0, to: act.to, dur: Math.max(act.dur, 0.01) });
        levelKeys.set(act.target, list);
      } else {
        const list = startKeys.get(act.target) ?? [];
        list.push({ t, dur: Math.max(act.dur, 0.01) });
        startKeys.set(act.target, list);
      }
    }
  }
  for (const list of [...levelKeys.values(), ...startKeys.values()]) list.sort((a, b) => a.t - b.t);

  const levelAt = (keys: LevelKey[], initial: number, t: number) => {
    let current: LevelKey | undefined;
    for (const key of keys) {
      if (key.t > t) break;
      current = key;
    }
    if (!current) return initial;
    return current.from + (current.to - current.from) * clamp01((t - current.t) / current.dur);
  };
  // 各指定の開始値を、それより前の指定だけから決めておく
  for (const [id, keys] of levelKeys) {
    const initial = initialLevel.get(id) ?? 1;
    for (const [i, key] of keys.entries()) key.from = levelAt(keys.slice(0, i), initial, key.t);
  }

  cameraKeys.sort((a, b) => a.t - b.t);
  const cameraAt = (keys: CameraKey[], t: number, cut: boolean): Pose => {
    let current: CameraKey | undefined;
    for (const key of keys) {
      if (key.t > t) break;
      current = key;
    }
    if (!current) return script.camera;
    if (cut) return current.to;
    return lerpPose(current.from, current.to, ease(clamp01((t - current.t) / current.dur)));
  };
  for (const [i, key] of cameraKeys.entries()) {
    key.from = cameraAt(cameraKeys.slice(0, i), key.t, false);
    key.to = { ...key.from, ...key.given };
  }

  const beatAt = (t: number) => {
    const i = beats.findIndex((b) => t < b.end);
    return i === -1 ? beats.length - 1 : i;
  };

  const stateAt = (id: string, t: number): ActorState => {
    // level: t までに始まった最後の指定が、その開始時の見え方から to へ補間する
    const level = levelAt(levelKeys.get(id) ?? [], initialLevel.get(id) ?? 1, t);
    let since: number | null = null;
    let dur = 0;
    for (const key of startKeys.get(id) ?? []) {
      if (key.t > t) break;
      since = t - key.t;
      dur = key.dur;
    }
    return { t, level, since, dur };
  };

  return { beats, total, beatAt, stateAt, poseAt: (t, cut = false) => cameraAt(cameraKeys, t, cut) };
}
