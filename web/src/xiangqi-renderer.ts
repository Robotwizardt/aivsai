/**
 * 中国象棋 canvas 渲染器（ADR 0018）：9x10 棋盘，仿 tank-renderer 模式。
 *
 * 棋盘线 + 楚河汉界 + 九宫斜线；棋子为圆形棋子块（红方暖红字 / 黑方墨黑字，
 * 苹果风浅底）；最后一手用高亮标记（起点空圈 + 终点描边）。
 * state 形状见 server/src/games/xiangqi/xiangqi-game.ts（XiangqiGameState）。
 * 直播页（MatchViewPage）与座位页（SeatPage）共用本渲染器。
 */

import type { XiangqiPiece, XiangqiState } from './types';

/** 双方配色（红方暖红 / 黑方墨黑，与直播 UI 一致）。 */
export const XIANGQI_SIDE_COLORS = ['#b02318', '#2c3038'] as const;

const CELL = 52; // 格尺寸（px）；9 列×10 行交叉点棋盘
const PADDING = 34; // 外边距（容纳边框与坐标）

/** 逻辑尺寸：9 列格 → 8 格宽；10 行 → 9 格高。 */
const BOARD_W = 8 * CELL + PADDING * 2;
const BOARD_H = 9 * CELL + PADDING * 2;

/** 棋子显示字（与服务器 PIECE_NAMES 同源）。 */
const PIECE_CHARS: Record<0 | 1, Record<XiangqiPiece['kind'], string>> = {
  0: { r: '車', n: '馬', b: '相', a: '仕', k: '帥', c: '炮', p: '兵' },
  1: { r: '車', n: '馬', b: '象', a: '士', k: '將', c: '砲', p: '卒' },
};

/** 交叉点坐标 → 画布像素（棋子圆心）。 */
function px(x: number, y: number): [number, number] {
  return [PADDING + x * CELL, PADDING + y * CELL];
}

/** 棋盘（线、河界、九宫、坐标）——背景部分每帧重画（简单起见）。 */
function drawBoard(ctx: CanvasRenderingContext2D): void {
  // 底色（暖木色，苹果风浅色）
  ctx.fillStyle = '#f5ead6';
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  ctx.strokeStyle = '#7a5c3e';
  ctx.lineWidth = 1.5;

  // 横线 10 条（y 0..9）
  for (let y = 0; y < 10; y++) {
    const [x0, yy] = px(0, y);
    const [x1] = px(8, y);
    ctx.beginPath();
    ctx.moveTo(x0, yy);
    ctx.lineTo(x1, yy);
    ctx.stroke();
  }
  // 竖线 9 条（中间 7 条分上下半场，边上 2 条贯通）
  for (let x = 0; x < 9; x++) {
    const [xx, y0] = px(x, 0);
    if (x === 0 || x === 8) {
      const [, y9] = px(x, 9);
      ctx.beginPath();
      ctx.moveTo(xx, y0);
      ctx.lineTo(xx, y9);
      ctx.stroke();
    } else {
      const [, y4] = px(x, 4);
      const [, y5] = px(x, 5);
      ctx.beginPath();
      ctx.moveTo(xx, y0);
      ctx.lineTo(xx, y4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(xx, y5);
      const [, y9] = px(x, 9);
      ctx.lineTo(xx, y9);
      ctx.stroke();
    }
  }

  // 外框加粗
  const [fx0, fy0] = px(0, 0);
  const [fx1, fy1] = px(8, 9);
  ctx.lineWidth = 3;
  ctx.strokeRect(fx0 - 4, fy0 - 4, fx1 - fx0 + 8, fy1 - fy0 + 8);
  ctx.lineWidth = 1.5;

  // 九宫斜线（上：x3..5 y0..2；下：x3..5 y7..9）
  for (const top of [0, 7]) {
    const [ax, ay] = px(3, top);
    const [bx, by] = px(5, top + 2);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    const [cx2, cy2] = px(5, top);
    const [dx2, dy2] = px(3, top + 2);
    ctx.beginPath();
    ctx.moveTo(cx2, cy2);
    ctx.lineTo(dx2, dy2);
    ctx.stroke();
  }

  // 楚河汉界
  const [_, riverY1] = px(0, 4);
  const riverMidY = riverY1 + CELL / 2;
  ctx.fillStyle = '#8a6a48';
  ctx.font = '600 22px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('楚 河', PADDING + CELL * 0.7, riverMidY);
  ctx.textAlign = 'right';
  ctx.fillText('漢 界', PADDING + CELL * 7.3, riverMidY);
  ctx.textAlign = 'left';

  // 炮位 / 兵位的传统十字标记（不画边角简化：只画内部点）
  const marks: Array<[number, number]> = [
    [1, 2], [7, 2], [1, 7], [7, 7], // 炮位
    [0, 3], [2, 3], [4, 3], [6, 3], [8, 3], // 黑卒位
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6], // 红兵位
  ];
  const m = 5; // 十字臂长
  const gap = 3; // 与交叉点间距
  ctx.strokeStyle = '#7a5c3e';
  for (const [mx, my] of marks) {
    const [cxx, cyy] = px(mx, my);
    for (const [sx, sy] of [
      [-1, -1], [1, -1], [-1, 1], [1, 1],
    ] as const) {
      // 边列兵位只画内侧半边
      if ((mx === 0 && sx < 0) || (mx === 8 && sx > 0)) continue;
      const ox = cxx + sx * gap;
      const oy = cyy + sy * gap;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + sx * m, oy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox, oy + sy * m);
      ctx.stroke();
    }
  }

  // 坐标标注（列：九~一 红在下；行号省略，保持画面干净）
  ctx.fillStyle = '#a08668';
  ctx.font = '12px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const COLS_TOP = '９８７６５４３２１'; // 黑方视角（上）
  const COLS_BOTTOM = '一二三四五六七八九'; // 红方视角（下）
  for (let x = 0; x < 9; x++) {
    const [cxx, topY] = px(x, 0);
    ctx.fillText(COLS_TOP[x] ?? '', cxx, topY - 22);
    const [, bottomY] = px(x, 9);
    ctx.textBaseline = 'bottom';
    ctx.fillText(COLS_BOTTOM[x] ?? '', cxx, bottomY + 22);
    ctx.textBaseline = 'top';
  }
}

/** 画一枚棋子（圆形棋子块 + 汉字）。 */
function drawPiece(ctx: CanvasRenderingContext2D, piece: XiangqiPiece, x: number, y: number): void {
  const [cxx, cyy] = px(x, y);
  const r = CELL * 0.44;
  const color = XIANGQI_SIDE_COLORS[piece.side];

  // 底盘（米白）+ 描边（方色）
  ctx.beginPath();
  ctx.arc(cxx, cyy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fdf6e3';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = color;
  ctx.stroke();

  // 内圈细线（传统棋子双圈感）
  ctx.beginPath();
  ctx.arc(cxx, cyy, r - 4, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.stroke();

  // 字
  ctx.fillStyle = color;
  ctx.font = `600 ${Math.round(r * 1.15)}px "KaiTi", "STKaiti", "PingFang SC", "Microsoft YaHei", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(PIECE_CHARS[piece.side][piece.kind], cxx, cyy + 1);
}

/** 最后一手高亮：起点空圈 + 终点外框。 */
function drawLastMove(
  ctx: CanvasRenderingContext2D,
  lastMove: { from: [number, number]; to: [number, number] },
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 179, 0, 0.95)';
  ctx.lineWidth = 3;
  const [fx, fy] = lastMove.from;
  const [ax, ay] = px(fx, fy);
  ctx.beginPath();
  ctx.arc(ax, ay, CELL * 0.24, 0, Math.PI * 2);
  ctx.stroke();
  const [tx, ty] = lastMove.to;
  const [bx, by] = px(tx, ty);
  ctx.beginPath();
  ctx.arc(bx, by, CELL * 0.52, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** 渲染一帧象棋局面（tank-renderer 同风格入口）。 */
export function renderXiangqiFrame(
  ctx: CanvasRenderingContext2D,
  state: XiangqiState,
): void {
  ctx.canvas.width = BOARD_W;
  ctx.canvas.height = BOARD_H;

  drawBoard(ctx);

  if (state.lastMove) drawLastMove(ctx, state.lastMove);

  // 棋子（后画压在高亮之上）
  for (let y = 0; y < 10; y++) {
    const row = state.board[y];
    if (!Array.isArray(row)) continue;
    for (let x = 0; x < 9; x++) {
      const piece = row[x];
      if (piece && (piece.side === 0 || piece.side === 1) && typeof piece.kind === 'string') {
        drawPiece(ctx, piece, x, y);
      }
    }
  }
}

/** 逻辑画布尺寸（供 canvas 元素属性与布局）。 */
export const XIANGQI_CANVAS_SIZE = { width: BOARD_W, height: BOARD_H } as const;
