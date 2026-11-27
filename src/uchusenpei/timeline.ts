// 台本を「時刻 → 状態」の表に直す。
// 再生は前の状態を少しずつ積み上げるのではなく、毎フレーム「台本の時刻 t での状態」を台本から計算し直す。
// だから任意の文・任意の時刻へ飛んでも、そこまで再生したときと同じ見え方になる。

import type { Beat, Script } from './script';

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

type LevelKey = { t: number; to: number; dur: number };
type StartKey = { t: number; dur: number };

export type Timeline = {
  beats: BeatSpan[];
  total: number;
  beatAt: (t: number) => number;
  stateAt: (id: string, t: number) => ActorState;
};

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

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
  for (const span of beats) {
    for (const act of span.beat.actions ?? []) {
      const t = span.start + act.at;
      if (act.do === 'level') {
        const list = levelKeys.get(act.target) ?? [];
        list.push({ t, to: act.to, dur: Math.max(act.dur, 0.01) });
        levelKeys.set(act.target, list);
      } else {
        const list = startKeys.get(act.target) ?? [];
        list.push({ t, dur: Math.max(act.dur, 0.01) });
        startKeys.set(act.target, list);
      }
    }
  }
  for (const list of [...levelKeys.values(), ...startKeys.values()]) list.sort((a, b) => a.t - b.t);

  const beatAt = (t: number) => {
    const i = beats.findIndex((b) => t < b.end);
    return i === -1 ? beats.length - 1 : i;
  };

  const stateAt = (id: string, t: number): ActorState => {
    // level: 初期値から、t までに始まった level を順に当てる（途中のものはその割合だけ）
    let level = initialLevel.get(id) ?? 1;
    for (const key of levelKeys.get(id) ?? []) {
      if (key.t > t) break;
      level = level + (key.to - level) * clamp01((t - key.t) / key.dur);
    }
    let since: number | null = null;
    let dur = 0;
    for (const key of startKeys.get(id) ?? []) {
      if (key.t > t) break;
      since = t - key.t;
      dur = key.dur;
    }
    return { t, level, since, dur };
  };

  return { beats, total, beatAt, stateAt };
}
