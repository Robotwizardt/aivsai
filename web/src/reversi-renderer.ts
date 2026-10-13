import type { ReversiState } from './types';

const CELL = 56;
const PAD = 28;
const SIZE = CELL * 8 + PAD * 2;
export const REVERSI_CANVAS_SIZE = { width: SIZE, height: SIZE } as const;

/** 开局占位必须与服务端一致；不把中央四子计作落子。 */
export function initialReversiState(): ReversiState {
  const board = Array.from({ length: 8 }, () => Array<0 | 1 | null>(8).fill(null));
  board[3][3] = board[4][4] = 1;
  board[3][4] = board[4][3] = 0;
  return { board, currentSide: 0, lastMove: null, moveCount: 0, counts: [2, 2], lastFlipped: [], passedSide: null };
}

/** 坐标与行动契约一致：左上 [0,0]，不翻转座位视角。 */
export function reversiCoordinate([x, y]: readonly [number, number]): string {
  return `[${x},${y}]`;
}

/** 棋子落在格内；金圈为本手落子，蓝框为本手翻转，圆点仅为只读合法落点。 */
export function renderReversiFrame(
  ctx: CanvasRenderingContext2D,
  state: ReversiState,
  legalMoves: ReadonlyArray<readonly [number, number]> = [],
): void {
  ctx.canvas.width = SIZE;
  ctx.canvas.height = SIZE;
  ctx.fillStyle = '#e5eee8';
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#77a58b' : '#83af97';
    ctx.fillRect(PAD + x * CELL, PAD + y * CELL, CELL, CELL);
  }
  ctx.strokeStyle = '#416b55';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(PAD + i * CELL, PAD);
    ctx.lineTo(PAD + i * CELL, SIZE - PAD);
    ctx.moveTo(PAD, PAD + i * CELL);
    ctx.lineTo(SIZE - PAD, PAD + i * CELL);
    ctx.stroke();
  }
  ctx.fillStyle = '#314c3d';
  ctx.font = '13px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 8; i++) {
    ctx.fillText(String(i), PAD + (i + .5) * CELL, PAD / 2);
    ctx.fillText(String(i), PAD / 2, PAD + (i + .5) * CELL);
  }
  for (const [x, y] of state.lastFlipped) {
    ctx.strokeStyle = '#075dcc';
    ctx.lineWidth = 4;
    ctx.strokeRect(PAD + x * CELL + 4, PAD + y * CELL + 4, CELL - 8, CELL - 8);
  }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const side = state.board[y][x];
    if (side === null) continue;
    ctx.beginPath();
    ctx.arc(PAD + (x + .5) * CELL, PAD + (y + .5) * CELL, CELL * .36, 0, Math.PI * 2);
    ctx.fillStyle = side === 0 ? '#252a30' : '#fffefa';
    ctx.fill();
    ctx.strokeStyle = side === 0 ? '#10151a' : '#c4ccc7';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  for (const [x, y] of legalMoves) {
    if (state.board[y]?.[x] !== null) continue;
    ctx.beginPath();
    ctx.arc(PAD + (x + .5) * CELL, PAD + (y + .5) * CELL, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#244e39';
    ctx.fill();
  }
  if (state.lastMove) {
    const [x, y] = state.lastMove;
    ctx.beginPath();
    ctx.arc(PAD + (x + .5) * CELL, PAD + (y + .5) * CELL, CELL * .42, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffcc32';
    ctx.lineWidth = 4;
    ctx.stroke();
  }
}
