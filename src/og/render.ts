import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OgTemplate, type OgMeta } from './template';

const __dirname = dirname(fileURLToPath(import.meta.url));

// フォントはツールごとに読み直すと build 時に全ツール分 I/O が重複するため、モジュール
// スコープで一度だけ読み込んで使い回す
const fontsDir = join(
  __dirname,
  '..',
  '..',
  'node_modules',
  '@fontsource',
  'sawarabi-mincho',
  'files',
);
// japanese サブセットはラテン文字も持つので 1 本で足りる。latin サブセットを同じ family 名で
// 足しても satori は同名 (family/weight/style) を 1 本に畳んで一方しか使わないため意味がない
const japaneseFont = readFileSync(join(fontsDir, 'sawarabi-mincho-japanese-400-normal.woff'));

// このサブセットが欠く漢字は tofu (□) になる。フォールバックフォントは積んでいないので、
// ツールの title / description はこのフォントが持つ字の範囲で書く
const fonts = [
  { name: 'Sawarabi Mincho', data: japaneseFont, weight: 400 as const, style: 'normal' as const },
];

export async function renderOgPng(meta: OgMeta): Promise<Buffer> {
  const svg = await satori(OgTemplate(meta), {
    width: 1200,
    height: 630,
    fonts,
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });
  return resvg.render().asPng();
}
