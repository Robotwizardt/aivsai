/** 棋类观战页的数据层与棋盘画布，不包含布局、回看控制或浏览器计时。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api';
import { gameName, gameSideLabel } from '../../game-labels';
import { renderXiangqiFrame, XIANGQI_CANVAS_SIZE, XIANGQI_SIDE_COLORS } from '../../xiangqi-renderer';
import { renderGomokuFrame, GOMOKU_CANVAS_SIZE } from '../../gomoku-renderer';
import { initialReversiState, renderReversiFrame, reversiCoordinate, REVERSI_CANVAS_SIZE } from '../../reversi-renderer';
import { isGomokuState, isReversiState, isXiangqiState } from '../../types';
import type { GomokuState, MatchResult, MatchSummary, ReversiState, XiangqiPiece, XiangqiState } from '../../types';

export type BoardGameId = 'xiangqi' | 'gomoku' | 'reversi';
export type BoardState = XiangqiState | GomokuState | ReversiState;

/** 一手已接受的行动；拒绝、超时产生的重复局面不计入棋谱。 */
export interface MoveRecord {
  no: number;
  side: 0 | 1;
  text: string;
  captured: XiangqiPiece | null;
  flipped?: number;
  passedSide?: 0 | 1 | null;
}

export interface BoardViewModel {
  gameId: BoardGameId;
  match: MatchSummary;
  /** 首个有效帧到达前为 null，由画布显示开局占位。 */
  latest: BoardState | null;
  /** 原样保留所有有效帧（含拒绝行动的同手数帧），供回放使用。 */
  states: readonly BoardState[];
  moves: MoveRecord[];
  /** 保留完整结果，包括 failures；流内非空终局优先于摘要。 */
  ended: MatchResult | null;
  names: readonly [string, string];
  colors: readonly [string, string];
  sideLabels: readonly [string, string];
  isLive: boolean;
  paused: boolean;
}

const PIECE_CHARS: Record<0 | 1, Record<XiangqiPiece['kind'], string>> = {
  0: { r: '車', n: '馬', b: '相', a: '仕', k: '帥', c: '炮', p: '兵' },
  1: { r: '車', n: '馬', b: '象', a: '士', k: '將', c: '砲', p: '卒' },
};
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function pieceChar(piece: XiangqiPiece): string {
  return PIECE_CHARS[piece.side][piece.kind];
}

/** 使用行动协议的零基 [列,行] 坐标，原点为棋盘左上角。 */
function xiangqiCoordinate([x, y]: [number, number]): string {
  return `[${x},${y}]`;
}

function xiangqiNotation(
  piece: XiangqiPiece,
  from: [number, number],
  to: [number, number],
  prev: XiangqiState | null,
): string {
  const file = (x: number) => (piece.side === 0 ? CN_NUM[8 - x] : String(x + 1));
  const [fx, fy] = from;
  const [tx, ty] = to;
  const name = pieceChar(piece);
  let text: string;
  if (fy === ty) {
    text = `${name}${file(fx)}平${file(tx)}`;
  } else {
    // 红方向上为进，黑方向下为进；斜走棋子用落点路数而非步数。
    const forward = piece.side === 0 ? ty < fy : ty > fy;
    const straight = piece.kind === 'r' || piece.kind === 'c' || piece.kind === 'p' || piece.kind === 'k';
    const steps = Math.abs(ty - fy);
    const tail = straight ? (piece.side === 0 ? CN_NUM[steps - 1] : String(steps)) : file(tx);
    text = `${name}${file(fx)}${forward ? '进' : '退'}${tail}`;
  }
  // 同一路的同方同种棋子可能超过两枚；用完整起止坐标消歧，不猜「前/后」。
  // 前帧缺失时也附坐标，避免将不确定的局面写成确定的传统记谱。
  const ambiguous = !prev || prev.board.filter((row) => {
    const other = row[fx];
    return other?.side === piece.side && other.kind === piece.kind;
  }).length > 1;
  return ambiguous ? `${text}（${xiangqiCoordinate(from)}→${xiangqiCoordinate(to)}）` : text;
}

/** 开局局面仅用于首帧前绘图，以及第一手吃子/记谱的前局面推导。 */
export function emptyState(gameId: BoardGameId): BoardState {
  if (gameId === 'reversi') return initialReversiState();
  if (gameId === 'gomoku') {
    return {
      board: Array.from({ length: 15 }, () => Array<null>(15).fill(null)),
      currentSide: 0,
      lastMove: null,
      moveCount: 0,
    };
  }
  const back: XiangqiPiece['kind'][] = ['r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r'];
  const board: (XiangqiPiece | null)[][] = Array.from({ length: 10 }, () => Array<XiangqiPiece | null>(9).fill(null));
  back.forEach((kind, x) => {
    board[0][x] = { side: 1, kind };
    board[9][x] = { side: 0, kind };
  });
  for (const x of [1, 7]) {
    board[2][x] = { side: 1, kind: 'c' };
    board[7][x] = { side: 0, kind: 'c' };
  }
  for (const x of [0, 2, 4, 6, 8]) {
    board[3][x] = { side: 1, kind: 'p' };
    board[6][x] = { side: 0, kind: 'p' };
  }
  return { board, currentSide: 0, lastMove: null, lastCaptureMove: 0, moveCount: 0 };
}

/** 从有效局面推导棋谱；缺帧时不臆造缺失着法或吃子。 */
export function deriveMoves(gameId: BoardGameId, states: readonly BoardState[]): MoveRecord[] {
  const moves: MoveRecord[] = [];
  let prev = emptyState(gameId);
  for (const state of states) {
    if (state.moveCount < prev.moveCount) continue;
    if (state.moveCount === prev.moveCount) {
      prev = state;
      continue;
    }
    const adjacent = state.moveCount === prev.moveCount + 1;
    if (gameId === 'xiangqi' && isXiangqiState(state) && state.lastMove) {
      const { from, to } = state.lastMove;
      const piece = state.board[to[1]]?.[to[0]];
      const before = adjacent && isXiangqiState(prev) ? prev : null;
      const target = before?.board[to[1]]?.[to[0]];
      if (piece) {
        moves.push({
          no: state.moveCount,
          side: piece.side,
          text: xiangqiNotation(piece, from, to, before),
          captured: target && target.side !== piece.side ? target : null,
        });
      }
    } else if (gameId === 'reversi' && isReversiState(state) && state.lastMove) {
      const [x, y] = state.lastMove;
      // 自动跳过可能让同方连续行动，不能用奇偶或 currentSide 的反方推导。
      const side = state.board[y][x];
      if (side === 0 || side === 1) moves.push({
        no: state.moveCount, side, text: reversiCoordinate(state.lastMove), captured: null,
        flipped: state.lastFlipped.length, passedSide: state.passedSide,
      });
    } else if (gameId === 'gomoku' && isGomokuState(state) && state.lastMove) {
      const [x, y] = state.lastMove;
      const side = state.board[y]?.[x];
      if (side === 0 || side === 1) {
        moves.push({ no: state.moveCount, side, text: `${'ABCDEFGHJKLMNOP'[x]}${15 - y}`, captured: null });
      }
    }
    prev = state;
  }
  return moves;
}

/** 按被吃的一方归类；显示「某方吃」时应取对方的数组。 */
export function capturedBySide(moves: readonly MoveRecord[]): [XiangqiPiece[], XiangqiPiece[]] {
  const lost: [XiangqiPiece[], XiangqiPiece[]] = [[], []];
  for (const move of moves) if (move.captured) lost[move.captured.side].push(move.captured);
  return lost;
}

function isCoordinate(value: unknown, width: number, height: number): value is [number, number] {
  return Array.isArray(value) && value.length === 2 &&
    Number.isInteger(value[0]) && value[0] >= 0 && value[0] < width &&
    Number.isInteger(value[1]) && value[1] >= 0 && value[1] < height;
}

/** 公共类型守卫只做粗校验；这里补齐画布与记谱实际访问的字段。 */
function isBoardState(value: unknown, gameId: BoardGameId): value is BoardState {
  if (gameId === 'reversi') return isReversiState(value);
  if (gameId === 'xiangqi') {
    if (!isXiangqiState(value) || !Number.isInteger(value.moveCount) || value.moveCount < 0) return false;
    if (!value.board.every((row) => Array.isArray(row) && row.length === 9 && row.every((piece: unknown) => {
      if (piece === null) return true;
      if (typeof piece !== 'object') return false;
      const p = piece as Partial<XiangqiPiece>;
      return (p.side === 0 || p.side === 1) && typeof p.kind === 'string' &&
        Object.prototype.hasOwnProperty.call(PIECE_CHARS[p.side], p.kind);
    }))) return false;
    return value.lastMove === null || (typeof value.lastMove === 'object' && value.lastMove !== null &&
      isCoordinate(value.lastMove.from, 9, 10) && isCoordinate(value.lastMove.to, 9, 10));
  }
  if (!isGomokuState(value) || !Number.isInteger(value.moveCount) || value.moveCount < 0) return false;
  return value.board.every((row) => Array.isArray(row) && row.length === 15 &&
    row.every((cell: unknown) => cell === null || cell === 0 || cell === 1)) &&
    (value.lastMove === null || isCoordinate(value.lastMove, 15, 15));
}

/**
 * 订阅单场对局。调用方必须以 matchId 为组件 key 隔离比赛，摘要更新不会重连。
 * 现有流接口没有连接状态回调，不能可靠暴露 connecting/open/error/closed。
 */
export function useBoardMatch(initialMatch: MatchSummary, gameId: BoardGameId): BoardViewModel {
  const [match, setMatch] = useState(initialMatch);
  const [paused, setPaused] = useState(false);
  const [snapshots, setSnapshots] = useState<Array<{ tick: number; state: BoardState }>>([]);
  const [streamResult, setStreamResult] = useState<MatchResult | null>(null);
  const [summaryResult, setSummaryResult] = useState<MatchResult | null>(match.result);

  useEffect(() => {
    // 摘要短暂回退到 null 时，不抹掉已经收到的有效结果。
    if (match.result) setSummaryResult(match.result);
  }, [match.result]);

  useEffect(() => {
    let disposed = false;
    const handle = api.openFramesStream(
      match.matchId,
      match.kind,
      (frame) => {
        if (disposed || !Number.isInteger(frame.tick) || frame.tick < 0 || !isBoardState(frame.state, gameId)) return;
        const state = frame.state;
        setSnapshots((prev) => {
          const last = prev[prev.length - 1];
          // 流按 tick 递增；重连回灌、重复帧及旧帧均不重复入列或倒退棋盘。
          if (last && (frame.tick <= last.tick || state.moveCount < last.state.moveCount)) return prev;
          return [...prev, { tick: frame.tick, state }];
        });
      },
      (result) => {
        // 不将 null end 伪装成「作废」，也不覆盖已有结果；完整保留 failures。
        if (!disposed && result) setStreamResult(result);
      },
    );
    return () => {
      disposed = true;
      handle.close();
      // 公开流的降级轮询由 API 内部持有，现有 close 无法中止它；回调守卫防止卸载后写状态。
    };
  }, [match.matchId, match.kind, gameId]);

  const states = useMemo(() => snapshots.map((snapshot) => snapshot.state), [snapshots]);
  const moves = useMemo(() => deriveMoves(gameId, states), [gameId, states]);
  const ended = streamResult ?? match.result ?? summaryResult;

  // 座位可在开局后命名，排队对局也会转入运行；摘要更新不能只依赖首屏请求。
  useEffect(() => {
    let disposed = false;
    // 各接口独立轮询，避免元数据故障拖住摘要；每次请求限时并在卸载时取消。
    const poll = <T,>(load: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let controller: AbortController | undefined;
      const refresh = async () => {
        controller = new AbortController();
        deadline = setTimeout(() => controller?.abort(), 5000);
        try {
          const value = await load(controller.signal);
          if (!disposed) apply(value);
        } catch {
          // 网络失败保留上次值，下一轮重试，不抹掉棋盘或身份。
        } finally {
          clearTimeout(deadline);
        }
        if (!disposed && !ended) timer = setTimeout(refresh, 3000);
      };
      void refresh();
      return () => { clearTimeout(timer); clearTimeout(deadline); controller?.abort(); };
    };
    // 终局也补拉一次：最后一手前的座位改名可能尚未被上一轮轮询捕获。
    const stopSummary = poll(signal => api.getMatch(initialMatch.matchId, signal), setMatch);
    // 暂停属于表演赛元数据，公共比赛 phase 在暂停时仍为 running。
    const stopExhibition = initialMatch.kind === 'exhibition'
      ? poll(signal => api.getExhibition(initialMatch.matchId, signal), ex => setPaused(ex.paused))
      : undefined;
    return () => { disposed = true; stopSummary(); stopExhibition?.(); };
  }, [initialMatch.matchId, initialMatch.kind, Boolean(ended)]);

  return useMemo(() => {
    const sideLabels = [gameSideLabel(gameId, 0), gameSideLabel(gameId, 1)] as const;
    const colors = gameId === 'xiangqi' ? XIANGQI_SIDE_COLORS : (['#1d1d1f', '#c7c7cc'] as const);
    const names = [
      match.entrants[0]?.name?.trim() || sideLabels[0],
      match.entrants[1]?.name?.trim() || sideLabels[1],
    ] as const;
    return {
      gameId,
      match,
      latest: states[states.length - 1] ?? null,
      states,
      moves,
      ended,
      names,
      colors,
      sideLabels,
      isLive: match.phase === 'running' && ended === null && !paused,
      paused,
    };
  }, [gameId, match, states, moves, ended, paused]);
}

export interface BoardCanvasProps {
  gameId: BoardGameId;
  state: BoardState | null;
  className?: string;
  legalMoves?: ReadonlyArray<readonly [number, number]>;
}

/** 首帧前显示开局占位；逻辑画布尺寸固定，由页面样式负责缩放。 */
export function BoardCanvas({ gameId, state, className, legalMoves }: BoardCanvasProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const displayState = useMemo(() => state ?? emptyState(gameId), [state, gameId]);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    if (isXiangqiState(displayState)) renderXiangqiFrame(ctx, displayState);
    else if (isGomokuState(displayState)) renderGomokuFrame(ctx, displayState);
    else if (isReversiState(displayState)) renderReversiFrame(ctx, displayState, legalMoves);
  }, [displayState, legalMoves]);
  const size = gameId === 'xiangqi' ? XIANGQI_CANVAS_SIZE : gameId === 'reversi' ? REVERSI_CANVAS_SIZE : GOMOKU_CANVAS_SIZE;
  const label = `${gameName(gameId)}棋盘${state ? '' : '（等待首帧，开局占位）'}`;
  return <canvas ref={ref} className={className} width={size.width} height={size.height} role="img" aria-label={label} />;
}
