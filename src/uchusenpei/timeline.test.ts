import { describe, expect, test } from 'bun:test';
import raw from './script.json';
import { parseScript } from './script';
import { compile } from './timeline';

const timeline = compile(parseScript(raw));
const startOf = (id: string) => timeline.beats.find((b) => b.beat.id === id)?.start ?? Number.NaN;

describe('uchusenpei の視点', () => {
  test('台本の視点の指定は検証を通る', () => {
    expect(() => parseScript({ ...raw, camera: { position: [0, 0], yaw: 0, pitch: 0 } })).toThrow('position');
    expect(() => parseScript({ ...raw, camera: { position: [0, 0, 0], yaw: Infinity, pitch: 0 } })).toThrow('yaw');
  });

  test('始まりは台本の camera', () => {
    expect(timeline.poseAt(0)).toEqual(parseScript(raw).camera);
  });

  test('指定が切り替わる時刻で視点が飛ばない', () => {
    for (const t of [startOf('b05'), startOf('b06'), startOf('b08'), startOf('b09'), startOf('b11')]) {
      const before = timeline.poseAt(t - 0.001);
      const after = timeline.poseAt(t + 0.001);
      for (const [i, v] of before.position.entries()) expect(Math.abs(v - (after.position[i] ?? 0))).toBeLessThan(0.05);
      expect(Math.abs(before.yaw - after.yaw)).toBeLessThan(0.05);
      expect(Math.abs(before.pitch - after.pitch)).toBeLessThan(0.05);
    }
  });

  test('書いていない項目は直前の視点を引き継ぐ', () => {
    // b11 は向きだけを変える。艇の位置は宇宙の墓地の上のまま
    const end = timeline.poseAt(timeline.total);
    expect(end.position).toEqual(timeline.poseAt(startOf('b11')).position);
    expect(end.yaw).toBe(175);
  });

  test('動きを減らす設定では、効いている指定の行き先へ切り替わる', () => {
    expect(timeline.poseAt(startOf('b06') + 0.5, true).pitch).toBe(17);
  });

  test('動きを減らす設定でも、書いていない項目は前の行き先を引き継ぐ', () => {
    // b11 は向きだけを変える。艇は b09 の行き先（墓地の上）にいるはず
    const end = timeline.poseAt(timeline.total, true);
    expect(end.position).toEqual([4, -14, -282]);
    expect(end.yaw).toBe(175);
  });

  test('動きの途中で向きだけ変えても、動きを減らす設定では前の行き先にとどまる', () => {
    const [first, second] = raw.beats;
    const moving = compile(
      parseScript({
        ...raw,
        beats: [
          { ...first, seconds: 4, actions: [{ at: 0, do: 'camera', to: { position: [0, 0, -100] }, dur: 10 }] },
          { ...second, seconds: 4, actions: [{ at: 0, do: 'camera', to: { yaw: 90 }, dur: 1 }] },
        ],
      }),
    );
    expect(moving.poseAt(6, true).position).toEqual([0, 0, -100]);
    expect(moving.poseAt(6, true).yaw).toBe(90);
  });
});
