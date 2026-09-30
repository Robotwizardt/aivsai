/**
 * 坦克大战 canvas 渲染器（v2）：20x15 网格。
 * 墙 = 深灰块；土堆 = 土黄块（可被摧毁）；草 = 半透明绿色覆盖层；
 * 星星 = 金色目标物；坦克 = 彩色方块 + 朝向三角 + HP 条 + 星数徽章；
 * 气泡 = 坦克上方最近一条发言（带说话人颜色）。
 * 旧回放缺 terrain/star/bubbles 时优雅降级（walls 当墙渲染）。
 * state 形状见 server/src/games/tank/tank-game.ts（TankGameState）。
 */

import { TankGameState } from './types';

/** 双方（0/1）配色：canvas 渲染与 HP 条/图例共用同一份。 */
export const TANK_SIDE_COLORS = ['#3b82f6', '#ef4444'] as const;

const CELL = 30; // 逻辑格尺寸（px），canvas 实际按 DPR 缩放
const PADDING = 6;

/** 渲染调色板（图例与 canvas 共用，保证一致）。 */
export const TERRAIN_LEGEND: ReadonlyArray<{ key: string; label: string; color: string }> = [
  { key: 'wall', label: '墙（不可摧毁）', color: '#4b5563' },
  { key: 'mound', label: '土堆（可被子弹摧毁）', color: '#c28e3c' },
  { key: 'grass', label: '草（站上去对敌方隐身）', color: 'rgba(74, 222, 128, 0.4)' },
  { key: 'star', label: '星星（拾取得分）', color: '#fbbf24' },
];

/** 方向：0=北 1=东 2=南 3=西。 */
const DIR_VECTORS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

/** "x,y" → 格坐标，非法返回 null。 */
function parseCell(s: string): { x: number; y: number } | null {
  const [xs, ys] = s.split(',');
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { x, y };
}

/** 气泡保留时长（tick 数）：约 1.5s（假设 10 tick/s，取 15）。 */
const BUBBLE_TTL_TICKS = 15;

/** 每方最近一条气泡（按 tick 最新且未过期）。 */
function latestBubblePerSide(state: TankGameState): Array<{ text: string; tick: number } | null> {
  const result: Array<{ text: string; tick: number } | null> = [null, null];
  if (!Array.isArray(state.bubbles)) return result;
  for (const b of state.bubbles) {
    if (b.side !== 0 && b.side !== 1) continue;
    if (typeof b.text !== 'string' || typeof b.tick !== 'number') continue;
    if (state.tick - b.tick > BUBBLE_TTL_TICKS) continue; // 1.5s 渐隐窗口外不显示
    const cur = result[b.side];
    if (!cur || b.tick >= cur.tick) result[b.side] = { text: b.text, tick: b.tick };
  }
  return result;
}

/** 气泡剩余寿命比例（1 → 0），用于透明度渐隐。 */
function bubbleAlpha(bubble: { text: string; tick: number }, state: TankGameState): number {
  const age = state.tick - bubble.tick;
  if (age <= BUBBLE_TTL_TICKS * 0.6) return 1; // 前 60% 时间完全不透明
  return Math.max(0, 1 - (age - BUBBLE_TTL_TICKS * 0.6) / (BUBBLE_TTL_TICKS * 0.4));
}

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

  // 地形：v2 terrain 优先，旧 state 只有 walls（当墙渲染）
  const walls = state.terrain?.walls ?? state.walls ?? [];
  const mounds = state.terrain?.mounds ?? [];
  const grass = state.terrain?.grass ?? [];

  // 墙（深灰实心 + 内描边，硬朗感）
  ctx.fillStyle = '#4b5563';
  for (const cell of walls) {
    const c = parseCell(cell);
    if (!c) continue;
    ctx.fillRect(PADDING + c.x * CELL + 1, PADDING + c.y * CELL + 1, CELL - 2, CELL - 2);
  }
  // 墙的顶部高光（区分于土堆）
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (const cell of walls) {
    const c = parseCell(cell);
    if (!c) continue;
    ctx.fillRect(PADDING + c.x * CELL + 2, PADDING + c.y * CELL + 2, CELL - 4, 3);
  }

  // 土堆（土黄圆角堆，观感与墙明显区分：更暖、更圆润）
  for (const cell of mounds) {
    const c = parseCell(cell);
    if (!c) continue;
    const x = PADDING + c.x * CELL;
    const y = PADDING + c.y * CELL;
    ctx.fillStyle = '#c28e3c';
    ctx.beginPath();
    ctx.roundRect(x + 2, y + 2, CELL - 4, CELL - 4, 7);
    ctx.fill();
    // 堆顶高光小点
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.arc(x + CELL / 2, y + CELL / 2 - 3, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 草（先记下位置，坦克之后叠加：坦克在草上半透明）
  const grassSet = new Set<string>(grass);

  // 星星（金色五角星，明显目标物）
  if (state.star && Number.isFinite(state.star.x) && Number.isFinite(state.star.y)) {
    drawStar(
      ctx,
      PADDING + state.star.x * CELL + CELL / 2,
      PADDING + state.star.y * CELL + CELL / 2,
      CELL / 2 - 4,
    );
  }

  // 坦克（含 HP 条、星数徽章与朝向三角）
  const bubbles = latestBubblePerSide(state);
  state.tanks.forEach((tank, side) => {
    const cx = PADDING + tank.x * CELL;
    const cy = PADDING + tank.y * CELL;
    const color = TANK_SIDE_COLORS[side] ?? '#999';
    const onGrass = grassSet.has(`${tank.x},${tank.y}`);

    if (tank.hp > 0) {
      ctx.save();
      if (onGrass) ctx.globalAlpha = 0.45; // 草上坦克半透明（隐身观感）

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

      // 星数徽章（⭐×N，画在车身右下角小圆片上）
      const stars = typeof tank.stars === 'number' ? tank.stars : 0;
      if (stars > 0) {
        const bx = cx + CELL - 5;
        const by = cy + CELL - 4;
        ctx.fillStyle = '#111827';
        ctx.beginPath();
        ctx.arc(bx, by, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(stars), bx, by + 0.5);
      }
      ctx.restore();
    }

    // HP 条（坦克上方，死后显示为空）
    const hpRatio = Math.max(0, Math.min(1, tank.hp / 100));
    const barY = cy - 2;
    ctx.fillStyle = '#111827';
    ctx.fillRect(cx + 2, barY, CELL - 4, 4);
    ctx.fillStyle = tank.hp <= 34 ? '#f87171' : tank.hp <= 67 ? '#facc15' : '#4ade80';
    ctx.fillRect(cx + 2, barY, (CELL - 4) * hpRatio, 4);

    // 气泡（坦克上方，带说话人颜色边框，1.5s 渐隐）
    const bubble = bubbles[side];
    if (bubble && tank.hp > 0) {
      drawBubble(ctx, cx + CELL / 2, cy - 10, bubble.text, color, bubbleAlpha(bubble, state));
    }
  });

  ctx.fillStyle = 'rgba(74, 222, 128, 0.28)';
  for (const cell of grass) {
    const c = parseCell(cell);
    if (!c) continue;
    ctx.fillRect(PADDING + c.x * CELL + 1, PADDING + c.y * CELL + 1, CELL - 2, CELL - 2);
  }
  // 草叶纹理（几笔短竖线，让草可辨识）
  ctx.strokeStyle = 'rgba(34, 140, 70, 0.55)';
  ctx.lineWidth = 2;
  for (const cell of grass) {
    const c = parseCell(cell);
    if (!c) continue;
    const x = PADDING + c.x * CELL;
    const y = PADDING + c.y * CELL;
    ctx.beginPath();
    ctx.moveTo(x + 8, y + CELL - 6);
    ctx.lineTo(x + 8, y + CELL - 12);
    ctx.moveTo(x + 15, y + CELL - 5);
    ctx.lineTo(x + 15, y + CELL - 13);
    ctx.moveTo(x + 22, y + CELL - 6);
    ctx.lineTo(x + 22, y + CELL - 11);
    ctx.stroke();
  }

  // 子弹
  for (const bullet of state.bullets) {
    ctx.fillStyle = '#fde68a';
    ctx.beginPath();
    ctx.arc(PADDING + bullet.x * CELL + CELL / 2, PADDING + bullet.y * CELL + CELL / 2, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 五角星（金色 + 描边 + 呼吸光晕由静态高光代替）。 */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number): void {
  const inner = outer * 0.45;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = '#fbbf24';
  ctx.fill();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** 说话气泡：白底 + 说话人颜色描边 + 小尾巴，超宽截断。 */
function drawBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  bottomY: number,
  text: string,
  color: string,
  alpha: number,
): void {
  const clipped = text.length > 20 ? `${text.slice(0, 20)}…` : text;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = 'bold 11px sans-serif';
  const pad = 5;
  const tw = ctx.measureText(clipped).width;
  const bw = tw + pad * 2;
  const bh = 18;
  const x = cx - bw / 2;
  const y = bottomY - bh - 4;

  // 气泡体
  ctx.fillStyle = '#f9fafb';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, bw, bh, 5);
  ctx.fill();
  ctx.stroke();

  // 尾巴（指向坦克）
  ctx.beginPath();
  ctx.moveTo(cx - 3, y + bh - 0.5);
  ctx.lineTo(cx, y + bh + 4);
  ctx.lineTo(cx + 3, y + bh - 0.5);
  ctx.closePath();
  ctx.fillStyle = '#f9fafb';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - 3, y + bh - 0.5);
  ctx.lineTo(cx, y + bh + 4);
  ctx.lineTo(cx + 3, y + bh - 0.5);
  ctx.stroke();

  // 文本
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(clipped, cx, y + bh / 2 + 0.5);
  ctx.restore();
}
