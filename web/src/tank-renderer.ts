/**
 * 坦克大战 canvas 渲染器：20x15 网格。
 * 墙 = 深灰块；坦克 = 彩色方块 + 朝向三角；子弹 = 小圆点；HP 条画在坦克上方。
 * state 形状见 server/src/games/tank/tank-game.ts（TankGameState）。
 */

import { TankGameState } from './types';

const SIDE_COLORS = ['#3b82f6', '#ef4444'];
const CELL = 30; // 逻辑格尺寸（px），canvas 实际按 DPR 缩放
const PADDING = 6;

/** 方向：0=北 1=东 2=南 3=西。 */
const DIR_VECTORS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

export function renderTankFrame(ctx: CanvasRenderingContext2D, state: TankGameState): void {
  const { width, height } = state.arena;
  const w = width * CELL + PADDING * 2;
  const h = height * CELL + PADDING * 2;
  ctx.canvas.width = w;
  ctx.canvas.height = h;

  // 背景
  ctx.fillStyle = '#1a2230';
  ctx.fillRect(0, 0, w, h);

  // 网格底色
  ctx.fillStyle = '#232e40';
  ctx.fillRect(PADDING, PADDING, width * CELL, height * CELL);

  // 细网格线
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x++) {
    ctx.beginPath();
    ctx.moveTo(PADDING + x * CELL, PADDING);
    ctx.lineTo(PADDING + x * CELL, PADDING + height * CELL);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y++) {
    ctx.beginPath();
    ctx.moveTo(PADDING, PADDING + y * CELL);
    ctx.lineTo(PADDING + width * CELL, PADDING + y * CELL);
    ctx.stroke();
  }

  // 墙壁（"x,y" 字符串集合）
  ctx.fillStyle = '#4b5563';
  for (const wall of state.walls) {
    const [xs, ys] = wall.split(',');
    const x = Number(xs);
    const y = Number(ys);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    ctx.fillRect(PADDING + x * CELL + 1, PADDING + y * CELL + 1, CELL - 2, CELL - 2);
  }

  // 坦克（含 HP 条与朝向三角）
  state.tanks.forEach((tank, side) => {
    const cx = PADDING + tank.x * CELL;
    const cy = PADDING + tank.y * CELL;
    const color = SIDE_COLORS[side] ?? '#999';

    if (tank.hp > 0) {
      // 车身
      ctx.fillStyle = color;
      ctx.fillRect(cx + 4, cy + 4, CELL - 8, CELL - 8);
      // 炮管（朝向前伸出）
      const d = DIR_VECTORS[tank.direction] ?? DIR_VECTORS[0];
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx + CELL / 2, cy + CELL / 2);
      ctx.lineTo(cx + CELL / 2 + d.dx * (CELL / 2 - 2), cy + CELL / 2 + d.dy * (CELL / 2 - 2));
      ctx.stroke();
      // 朝向三角（车身前缘小三角指示）
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      const mx = cx + CELL / 2;
      const my = cy + CELL / 2;
      const t = 5;
      const ex = mx + d.dx * (CELL / 2 + 2);
      const ey = my + d.dy * (CELL / 2 + 2);
      // 三角形三顶点：尖端在朝向、底边垂直于朝向
      const px = d.dy;
      const py = d.dx;
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - d.dx * t + px * t, ey - d.dy * t + py * t);
      ctx.lineTo(ex - d.dx * t - px * t, ey - d.dy * t - py * t);
      ctx.closePath();
      ctx.fill();
    }

    // HP 条（坦克上方，死后显示为空）
    const hpRatio = Math.max(0, Math.min(1, tank.hp / 100));
    const barY = cy - 2;
    ctx.fillStyle = '#111827';
    ctx.fillRect(cx + 2, barY, CELL - 4, 4);
    ctx.fillStyle = tank.hp <= 34 ? '#f87171' : tank.hp <= 67 ? '#facc15' : '#4ade80';
    ctx.fillRect(cx + 2, barY, (CELL - 4) * hpRatio, 4);
  });

  // 子弹
  for (const bullet of state.bullets) {
    ctx.fillStyle = '#fde68a';
    ctx.beginPath();
    ctx.arc(PADDING + bullet.x * CELL + CELL / 2, PADDING + bullet.y * CELL + CELL / 2, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

export const TANK_SIDE_COLORS = SIDE_COLORS;
