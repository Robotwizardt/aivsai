/** 黑白棋 v1（ADR 0019）：8×8、黑先手，仅开放表演赛。 */
import type {
  EntrantHandle, FrameSnapshot, GameDefinition, GameInstance, GamePackage, MatchResult,
} from '../contracts.js';
import { unwrapEnvelope } from '../../engine/sandbox-contracts.js';

type Side = 0 | 1;
type Point = [number, number];
type Board = (Side | null)[][];
const SIZE = 8;
const DEFINITION: GameDefinition = {
  id: 'reversi', name: '黑白棋', pacing: 'turn-based', actionNames: ['place'],
  exhibitionEligible: true, exhibitionOnly: true,
};

export interface ReversiGameState {
  /** board[y][x]；0 黑、1 白、null 空。 */
  board: Board;
  currentSide: Side;
  lastMove: Point | null;
  /** 只计合法落子；不含初始摆子、翻转、跳过或非法尝试。 */
  moveCount: number;
  counts: [number, number];
  lastFlipped: Point[];
  /** 最新合法落子之后被自动跳过的一方；非法尝试不改此字段。 */
  passedSide: Side | null;
}

export interface ReversiObservation extends ReversiGameState {
  me: { side: Side };
  /** 当前行动方的全部合法落点，按行、列排序。 */
  legalMoves: Point[];
}

function initialState(): ReversiGameState {
  const board: Board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  board[3]![3] = board[4]![4] = 1;
  board[3]![4] = board[4]![3] = 0;
  return { board, currentSide: 0, lastMove: null, moveCount: 0,
    counts: [2, 2], lastFlipped: [], passedSide: null };
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

function flipsAt(board: Board, side: Side, [x, y]: Point): Point[] {
  if (!inBounds(x, y) || board[y]![x] !== null) return [];
  const flipped: Point[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const ray: Point[] = [];
      let nx = x + dx;
      let ny = y + dy;
      while (inBounds(nx, ny) && board[ny]![nx] === 1 - side) {
        ray.push([nx, ny]);
        nx += dx;
        ny += dy;
      }
      if (inBounds(nx, ny) && board[ny]![nx] === side) flipped.push(...ray);
    }
  }
  return flipped;
}

function legalMoves(board: Board, side: Side): Point[] {
  const moves: Point[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (flipsAt(board, side, [x, y]).length > 0) moves.push([x, y]);
    }
  }
  return moves;
}

function parsePlace(action: unknown): Point | null {
  if (typeof action !== 'object' || action === null) return null;
  const place = (action as { place?: unknown }).place;
  if (!Array.isArray(place) || place.length !== 2
    || !Number.isInteger(place[0]) || !Number.isInteger(place[1])) return null;
  return [place[0], place[1]];
}

function errorMessage(error: unknown): string {
  // 不对外部行动中的对象做隐式转换，避免错误处理自身抛异常、绕过计错。
  const message: unknown = error instanceof Error ? error.message : error;
  return typeof message === 'string' ? message.slice(0, 200) || '未知策略错误' : '未知策略错误';
}

/** 预校验与执行唯一解释路径：解一层信封 → error → 坐标与规则校验。
 * 信封的 returned 优先于外层 place/kind；返回已解析坐标，执行端不再重解行动。
 */
function resolveAction(
  value: unknown,
  state: Pick<ReversiGameState, 'board' | 'currentSide'>,
): { place: Point; error: null } | { error: string } {
  const action = unwrapEnvelope(value);
  if (typeof action === 'object' && action !== null && 'kind' in action && action.kind === 'error') {
    return { error: errorMessage('message' in action ? action.message : '未知策略错误') };
  }
  const place = parsePlace(action);
  if (place === null) return { error: '行动格式错误：期望 { place: [x, y] }（整数坐标）' };
  const [x, y] = place;
  if (!inBounds(x, y)) return { error: `落子越界：(${x}, ${y})` };
  if (state.board[y]![x] !== null) return { error: `落子已被占用：(${x}, ${y})` };
  if (flipsAt(state.board, state.currentSide, place).length === 0) {
    return { error: `落子无法夹住并翻转对方棋子：(${x}, ${y})` };
  }
  return { place, error: null };
}

function snapshot(state: ReversiGameState): ReversiGameState {
  return {
    ...state,
    board: state.board.map((row) => row.slice()),
    lastMove: state.lastMove === null ? null : [...state.lastMove],
    counts: [...state.counts],
    lastFlipped: state.lastFlipped.map(([x, y]) => [x, y]),
  };
}

class ReversiGameInstance implements GameInstance {
  readonly definition = DEFINITION;
  private readonly state = initialState();
  private decisionPoints = 0;
  private readonly errorCounts: [number, number] = [0, 0];
  private matchResult: MatchResult | null = null;

  constructor(private readonly entrants: [EntrantHandle, EntrantHandle]) {}

  async step(): Promise<FrameSnapshot | null> {
    if (this.isOver()) return null;
    const side = this.state.currentSide;
    const observation: ReversiObservation = {
      ...snapshot(this.state), me: { side }, legalMoves: legalMoves(this.state.board, side),
    };
    let action: unknown;
    try {
      action = await this.entrants[side].act(observation);
    } catch (error) {
      this.recordError(side, error);
      return { tick: ++this.decisionPoints, state: snapshot(this.state) };
    }
    // 校验内部真值，不信任 entrant 可修改的 observation。
    const resolved = resolveAction(action, this.state);
    if (resolved.error !== null) {
      this.recordError(side, resolved.error);
      return { tick: ++this.decisionPoints, state: snapshot(this.state) };
    }
    const { place } = resolved;
    const flipped = flipsAt(this.state.board, side, place);
    this.state.board[place[1]]![place[0]] = side;
    for (const [x, y] of flipped) this.state.board[y]![x] = side;
    this.state.counts[side] += 1 + flipped.length;
    this.state.counts[side === 0 ? 1 : 0] -= flipped.length;
    this.state.lastMove = [...place];
    this.state.lastFlipped = flipped;
    this.state.moveCount++;
    const enemy = side === 0 ? 1 : 0;
    this.state.passedSide = null;
    this.state.currentSide = enemy;
    if (legalMoves(this.state.board, enemy).length === 0) {
      if (legalMoves(this.state.board, side).length > 0) {
        this.state.currentSide = side;
        this.state.passedSide = enemy;
      } else {
        const [black, white] = this.state.counts;
        const reason = `双方均无合法落点，黑 ${black} 子，白 ${white} 子`;
        this.matchResult = {
          outcome: black === white ? { kind: 'draw', reason }
            : { kind: 'win', winner: black > white ? 0 : 1, reason },
          failures: [],
        };
      }
    }
    return { tick: ++this.decisionPoints, state: snapshot(this.state) };
  }

  isOver(): boolean { return this.matchResult !== null; }
  result(): MatchResult | null { return this.matchResult; }

  private recordError(side: Side, error: unknown): void {
    const message = errorMessage(error);
    this.errorCounts[side]++;
    if (this.errorCounts[side] >= 3) {
      this.matchResult = {
        outcome: { kind: 'win', winner: side === 0 ? 1 : 0,
          reason: `参赛方 ${side} 策略累计 3 次执行错误，判负` },
        failures: [{ entrant: side, message }],
      };
    }
  }
}

/** seed 接受但忽略：规则没有随机要素。不支持任意局面注入。 */
export const reversiGamePackage: GamePackage = {
  definition: DEFINITION,
  createInstance: (entrants) => new ReversiGameInstance(entrants),
  validateAction: (action, observation) => resolveAction(action, observation as ReversiObservation).error,
};
