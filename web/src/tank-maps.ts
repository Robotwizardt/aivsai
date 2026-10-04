/**
 * 坦克大战预设地图数据（前端展示用，与 server/src/games/tank/tank-game.ts 的
 * PRESET_SOURCES / expandPresetRows 保持一致：左半 10 列字符画，右半镜像补全，
 * 字符语义 x=墙 m=土堆 o=草 .=空地，WIDTH=20 HEIGHT=15）。
 * 仅用于游戏详情页的地图预览；若服务端地图池变更需同步本文件。
 */

import { TankTerrain } from './types';

export const TANK_MAP_ARENA = { width: 20, height: 15 } as const;

export interface TankMapPreview {
  id: string;
  name: string;
  terrain: TankTerrain;
}

/** 与服务端 PRESET_SOURCES 完全一致的左半字符画（rows[y][x]，x ∈ 0..9）。 */
const PRESET_SOURCES: readonly {
  id: string;
  name: string;
  rows: readonly string[];
}[] = [
  {
    id: 'fortress',
    name: '要塞',
    rows: [
      '.o..o.....',
      '.....xxx..',
      '.....x.xo.',
      '.....x.x..',
      '..o......m',
      '.....m....',
      '.....m....',
      '...o.....o',
      '.....m....',
      '.....m....',
      '..o......m',
      '.....x.x..',
      '.....x.xo.',
      '.....xxx..',
      '.o..o.....',
    ],
  },
  {
    id: 'meadow',
    name: '林间空地',
    rows: [
      '.....oo.o.',
      '.x...o.o..',
      '.x....o.o.',
      '...o......',
      '.....o..x.',
      '......m..o',
      '....o.....',
      '....o....o',
      '....o.....',
      '......m..o',
      '.....o..x.',
      '...o......',
      '.x....o.o.',
      '.x...o.o..',
      '.....oo.o.',
    ],
  },
  {
    id: 'ruins',
    name: '废墟巷战',
    rows: [
      '..o..x...x',
      '.....x...x',
      '.....x.o.x',
      '.....x....',
      '....m.m.o.',
      '.o.......x',
      '.......m..',
      '.......o..',
      '.......m..',
      '.o.......x',
      '....m.m.o.',
      '.....x....',
      '.....x.o.x',
      '.....x...x',
      '..o..x...x',
    ],
  },
  {
    id: 'checker',
    name: '菱阵',
    rows: [
      '.....o.o..',
      '..........',
      'x........x',
      '.....m.m..',
      '......m.m.',
      '.....m.m..',
      '..o.......',
      '.....o..o.',
      '..o.......',
      '.....m.m..',
      '......m.m.',
      '.....m.m..',
      'x........x',
      '..........',
      '.....o.o..',
    ],
  },
];

/** 复刻服务端 expandPresetRows：左半字符画展开为完整地图（左右镜像，mx = WIDTH-1-x）。 */
function expandPresetRows(rows: readonly string[]): TankTerrain {
  const walls: string[] = [];
  const mounds: string[] = [];
  const grass: string[] = [];
  const { width } = TANK_MAP_ARENA;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === '.') continue;
      const target =
        ch === 'x' ? walls : ch === 'm' ? mounds : ch === 'o' ? grass : null;
      if (target === null) continue;
      target.push(`${x},${y}`);
      const mx = width - 1 - x;
      if (mx !== x) target.push(`${mx},${y}`);
    }
  });
  return { walls, mounds, grass };
}

/** 预设地图池（与服务端 TANK_MAP_PRESETS 的 4 张预设一一对应）。 */
export const TANK_MAP_PREVIEWS: readonly TankMapPreview[] = PRESET_SOURCES.map((s) => ({
  id: s.id,
  name: s.name,
  terrain: expandPresetRows(s.rows),
}));
