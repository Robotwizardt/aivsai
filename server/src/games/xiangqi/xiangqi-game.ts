/**
 * 中国象棋游戏包（ADR 0018：v1 仅表演赛开放）。
 *
 * 规则实现（完整基本规则）：
 * - 9x10 棋盘，side 0 执红先行（红在下 y=7..9，黑在上 y=0..2）；
 * - 全部棋子走法：车（直线）、马（日字+蹩马腿）、象/相（田字+塞象眼+不过河）、
 *   士/仕（九宫斜线）、将/帅（九宫直线一格）、炮（平移直线 / 吃子隔一炮架）、
 *   兵/卒（过河前只进、过河后可平移、永不后退）；
 * - 将帅照面（白脸将）：两将同列无遮挡的走法非法；
 * - 将军必须应将：走完后自己被将军的走法非法（含主动送将）；
 * - 将死 / 困毙：轮到某方无任何合法走法时，被将军 = 将死（对方胜），
 *   未被将军 = 困毙（中国规则判负）；
 * - 简化和棋：连续 60 回合（120 手）无吃子判和；
 * - 长将 / 长捉禁手 v1 不实现（ADR 0018 留给后续版本）。
 *
 * 走法协议：{ from: [x, y], to: [x, y] }，0 基坐标，与五子棋 {place:[x,y]} 风格一致。
 * 非法走法返回人类可读中文原因（如「马走日被蹩马腿」），连续 3 次非法判负。
 *
 * 坐标系：x 0..8（列，左起），y 0..9（行，黑在上红在下）。
 * 帧与观察的 board 均为 board[y][x]，格值为 null（空）或棋子对象
 * { side, kind }，kind ∈ 'r'|'n'|'b'|'a'|'k'|'c'|'p'（车马象士将炮兵）。
 *
 * v1 边界（ADR 0018）：不进常规游戏列表（平台层负责），本包只实现规则；
 * 无随机要素，seed 接受但忽略。
 */

import type {
  EntrantHandle,
  FrameSnapshot,
  GameDefinition,
  GameInstance,
  GamePackage,
  MatchResult,
} from '../contracts.js';
import { unwrapEnvelope } from '../../engine/sandbox-contracts.js';

// ---------------------------------------------------------------- 常量与类型

const BOARD_WIDTH = 9;
const BOARD_HEIGHT = 10;
/** 连续多少回合（双方各走一手算一回合）无吃子判和。 */
const DRAW_NO_CAPTURE_ROUNDS = 60;
const MAX_STRATEGY_ERRORS = 3;

type Side = 0 | 1;
/** 棋子种类：车马象士将炮兵。 */
export type PieceKind = 'r' | 'n' | 'b' | 'a' | 'k' | 'c' | 'p';

export interface Piece {
  readonly side: Side;
  readonly kind: PieceKind;
}

/** board[y][x]：null 或棋子。 */
export type Board = ReadonlyArray<ReadonlyArray<Piece | null>>;
/** 可变棋盘（内部实现用）。 */
type MutableBoard = Array<Array<Piece | null>>;

const PIECE_NAMES: Record<Side, Record<PieceKind, string>> = {
  0: { r: '车', n: '马', b: '相', a: '仕', k: '帅', c: '炮', p: '兵' },
  1: { r: '车', n: '马', b: '象', a: '士', k: '将', c: '炮', p: '卒' },
};

const PIECE_FULL_NAMES: Record<PieceKind, string> = {
  r: '车（直线）',
  n: '马（日字）',
  b: '象/相（田字）',
  a: '士/仕（九宫斜线）',
  k: '将/帅（九宫直线一格）',
  c: '炮（平移直线，吃子隔炮架）',
  p: '兵/卒（过河前只进）',
};

const XIANGQI_DEFINITION: GameDefinition = {
  id: 'xiangqi',
  name: '中国象棋',
  pacing: 'turn-based',
  actionNames: ['move'],
  // 表演赛座位协议（ADR 0017/0018）：声明可建表演赛
  exhibitionEligible: true,
  // ADR 0018：v1 仅表演赛开放，常规入口（参赛对象/正式训练对局/排行榜）由平台层过滤
  exhibitionOnly: true,
};

// ---------------------------------------------------------------- 初始局面

/** 初始局面（标准象棋开局）。红方 side 0 在 y=7..9，黑方 side 1 在 y=0..2。 */
export function initialBoard(): MutableBoard {
  const board: MutableBoard = Array.from({ length: BOARD_HEIGHT }, () =>
    Array.from({ length: BOARD_WIDTH }, () => null),
  );
  const backRank: PieceKind[] = ['r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r'];
  for (let x = 0; x < 9; x++) {
    board[0]![x] = { side: 1, kind: backRank[x]! };
    board[9]![x] = { side: 0, kind: backRank[x]! };
  }
  board[2]![1] = { side: 1, kind: 'c' };
  board[2]![7] = { side: 1, kind: 'c' };
  board[7]![1] = { side: 0, kind: 'c' };
  board[7]![7] = { side: 0, kind: 'c' };
  for (let x = 0; x < 9; x += 2) {
    board[3]![x] = { side: 1, kind: 'p' };
    board[6]![x] = { side: 0, kind: 'p' };
  }
  return board;
}

// ---------------------------------------------------------------- 棋盘工具

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT;
}

/** 深拷贝棋盘（观察与观众帧给副本，防篡改内部状态）。 */
function cloneBoard(board: Board): MutableBoard {
  return board.map((row) => row.slice());
}

/** 找某方将的位置；找不到返回 null（不应发生，防御用）。 */
function findKing(board: Board, side: Side): [number, number] | null {
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const p = board[y]![x];
      if (p && p.kind === 'k' && p.side === side) return [x, y];
    }
  }
  return null;
}

/** (x,y) 是否在 side 的九宫内。红宫 x 3..5 y 7..9；黑宫 x 3..5 y 0..2。 */
function inPalace(x: number, y: number, side: Side): boolean {
  if (x < 3 || x > 5) return false;
  return side === 0 ? y >= 7 : y <= 2;
}

/** side 的「河」：红方半场 y >= 5，黑方半场 y <= 4。象不可过河。 */
function ownHalf(y: number, side: Side): boolean {
  return side === 0 ? y >= 5 : y <= 4;
}

/** 兵/卒是否已过河（进入对方半场）。 */
function pawnCrossed(y: number, side: Side): boolean {
  return side === 0 ? y <= 4 : y >= 5;
}

/**
 * side 的将是否被将军（被任一敌方棋子攻击）。
 * 实现：从将位出发反向探测攻击者（比枚举对方全部走法快）。
 */
/** 测试导出口：将军检测（兵将军回归测试用）。 */
export const isInCheckForTest = isInCheck;

function isInCheck(board: Board, side: Side): boolean {
  const king = findKing(board, side);
  if (!king) return false;
  const [kx, ky] = king;
  const enemy: Side = side === 0 ? 1 : 0;

  // 1) 车 / 将照面 / 兵（直线邻近）：沿四正方向找最近棋子
  const ORTHO: ReadonlyArray<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dy] of ORTHO) {
    let x = kx + dx;
    let y = ky + dy;
    let first = true;
    while (inBounds(x, y)) {
      const p = board[y]![x];
      if (p) {
        if (p.side === enemy) {
          if (p.kind === 'r') return true;
          // 将帅照面：对方将沿直线无遮挡「攻击」我方将（等价于照面判负）
          if (p.kind === 'k') return true;
          // 兵：在攻击范围内才能将军——
          //   正前方一格：敌兵前进方向指向我方将（黑卒向 y+，红兵向 y-）；
          //   过河兵可横走：敌兵与我将同行（dy === 0）且已过河。
          if (first && p.kind === 'p') {
            const forward = enemy === 0 ? -1 : 1; // 敌兵前进方向（y 增量）
            if (dy === -forward) return true; // 卒前进一步即到将（将在卒前进方向上）
            if (dy === 0) {
              // 敌兵与我将同行：过河兵可横吃将。黑卒过河 y>=5，红兵过河 y<=4。
              const crossed = enemy === 0 ? y <= 4 : y >= 5;
              if (crossed) return true;
            }
          }
        }
        break; // 任何棋子都挡住后续
      }
      first = false;
      x += dx;
      y += dy;
    }
  }

  // 2) 马（日字攻击，注意蹩腿点在马的位置上）：马从 (mx,my) 攻击 (kx,ky)
  //    需要马腿 (mx + sign(kx-mx 截断), my + sign(ky-my)) —— 具体：若 |dx|=2 则腿在
  //    (mx + dx/2, my)；若 |dy|=2 则腿在 (mx, my + dy/2)。
  const KNIGHT_ATTACKS: ReadonlyArray<{ dx: number; dy: number; legX: number; legY: number }> = [
    { dx: 2, dy: 1, legX: 1, legY: 0 },
    { dx: 2, dy: -1, legX: 1, legY: 0 },
    { dx: -2, dy: 1, legX: -1, legY: 0 },
    { dx: -2, dy: -1, legX: -1, legY: 0 },
    { dx: 1, dy: 2, legX: 0, legY: 1 },
    { dx: -1, dy: 2, legX: 0, legY: 1 },
    { dx: 1, dy: -2, legX: 0, legY: -1 },
    { dx: -1, dy: -2, legX: 0, legY: -1 },
  ];
  for (const { dx, dy, legX, legY } of KNIGHT_ATTACKS) {
    const mx = kx - dx;
    const my = ky - dy;
    if (!inBounds(mx, my)) continue;
    const p = board[my]![mx];
    if (!p || p.side !== enemy || p.kind !== 'n') continue;
    // 马腿相对马位
    if (board[my + legY]![mx + legX] === null) return true;
  }

  // 3) 炮：沿四正方向数过一个炮架后的第一个敌子若是炮 → 将军
  for (const [dx, dy] of ORTHO) {
    let x = kx + dx;
    let y = ky + dy;
    let screen = false;
    while (inBounds(x, y)) {
      const p = board[y]![x];
      if (p) {
        if (!screen) {
          screen = true; // 第一个子是炮架
        } else {
          if (p.side === enemy && p.kind === 'c') return true;
          break; // 第二个子之后不再相关
        }
      }
      x += dx;
      y += dy;
    }
  }

  // 4) 象不能攻击将（象不过河、将不出宫，物理上够不着，跳过）
  return false;
}

// ---------------------------------------------------------------- 走法生成与校验

/** 解析行动 { from: [x,y], to: [x,y] }；格式错返回 null。 */
function parseMove(action: unknown): { from: [number, number]; to: [number, number] } | null {
  if (typeof action !== 'object' || action === null) return null;
  const { from, to } = action as { from?: unknown; to?: unknown };
  if (!Array.isArray(from) || from.length !== 2) return null;
  if (!Array.isArray(to) || to.length !== 2) return null;
  for (const c of [...from, ...to]) {
    if (typeof c !== 'number' || !Number.isInteger(c)) return null;
  }
  return {
    from: [from[0] as number, from[1] as number],
    to: [to[0] as number, to[1] as number],
  };
}

/** 生成 piece 从 (x,y) 出发的伪合法目标格（不考虑将军/照面，考虑蹩腿/宫/河）。 */
function pseudoMoves(board: Board, x: number, y: number): Array<[number, number]> {
  const piece = board[y]![x]!;
  const { side, kind } = piece;
  const out: Array<[number, number]> = [];
  const push = (tx: number, ty: number): void => {
    if (!inBounds(tx, ty)) return;
    const target = board[ty]![tx];
    if (target && target.side === side) return; // 不能吃自己子
    out.push([tx, ty]);
  };

  switch (kind) {
    case 'r': {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        let tx = x + dx;
        let ty = y + dy;
        while (inBounds(tx, ty)) {
          const target = board[ty]![tx];
          if (target) {
            if (target.side !== side) out.push([tx, ty]);
            break;
          }
          out.push([tx, ty]);
          tx += dx;
          ty += dy;
        }
      }
      return out;
    }
    case 'n': {
      const MOVES: ReadonlyArray<{ dx: number; dy: number; lx: number; ly: number }> = [
        { dx: 2, dy: 1, lx: 1, ly: 0 },
        { dx: 2, dy: -1, lx: 1, ly: 0 },
        { dx: -2, dy: 1, lx: -1, ly: 0 },
        { dx: -2, dy: -1, lx: -1, ly: 0 },
        { dx: 1, dy: 2, lx: 0, ly: 1 },
        { dx: -1, dy: 2, lx: 0, ly: 1 },
        { dx: 1, dy: -2, lx: 0, ly: -1 },
        { dx: -1, dy: -2, lx: 0, ly: -1 },
      ];
      for (const { dx, dy, lx, ly } of MOVES) {
        const legX = x + lx;
        const legY = y + ly;
        if (!inBounds(legX, legY)) continue;
        if (board[legY]![legX] !== null) continue; // 蹩马腿
        push(x + dx, y + dy);
      }
      return out;
    }
    case 'b': {
      for (const [dx, dy] of [
        [2, 2],
        [2, -2],
        [-2, 2],
        [-2, -2],
      ] as const) {
        const eyeX = x + dx / 2;
        const eyeY = y + dy / 2;
        const tx = x + dx;
        const ty = y + dy;
        if (!inBounds(tx, ty)) continue;
        if (board[eyeY]![eyeX] !== null) continue; // 塞象眼
        if (!ownHalf(ty, side)) continue; // 不过河
        push(tx, ty);
      }
      return out;
    }
    case 'a': {
      for (const [dx, dy] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const tx = x + dx;
        const ty = y + dy;
        if (!inPalace(tx, ty, side)) continue;
        push(tx, ty);
      }
      return out;
    }
    case 'k': {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const tx = x + dx;
        const ty = y + dy;
        if (!inPalace(tx, ty, side)) continue;
        push(tx, ty);
      }
      return out;
    }
    case 'c': {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        let tx = x + dx;
        let ty = y + dy;
        let screen = false;
        while (inBounds(tx, ty)) {
          const target = board[ty]![tx];
          if (!screen) {
            if (target === null) {
              out.push([tx, ty]); // 平移
            } else {
              screen = true; // 第一个子是炮架
            }
          } else if (target) {
            if (target.side !== side) out.push([tx, ty]); // 隔架吃
            break;
          }
          tx += dx;
          ty += dy;
        }
      }
      return out;
    }
    case 'p': {
      const forward = side === 0 ? -1 : 1;
      push(x, y + forward); // 前
      if (pawnCrossed(y, side)) {
        push(x - 1, y); // 过河后可平移
        push(x + 1, y);
      }
      return out;
    }
  }
}

/**
 * 走法合法性判定（step 内与座位协议共用）：非法返回中文原因，合法返回 null。
 * 校验顺序：格式 → 越界 → 起点己方子 → 目标己方子（不能吃自己）→
 * 伪合法走法（走法形状）→ 吃将（终局）→ 走完自将被将军（含送将/不应将）。
 */
export function validateMove(action: unknown, observation: unknown): string | null {
  const move = parseMove(action);
  if (!move) return '走法格式错误：期望 { from: [x, y], to: [x, y] }';
  const { from, to } = move;
  const [fx, fy] = from;
  const [tx, ty] = to;
  if (!inBounds(fx, fy) || !inBounds(tx, ty)) {
    return `坐标越界：棋盘为 ${BOARD_WIDTH}x${BOARD_HEIGHT}（x 0..8，y 0..9）`;
  }
  const obs = observation as { board: Board; me: { side: Side } };
  const board = obs.board;
  const side = obs.me.side;
  const piece = board[fy]![fx];
  if (!piece) return `(${fx}, ${fy}) 上没有棋子`;
  if (piece.side !== side) {
    return `(${fx}, ${fy}) 是对方${PIECE_NAMES[piece.side][piece.kind]}，不能走对方的棋子`;
  }
  if (fx === tx && fy === ty) return '起点与终点相同';
  const targetPiece = board[ty]![tx];
  if (targetPiece && targetPiece.side === side) {
    return `(${tx}, ${ty}) 是己方${PIECE_NAMES[side][targetPiece.kind]}，不能吃自己的棋子`;
  }

  // 伪合法目标集合（含走法形状、蹩腿、宫、河、吃子规则）
  const targets = pseudoMoves(board, fx, fy);
  const isPseudo = targets.some(([mx, my]) => mx === tx && my === ty);
  if (!isPseudo) {
    const kindName = PIECE_FULL_NAMES[piece.kind];
    if (piece.kind === 'r') return `${PIECE_NAMES[side].r}走直线不能越子或目标不在直线上（${kindName}）`;
    if (piece.kind === 'n') return `${PIECE_NAMES[side].n}走日被蹩马腿或目标不合法（${kindName}）`;
    if (piece.kind === 'b') return `${PIECE_NAMES[side].b}走田被塞象眼/过河或目标不合法（${kindName}）`;
    if (piece.kind === 'c') {
      // 区分：平移被挡 / 吃子无炮架
      const dx = Math.sign(tx - fx);
      const dy = Math.sign(ty - fy);
      let screens = 0;
      let blocked = false;
      let x = fx + dx;
      let y = fy + dy;
      while (inBounds(x, y)) {
        if (x === tx && y === ty) break;
        if (board[y]![x]) screens += 1;
        x += dx;
        y += dy;
      }
      if (dx !== 0 && dy !== 0) return `炮走直线（${kindName}），不能斜走`;
      if (board[ty]![tx] === null && screens > 0) return '炮平移路径被挡（不能越子）';
      return '炮吃子必须恰好隔一个炮架';
    }
    if (piece.kind === 'p' && Math.abs(tx - fx) === 1 && ty === fy) {
      return `${PIECE_NAMES[side].p}未过河不能平移（${kindName}）`;
    }
    return `${PIECE_NAMES[side][piece.kind]}走法不合法（${kindName}）`;
  }

  // 模拟走子检查将军状态（含将帅照面——isInCheck 已含照面检测）
  const next = cloneBoard(board);
  next[ty]![tx] = piece;
  next[fy]![fx] = null;
  if (isInCheck(next, side)) {
    return `此走法后己方被将军（${PIECE_NAMES[side].k}不能送吃），请应将或换一步`;
  }
  return null;
}

/** side 在当前局面是否有任何合法走法（将死 / 困毙判定用）。 */
function hasAnyLegalMove(board: Board, side: Side): boolean {
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const p = board[y]![x];
      if (!p || p.side !== side) continue;
      for (const [tx, ty] of pseudoMoves(board, x, y)) {
        const next = cloneBoard(board);
        next[ty]![tx] = p;
        next[y]![x] = null;
        if (!isInCheck(next, side)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- 状态与观察

/** 观众帧中的完整局面（board[y][x]，明棋）。 */
export interface XiangqiGameState {
  board: Board;
  currentSide: Side;
  lastMove: { from: [number, number]; to: [number, number] } | null;
  /** 最近一次吃子的手数（判 60 回合和棋用）。 */
  lastCaptureMove: number;
  moveCount: number;
}

/** 当前行动方视角的观察数据。 */
export interface XiangqiObservation {
  me: { side: Side };
  /** 完整棋盘（象棋为明棋）。board[y][x]。 */
  board: Board;
  lastEnemyMove: { from: [number, number]; to: [number, number] } | null;
  moveCount: number;
  /** 己方是否被将军（轮到自己且被将军 = 必须应将）。 */
  inCheck: boolean;
}

/** 初始局面（导出给座位协议 / 测试使用）。 */
export { initialBoard as initialXiangqiBoard };

/**
 * 构造观察数据（座位协议与 step 共用）。
 * 独立于实例存在：给座位 observe 端点 / 初始局面测试使用。
 * @param side 观察方
 * @param moveCount 已走手数（决定轮次：偶数轮到红）
 * @param board 局面（缺省用初始局面）
 */
export function buildXiangqiObservation(
  side: Side,
  moveCount: number,
  board?: Board,
): XiangqiObservation {
  const b = board ?? initialBoard();
  const inCheck = isInCheck(b, side);
  return {
    me: { side },
    board: cloneBoard(b),
    lastEnemyMove: null,
    moveCount,
    inCheck,
  };
}

// ---------------------------------------------------------------- 错误工具（与 gomoku 同构）

function isStrategyErrorResult(value: unknown): value is { kind: 'error'; message?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'error'
  );
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

// ---------------------------------------------------------------- 游戏实例

export interface XiangqiInstanceOptions {
  /** 伪随机种子；象棋无随机要素，接受但忽略（保持契约签名一致）。 */
  seed?: number;
}

class XiangqiGameInstance implements GameInstance {
  readonly definition = XIANGQI_DEFINITION;

  private board: MutableBoard = initialBoard();
  private currentSide: Side = 0;
  private lastMove: { from: [number, number]; to: [number, number] } | null = null;
  private moveCount = 0;
  private lastCaptureMove = 0;
  private decisionPoints = 0;
  private readonly errorCounts: [number, number] = [0, 0];
  private readonly errorMessages: [string, string] = ['', ''];
  private outcome: MatchResult['outcome'] | null = null;

  constructor(
    private readonly entrants: readonly [EntrantHandle, EntrantHandle],
    _options?: XiangqiInstanceOptions,
  ) {}

  async step(): Promise<FrameSnapshot | null> {
    if (this.isOver()) return null;
    const side = this.currentSide;
    this.decisionPoints += 1;

    const observation = this.buildObservation(side);
    let settled: PromiseSettledResult<unknown>;
    try {
      settled = {
        status: 'fulfilled',
        value: unwrapEnvelope(await this.entrants[side].act(observation)),
      };
    } catch (err) {
      settled = { status: 'rejected', reason: err };
    }

    if (settled.status === 'rejected') {
      this.recordError(side, settled.reason);
    } else if (isStrategyErrorResult(settled.value)) {
      this.recordError(side, settled.value.message);
    } else {
      const illegal = validateMove(settled.value, observation);
      if (illegal !== null) {
        this.recordError(side, illegal);
      } else {
        const move = parseMove(settled.value)!;
        this.applyMove(move.from, move.to, side);
      }
    }

    return { tick: this.decisionPoints, state: this.snapshotState() };
  }

  isOver(): boolean {
    if (this.outcome !== null) return true;
    // 60 回合无吃子 → 和（回合 = 双方各一手；120 手）
    if (this.moveCount - this.lastCaptureMove >= DRAW_NO_CAPTURE_ROUNDS * 2) return true;
    return false;
  }

  result(): MatchResult | null {
    if (!this.isOver()) return null;
    if (this.outcome !== null) {
      const faulty = ([0, 1] as const).filter((s) => this.errorCounts[s] >= MAX_STRATEGY_ERRORS);
      return {
        outcome: this.outcome,
        failures: faulty.map((s) => ({ entrant: s, message: this.errorMessages[s] })),
      };
    }
    return {
      outcome: {
        kind: 'draw',
        reason: `连续 ${DRAW_NO_CAPTURE_ROUNDS} 回合无吃子，判和`,
      },
      failures: [],
    };
  }

  // ------------------------------------------------ 内部规则

  private applyMove(from: [number, number], to: [number, number], side: Side): void {
    const [fx, fy] = from;
    const [tx, ty] = to;
    const piece = this.board[fy]![fx]!;
    const captured = this.board[ty]![tx];
    this.board[ty]![tx] = piece;
    this.board[fy]![fx] = null;
    this.lastMove = { from: [fx, fy], to: [tx, ty] };
    this.moveCount += 1;
    if (captured !== null) this.lastCaptureMove = this.moveCount;

    // 吃将 → 立即终局（正常合法棋局不会走到，防御 + 直观）
    if (captured && captured.kind === 'k') {
      this.outcome = {
        kind: 'win',
        winner: side,
        reason: `${PIECE_NAMES[side][piece.kind]}吃掉对方${PIECE_NAMES[captured.side].k}，获胜`,
      };
      return;
    }

    // 对方无合法走法：被将军 = 将死；未被将军 = 困毙（中国规则均判负）
    const enemy: Side = side === 0 ? 1 : 0;
    if (!hasAnyLegalMove(this.board, enemy)) {
      const enemyInCheck = isInCheck(this.board, enemy);
      this.outcome = {
        kind: 'win',
        winner: side,
        reason: enemyInCheck
          ? `绝杀：${PIECE_NAMES[enemy].k}被将死`
          : `困毙：${PIECE_NAMES[enemy].k}无合法走法`,
      };
      return;
    }

    this.currentSide = enemy;
  }

  private recordError(side: Side, err: unknown): void {
    const message = errorText(err).slice(0, 200) || '未知策略错误';
    this.errorCounts[side] += 1;
    this.errorMessages[side] = message;
    if (this.errorCounts[side] >= MAX_STRATEGY_ERRORS) {
      this.outcome = {
        kind: 'win',
        winner: side === 0 ? 1 : 0,
        reason: `参赛方 ${side} 累计 ${MAX_STRATEGY_ERRORS} 次非法走法/策略错误，判负`,
      };
    }
  }

  private buildObservation(side: Side): XiangqiObservation {
    const inCheck = isInCheck(this.board, side);
    return {
      me: { side },
      board: cloneBoard(this.board),
      lastEnemyMove: this.lastMove ? { from: [...this.lastMove.from], to: [...this.lastMove.to] } : null,
      moveCount: this.moveCount,
      inCheck,
    };
  }

  private snapshotState(): XiangqiGameState {
    return {
      board: cloneBoard(this.board),
      currentSide: this.currentSide,
      lastMove: this.lastMove
        ? { from: [...this.lastMove.from], to: [...this.lastMove.to] }
        : null,
      lastCaptureMove: this.lastCaptureMove,
      moveCount: this.moveCount,
    };
  }
}

// ---------------------------------------------------------------- 包导出

/** 象棋游戏包：GamePackage 的扩展（seed 接受但忽略）。 */
export interface XiangqiGamePackage extends GamePackage {
  createInstance(
    entrants: [EntrantHandle, EntrantHandle],
    options?: XiangqiInstanceOptions,
  ): GameInstance;
}

export const xiangqiGamePackage: XiangqiGamePackage = {
  definition: XIANGQI_DEFINITION,
  createInstance(entrants, options): GameInstance {
    return new XiangqiGameInstance(entrants, options);
  },
  // 表演赛座位协议（ADR 0017/0018）：非法走法在提交入口同步返回 400 + 原因
  validateAction(action, observation) {
    return validateMove(action, observation);
  },
};
