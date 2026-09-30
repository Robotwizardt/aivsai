/**
 * 最小五子棋游戏包（1v1 回合制，ADR 0001：验证平台跨行动模型扩展）。
 *
 * 规则摘要：
 * - 15x15 明棋棋盘，side 0 执黑先行，双方轮流落一子；
 * - 每个决策点（step）只调用当前行动方的 entrant.act(observation)；
 *   返回行动 { place: [x, y] }（x 列、y 行，0..14）；
 * - 非法落子（格式错 / 越界 / 已占）该方错误计数 +1，累计 3 次判负
 *   （与坦克包一致：策略抛错或返回 { kind: 'error' } 同样计入）；
 * - 合法则落子、检查五连（横竖斜）、切换行动方；
 * - 任意一方率先连成恰好 ≥5 同色子者胜；225 手下满无胜 → draw；
 * - FrameSnapshot.tick 为决策点序号（第 1 次落子 = tick 1）；无非法行动的
 *   对局中即等于手数；state 含完整棋盘；
 * - observation（行动方视角）：{ me, board, lastEnemyMove, moveCount }，
 *   五子棋为明棋，board 即完整棋盘。
 *
 * 简化（"最小"边界）：无禁手（黑不禁三三/四四/长连）、无让先/交换规则、
 * 无时间限制；seed 参数被接受但无随机要素，忽略之。
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

// ---------------------------------------------------------------- 常量

const SIZE = 15;
const WIN_LENGTH = 5;
const MAX_MOVES = SIZE * SIZE; // 225
const MAX_STRATEGY_ERRORS = 3;

const SIDES = [0, 1] as const;
type Side = 0 | 1;
type Cell = 0 | 1 | null;
type Board = Cell[][];

/** 检查五连的四个轴向：横、竖、两条对角线。 */
const LINES: readonly { dx: number; dy: number }[] = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
];

const GOMOKU_DEFINITION: GameDefinition = {
  id: 'gomoku',
  name: '五子棋',
  pacing: 'turn-based',
  actionNames: ['place'],
};

// ---------------------------------------------------------------- 状态类型

/** 观众帧中的完整局面（明棋，不隐藏任何信息）。 */
export interface GomokuGameState {
  board: Board;
  currentSide: 0 | 1;
  lastMove: [number, number] | null;
}

/** 当前行动方视角的观察数据。 */
export interface GomokuObservation {
  /** 自己执子：0 = 黑（先手），1 = 白（后手）。 */
  me: { side: 0 | 1 };
  /** 完整棋盘（明棋）。board[y][x]：0/1 为双方落子，null 为空。 */
  board: Board;
  /** 对手上一手 [x, y]；开局首手前为 null。 */
  lastEnemyMove: [number, number] | null;
  /** 已落子手数（含本方即将落的这手之前的所有手）。 */
  moveCount: number;
}

export interface GomokuInstanceOptions {
  /** 伪随机种子；五子棋无随机要素，接受但忽略（保持契约签名一致）。 */
  seed?: number;
}

// ---------------------------------------------------------------- 行动解析

/** 解析行动 { place: [x, y] }；格式错返回 null。 */
function parsePlace(value: unknown): [number, number] | null {
  if (typeof value !== 'object' || value === null) return null;
  const place = (value as { place?: unknown }).place;
  if (!Array.isArray(place) || place.length !== 2) return null;
  const [x, y] = place;
  if (typeof x !== 'number' || !Number.isInteger(x)) return null;
  if (typeof y !== 'number' || !Number.isInteger(y)) return null;
  return [x, y];
}

/** act 返回值形如 StrategyStepResult 的 error 分支。 */
function isStrategyErrorResult(value: unknown): value is { kind: 'error'; message?: unknown } {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'error';
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

// ---------------------------------------------------------------- 棋盘工具

function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null as Cell));
}

/** 深拷贝棋盘（观察与观众帧都拿副本，防策略持有引用篡改内部状态）。 */
function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

/** 以 (x,y) 为端点检查 side 是否已在某轴向连成 ≥WIN_LENGTH。 */
function hasLineAt(board: Board, x: number, y: number, side: Side): boolean {
  for (const { dx, dy } of LINES) {
    let count = 1;
    for (let s = 1; s < WIN_LENGTH; s++) {
      const nx = x + dx * s;
      const ny = y + dy * s;
      if (!inBounds(nx, ny) || board[ny]![nx] !== side) break;
      count += 1;
    }
    for (let s = 1; s < WIN_LENGTH; s++) {
      const nx = x - dx * s;
      const ny = y - dy * s;
      if (!inBounds(nx, ny) || board[ny]![nx] !== side) break;
      count += 1;
    }
    if (count >= WIN_LENGTH) return true;
  }
  return false;
}

/** 构造当前行动方视角的观察数据（供 step 内部与测试使用）。 */
export function buildGomokuObservation(
  state: GomokuGameState,
  moveCount: number,
): GomokuObservation {
  return {
    me: { side: state.currentSide },
    board: cloneBoard(state.board),
    lastEnemyMove: state.lastMove === null ? null : [state.lastMove[0], state.lastMove[1]],
    moveCount,
  };
}

// ---------------------------------------------------------------- 游戏实例

class GomokuGameInstance implements GameInstance {
  readonly definition = GOMOKU_DEFINITION;

  private board: Board = emptyBoard();
  /** 当前行动方；side 0（黑）先行。 */
  private currentSide: Side = 0;
  private lastMove: [number, number] | null = null;
  /** 已落子手数。 */
  private moveCount = 0;
  /** 已消耗的决策点数（含非法行动）；帧号。 */
  private decisionPoints = 0;
  private readonly errorCounts: [number, number] = [0, 0];
  private readonly errorMessages: [string, string] = ['', ''];
  /** 已结束且产生胜负/平局结果时的记录；null 表示未结束。 */
  private outcome: MatchResult['outcome'] | null = null;

  constructor(
    private readonly entrants: readonly [EntrantHandle, EntrantHandle],
    _options?: GomokuInstanceOptions, // seed：五子棋无随机要素，忽略
  ) {}

  async step(): Promise<FrameSnapshot | null> {
    if (this.isOver()) return null;

    const side = this.currentSide;
    this.decisionPoints += 1;

    // 1) 只调用当前行动方（回合制决策点语义）
    const observation = buildGomokuObservation(this.snapshotState(), this.moveCount);
    let settled: PromiseSettledResult<unknown>;
    try {
      settled = { status: 'fulfilled', value: unwrapEnvelope(await this.entrants[side].act(observation)) };
    } catch (err) {
      settled = { status: 'rejected', reason: err };
    }

    // 2) 错误判定：抛错 / error 结果 / 非法落子 → 错误计数 +1，累计判负
    if (settled.status === 'rejected') {
      this.recordError(side, settled.reason);
    } else if (isStrategyErrorResult(settled.value)) {
      this.recordError(side, settled.value.message);
    } else {
      const place = parsePlace(settled.value);
      const illegal =
        place === null
          ? '行动格式错误：期望 { place: [x, y] }'
          : !inBounds(place[0], place[1])
            ? `落子越界：(${place[0]}, ${place[1]})`
            : this.board[place[1]]![place[0]] !== null
              ? `落子已被占用：(${place[0]}, ${place[1]})`
              : null;
      if (illegal !== null) {
        this.recordError(side, illegal);
      } else {
        this.applyMove(place![0], place![1], side);
      }
    }

    // 3) 该决策点的观众帧（tick = 决策点序号，单调递增；非法落子也占用决策点）
    return { tick: this.decisionPoints, state: this.snapshotState() };
  }

  isOver(): boolean {
    return this.outcome !== null || this.moveCount >= MAX_MOVES;
  }

  result(): MatchResult | null {
    if (!this.isOver()) return null;

    if (this.outcome !== null) {
      const faulty = SIDES.filter((s) => this.errorCounts[s] >= MAX_STRATEGY_ERRORS);
      return { outcome: this.outcome, failures: faulty.map((s) => ({ entrant: s, message: this.errorMessages[s] })) };
    }

    // 无胜负下满棋盘
    return { outcome: { kind: 'draw', reason: `${MAX_MOVES} 手下满棋盘，双方均未连成五子` }, failures: [] };
  }

  // ------------------------------------------------ 内部规则

  private applyMove(x: number, y: number, side: Side): void {
    this.board[y]![x] = side;
    this.moveCount += 1;
    this.lastMove = [x, y];
    if (hasLineAt(this.board, x, y, side)) {
      this.outcome = {
        kind: 'win',
        winner: side,
        reason: `参赛方 ${side} 在 (${x}, ${y}) 连成五子`,
      };
      return;
    }
    // 切换行动方（终局后 currentSide 不再被读取）
    this.currentSide = side === 0 ? 1 : 0;
  }

  private recordError(side: Side, err: unknown): void {
    const message = errorText(err).slice(0, 200) || '未知策略错误';
    this.errorCounts[side] += 1;
    this.errorMessages[side] = message;
    if (this.errorCounts[side] >= MAX_STRATEGY_ERRORS) {
      const loser = side;
      this.outcome = {
        kind: 'win',
        winner: loser === 0 ? 1 : 0,
        reason: `参赛方 ${loser} 策略累计 ${MAX_STRATEGY_ERRORS} 次执行错误，判负`,
      };
    }
  }

  private snapshotState(): GomokuGameState {
    return {
      board: cloneBoard(this.board),
      currentSide: this.currentSide,
      lastMove: this.lastMove === null ? null : [this.lastMove[0], this.lastMove[1]],
    };
  }
}

// ---------------------------------------------------------------- 包导出

/** 五子棋游戏包类型：GamePackage 的扩展（options.seed 接受但忽略）。 */
export interface GomokuGamePackage extends GamePackage {
  createInstance(
    entrants: [EntrantHandle, EntrantHandle],
    options?: GomokuInstanceOptions,
  ): GameInstance;
}

export const gomokuGamePackage: GomokuGamePackage = {
  definition: GOMOKU_DEFINITION,
  createInstance(entrants, options): GameInstance {
    return new GomokuGameInstance(entrants, options);
  },
};
