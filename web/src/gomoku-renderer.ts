/**
 * 五子棋 canvas 渲染器：15x15 交叉点棋盘，仿 xiangqi-renderer / tank-renderer 模式。
 *
 * 木色棋盘 + 星位（天元与四星）；棋子为圆形块（黑子墨黑 / 白子米白加描边）；
 * 最后一手用金圈标记；成五时把获胜的那串棋子连成金线（与服务器同口径：≥5 即胜）。
 * state 形状见 server/src/games/gomoku/gomoku-game.ts（GomokuGameState）。
 * 直播页（MatchViewPage）与座位页（SeatPage）共用本渲染器。
 */

import type { GomokuState } from './types';

/** 双方文本色（浅底上可读）：黑方墨黑 / 白方灰。 */
export const GOMOKU_SIDE_COLORS = ['#2c3038', '#8a9099'] as const;

/** 棋子填充与描边（白子靠描边与棋盘区分）。 */
const STONE_FILLS = ['#2b2f36', '#ffffff'] as const;
const STONE_STROKES = ['#0d1016', '#aeb5c0'] as const;

/** 棋盘：15x15 交叉点。 */
const SIZE = 15;
const CELL = 32; // 格尺寸（px）
const PADDING = 28; // 外边距
const BOARD_W = (SIZE - 1) * CELL + PADDING * 2;
const BOARD_H = BOARD_W;

const WIN_LENGTH = 5;

/** 星位：天元 + 四星。 */
const STARS: ReadonlyArray<readonly [number, number]> = [
  [7, 7],
  [3, 3],
  [11, 3],
  [3, 11],
  [11, 11],
];

/** 五连的四个轴向（与服务器 LINES 同源）。 */
const LINES: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
];

/** 交叉点坐标 → 画布像素（棋子圆心）。 */
function px(x: number, y: number): [number, number] {
  return [PADDING + x * CELL, PADDING + y * CELL];
}

/** 棋盘（底色、格线、外框、星位）——每帧重画（简单起见）。 */
function drawBoard(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#f2e2c4';
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  ctx.strokeStyle = '#c19a6b';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const [x0, yy] = px(0, i);
    const [x1] = px(SIZE - 1, i);
    ctx.beginPath();
    ctx.moveTo(x0, yy);
    ctx.lineTo(x1, yy);
    ctx.stroke();
    const [xx, y0] = px(i, 0);
    const [, y1] = px(i, SIZE - 1);
    ctx.beginPath();
    ctx.moveTo(xx, y0);
    ctx.lineTo(xx, y1);
    ctx.stroke();
  }

  ctx.strokeStyle = '#a9803f';
  ctx.lineWidth = 2;
  const [fx0, fy0] = px(0, 0);
  const [fx1, fy1] = px(SIZE - 1, SIZE - 1);
  ctx.strokeRect(fx0, fy0, fx1 - fx0, fy1 - fy0);

  ctx.fillStyle = '#a9803f';
  for (const [sx, sy] of STARS) {
    const [cxx, cyy] = px(sx, sy);
    ctx.beginPath();
    ctx.arc(cxx, cyy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 画一枚棋子。 */
function drawStone(ctx: CanvasRenderingContext2D, side: 0 | 1, x: number, y: number): void {
  const [cxx, cyy] = px(x, y);
  ctx.beginPath();
  ctx.arc(cxx, cyy, CELL * 0.44, 0, Math.PI * 2);
  ctx.fillStyle = STONE_FILLS[side];
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = STONE_STROKES[side];
  ctx.stroke();
}

/** 最后一手：金圈。 */
function drawLastMove(ctx: CanvasRenderingContext2D, move: readonly [number, number]): void {
  const [cxx, cyy] = px(move[0], move[1]);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 179, 0, 0.95)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cxx, cyy, CELL * 0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * 找获胜连线：返回成五的那串交叉点，找不到回 null。
 * 与服务器同口径（任一轴向连成 ≥5 同色子即胜）；只从连线起点开始数，避免重复计入。
 */
export function findWinningLine(board: GomokuState['board']): Array<[number, number]> | null {
  const at = (x: number, y: number): 0 | 1 | null => {
    const row = board[y];
    if (!Array.isArray(row)) return null;
    const cell = row[x];
    return cell === 0 || cell === 1 ? cell : null;
  };

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const side = at(x, y);
      if (side === null) continue;
      for (const { dx, dy } of LINES) {
        if (at(x - dx, y - dy) === side) continue; // 不是起点，跳过
        const line: Array<[number, number]> = [];
        for (let i = 0; at(x + dx * i, y + dy * i) === side; i++) {
          line.push([x + dx * i, y + dy * i]);
        }
        if (line.length >= WIN_LENGTH) return line;
      }
    }
  }
  return null;
}

/** 获胜连线：金线贯穿 + 逐点金圈。画在棋子之前——棋子压住线身，只露出缝隙与圈。 */
function drawWinningLine(ctx: CanvasRenderingContext2D, line: Array<[number, number]>): void {
  const head = line[0];
  const tail = line[line.length - 1];
  if (!head || !tail) return;
  const [hx, hy] = px(head[0], head[1]);
  const [tx, ty] = px(tail[0], tail[1]);

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 179, 0, 0.9)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  ctx.lineWidth = 2.5;
  for (const [x, y] of line) {
    const [cxx, cyy] = px(x, y);
    ctx.beginPath();
    ctx.arc(cxx, cyy, CELL * 0.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** 渲染一帧五子棋局面（与 renderXiangqiFrame 同风格入口）。 */
export function renderGomokuFrame(ctx: CanvasRenderingContext2D, state: GomokuState): void {
  ctx.canvas.width = BOARD_W;
  ctx.canvas.height = BOARD_H;

  drawBoard(ctx);

  // 获胜连线先画：棋子压住线身，只露缝隙与外圈金圈
  const win = findWinningLine(state.board);
  if (win) drawWinningLine(ctx, win);

  for (let y = 0; y < SIZE; y++) {
    const row = state.board[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < SIZE; x++) {
      const cell = row[x];
      if (cell === 0 || cell === 1) drawStone(ctx, cell, x, y);
    }
  }

  // 最后一手的圈画在最上层（可能与获胜圈重叠，叠成略粗的金圈）
  if (state.lastMove) drawLastMove(ctx, state.lastMove);
}

/** 逻辑画布尺寸（供 canvas 元素属性与布局）。 */
export const GOMOKU_CANVAS_SIZE = { width: BOARD_W, height: BOARD_H } as const;
