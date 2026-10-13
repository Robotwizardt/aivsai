import { describe, expect, it } from 'vitest';
import type { EntrantHandle, GameInstance } from '../src/games/contracts.js';
import {
  reversiGamePackage,
  type ReversiGameState,
  type ReversiObservation,
} from '../src/games/reversi/reversi-game.js';

type Point = [number, number];
function entrant(side: 0 | 1, choose: (observation: ReversiObservation) => unknown): EntrantHandle {
  return { entrantId: String(side), act: async (observation) => choose(observation as ReversiObservation) };
}
function firstLegal(observation: ReversiObservation) {
  return { place: observation.legalMoves[0] };
}
function openingBoard(): ReversiGameState['board'] {
  const board: ReversiGameState['board'] = Array.from({ length: 8 }, () => Array(8).fill(null));
  board[3]![3] = board[4]![4] = 1;
  board[3]![4] = board[4]![3] = 0;
  return board;
}
async function stepState(game: GameInstance): Promise<ReversiGameState> {
  const frame = await game.step();
  expect(frame).not.toBeNull();
  return frame!.state as ReversiGameState;
}

// 独立 oracle：枚举友方端点，再检查端点之间是否全为敌子；不调用生产规则。
function oracleMoves(board: ReversiGameState['board'], side: 0 | 1) {
  const moves: { place: Point; flipped: Point[] }[] = [];
  for (let index = 0; index < 64; index++) {
    const x = index % 8;
    const y = Math.floor(index / 8);
    if (board[y]![x] !== null) continue;
    const flipped: Point[] = [];
    for (let end = 0; end < 64; end++) {
      const ex = end % 8;
      const ey = Math.floor(end / 8);
      if (board[ey]![ex] !== side) continue;
      const dx = ex - x;
      const dy = ey - y;
      const length = Math.max(Math.abs(dx), Math.abs(dy));
      if (length < 2 || (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy))) continue;
      const between: Point[] = Array.from({ length: length - 1 }, (_, i) =>
        [x + Math.sign(dx) * (i + 1), y + Math.sign(dy) * (i + 1)]);
      if (between.every(([bx, by]) => board[by]![bx] === 1 - side)) flipped.push(...between);
    }
    if (flipped.length) moves.push({ place: [x, y] as Point, flipped });
  }
  return moves;
}
function oracleApply(board: ReversiGameState['board'], side: 0 | 1, move: ReturnType<typeof oracleMoves>[number]) {
  for (const [x, y] of [move.place, ...move.flipped]) board[y]![x] = side;
}
function points(points: Point[]) { return points.map(([x, y]) => `${x},${y}`).sort(); }

describe('reversiGamePackage public contract', () => {
  it.each([
    { name: '外层合法、returned 不可翻转', action: { place: [3, 2], commands: [], returned: { place: [0, 0] } }, error: '翻转' },
    { name: '外层合法、returned 越界', action: { place: [3, 2], commands: [], returned: { place: [8, 0] } }, error: '越界' },
    { name: '外层合法、returned 已占', action: { place: [3, 2], commands: [], returned: { place: [3, 3] } }, error: '已被占用' },
    { name: '外层合法、returned null', action: { place: [3, 2], commands: [], returned: null }, error: '格式错误' },
    { name: '合法 place 不掩盖 error', action: { place: [3, 2], kind: 'error', message: '拒绝执行' }, error: '拒绝执行' },
    { name: 'returned error 不被内外 place 掩盖', action: { place: [3, 2], commands: [], returned: { place: [2, 3], kind: 'error', message: '信封执行错误' } }, error: '信封执行错误' },
    { name: 'error 缺少 message', action: { place: [3, 2], kind: 'error' }, error: '未知策略错误' },
    { name: 'error 空 message', action: { place: [3, 2], kind: 'error', message: '' }, error: '未知策略错误' },
    { name: 'error 非字符串 message', action: { place: [3, 2], kind: 'error', message: 42 }, error: '未知策略错误' },
    { name: 'error 不可字符串化 message', action: { kind: 'error', message: { toString: null } }, error: '未知策略错误' },
    { name: 'returned error 不可字符串化 message', action: { commands: [], returned: { kind: 'error', message: { toString: null } } }, error: '未知策略错误' },
    { name: '只解一层信封', action: { place: [3, 2], commands: [], returned: { commands: [], returned: { place: [2, 3] } } }, error: '格式错误' },
    { name: '纯合法信封', action: { commands: [], logs: [], returned: { place: [2, 3] } }, place: [2, 3] },
    { name: '外层非法以 returned 为准', action: { place: [0, 0], commands: [], returned: { place: [3, 2] } }, place: [3, 2] },
    { name: '外层与 returned 均合法仍选 returned', action: { place: [3, 2], commands: [], returned: { place: [2, 3] } }, place: [2, 3] },
    { name: '解信封后才检查 error', action: { kind: 'error', commands: [], returned: { place: [2, 3] } }, place: [2, 3] },
    { name: '缺少 returned 不是信封', action: { place: [3, 2], commands: [] }, place: [3, 2] },
    { name: 'commands 非数组不是信封', action: { place: [3, 2], commands: {}, returned: { place: [0, 0] } }, place: [3, 2] },
  ])('预校验与执行统一解释行动：$name', async ({ action, error, place }) => {
    let validation: string | null = null;
    const game = reversiGamePackage.createInstance([
      entrant(0, (obs) => {
        validation = reversiGamePackage.validateAction!(action, obs);
        return action;
      }), entrant(1, firstLegal),
    ]);
    const state = await stepState(game);
    if (error !== undefined) {
      expect(validation).toEqual(expect.stringContaining(error));
      expect(state).toMatchObject({ board: openingBoard(), moveCount: 0, currentSide: 0 });
      await game.step();
      await game.step();
      expect(game.result()!.failures).toEqual([{ entrant: 0, message: validation }]);
    } else {
      expect(validation).toBeNull();
      expect(state).toMatchObject({ moveCount: 1, currentSide: 1, lastMove: place, counts: [4, 1] });
      expect(state.board[place![1]!]![place![0]!]).toBe(0);
    }
  });

  it.each([
    { seed: 1, moves: 60, counts: [18, 46], winner: 1 },
    { seed: 5, moves: 60, counts: [37, 27], winner: 0 },
    { seed: 28, moves: 60, counts: [32, 32], winner: null },
    { seed: 71, moves: 59, counts: [15, 48], winner: 1 },
  ])('双方无合法落点直接终局：$seed，$moves 手，子数 $counts', async ({ seed, moves, counts, winner }) => {
    let random = seed;
    const board = openingBoard();
    let side: 0 | 1 = 0;
    let selected: Point = [3, 2];
    const observations: ReversiObservation[] = [];
    const choose = (obs: ReversiObservation) => { observations.push(obs); return { place: selected }; };
    const game = reversiGamePackage.createInstance([entrant(0, choose), entrant(1, choose)]);
    let last!: ReversiGameState;
    const capturedDirections = new Set<string>();
    let multiDirection = false;
    let corner = false;
    let edge = false;
    for (let moveCount = 1; moveCount <= moves; moveCount++) {
      const legal = oracleMoves(board, side);
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const move = legal[random % legal.length]!;
      selected = move.place;
      const directions = new Set(move.flipped.map(([x, y]) =>
        `${Math.sign(x - selected[0])},${Math.sign(y - selected[1])}`));
      for (const direction of directions) capturedDirections.add(direction);
      multiDirection ||= directions.size >= 3;
      const [x, y] = selected;
      corner ||= (x === 0 || x === 7) && (y === 0 || y === 7);
      edge ||= x === 0 || y === 0 || x === 7 || y === 7;
      expect(game.isOver()).toBe(false);
      last = await stepState(game);
      expect(observations.at(-1)!.legalMoves).toEqual(legal.map((move) => move.place));
      expect(observations.at(-1)!.me.side).toBe(side);
      oracleApply(board, side, move);
      expect(last.board).toEqual(board);
      expect(points(last.lastFlipped)).toEqual(points(move.flipped));
      expect(last.moveCount).toBe(moveCount);
      expect(last.counts).toEqual([board.flat().filter((cell) => cell === 0).length,
        board.flat().filter((cell) => cell === 1).length]);
      const enemy = side === 0 ? 1 : 0;
      if (oracleMoves(board, enemy).length) {
        side = enemy;
        expect(last.currentSide).toBe(side);
        expect(last.passedSide).toBeNull();
      } else if (!oracleMoves(board, side).length) {
        expect(moveCount).toBe(moves);
        expect(last.passedSide).toBeNull();
      }
    }
    expect(multiDirection).toBe(true);
    expect(capturedDirections.size).toBe(8);
    expect(corner).toBe(true);
    expect(edge).toBe(true);
    expect(oracleMoves(board, 0)).toEqual([]);
    expect(oracleMoves(board, 1)).toEqual([]);
    expect(last.counts).toEqual(counts);
    expect(board.flat().filter((cell) => cell === null)).toHaveLength(60 - moves);
    expect(game.isOver()).toBe(true);
    expect(game.result()).toEqual({
      outcome: winner === null ? { kind: 'draw', reason: expect.any(String) }
        : { kind: 'win', winner, reason: expect.any(String) },
      failures: [],
    });
    const observedCount = observations.length;
    expect(await game.step()).toBeNull();
    expect(observations).toHaveLength(observedCount);
  });
  it('观察、历史帧、嵌套坐标与行动数组互相隔离，篡改观察不能伪造合法落子', async () => {
    const retained: ReversiObservation[] = [];
    const action: Point = [3, 2];
    const game = reversiGamePackage.createInstance([
      entrant(0, (obs) => {
        retained.push(obs);
        if (obs.moveCount === 0) return { place: action };
        // 将不合法的角落伪造成可夹子，且伪造 me/currentSide/legalMoves。
        obs.board[0]![1] = 1;
        obs.board[0]![2] = 0;
        obs.me.side = 1;
        obs.currentSide = 1;
        obs.counts[0] = 999;
        obs.lastMove![0] = 99;
        obs.lastFlipped[0]![0] = 99;
        obs.legalMoves = [[0, 0]];
        obs.moveCount = 999;
        obs.passedSide = 1;
        return { place: [0, 0] };
      }),
      entrant(1, (obs) => { retained.push(obs); return { place: [2, 2] }; }),
    ]);
    const first = await stepState(game);
    const originalFirst = structuredClone(first);
    action[0] = 99;
    expect(first.lastMove).toEqual([3, 2]);
    const second = await stepState(game);
    const originalSecond = structuredClone(second);
    expect(first).toEqual(originalFirst); // 后续落子不改历史帧。
    expect(retained[0]!.board).toEqual(openingBoard());
    first.board[3]![3] = null;
    first.lastMove![0] = 99;
    first.lastFlipped[0]![0] = 99;
    first.counts[0] = 999;
    expect(retained[1]).toMatchObject(originalFirst); // 帧与下一手观察无别名。
    retained[0]!.board[0]![0] = 0;
    retained[0]!.legalMoves[0]![0] = 99;
    second.board[0]![0] = 1;
    second.lastMove![0] = 99;
    second.lastFlipped[0]![0] = 99;
    second.counts[1] = 999;
    expect(await stepState(game)).toEqual(originalSecond); // 以内部局面拒绝伪造落子。
    expect(game.isOver()).toBe(false);
  });

  it.each([
    [null, '格式错误'], [{ place: [8, 0] }, '越界'],
    [{ place: [3, 3] }, '已被占用'], [{ place: [0, 0] }, '翻转'],
    [{ kind: 'error', message: '显式故障' }, '显式故障'],
  ])('引擎独立拒绝 %j 并保留具体失败原因', async (action, message) => {
    const game = reversiGamePackage.createInstance([entrant(0, () => action), entrant(1, firstLegal)]);
    for (let i = 0; i < 3; i++) {
      expect(await stepState(game)).toMatchObject({ board: openingBoard(), moveCount: 0, currentSide: 0 });
    }
    expect(game.result()!.failures).toEqual([{ entrant: 0, message: expect.stringContaining(message as string) }]);
  });

  it('抛错和 error 结果与非法行动累计，支持现有 action envelope', async () => {
    let attempt = 0;
    const game = reversiGamePackage.createInstance([
      entrant(0, (obs) => {
        attempt++;
        if (attempt === 1) throw new Error('策略崩溃');
        if (attempt === 2) return { commands: [], logs: [], returned: firstLegal(obs) };
        if (attempt === 3) return { kind: 'error', message: '执行失败' };
        throw '最终错误';
      }), entrant(1, firstLegal),
    ]);
    expect((await stepState(game)).moveCount).toBe(0);
    expect((await stepState(game)).moveCount).toBe(1);
    expect((await stepState(game)).moveCount).toBe(2);
    const retry = await stepState(game);
    expect(retry.moveCount).toBe(2);
    expect(await stepState(game)).toEqual(retry);
    expect(game.result()).toEqual({
      outcome: { kind: 'win', winner: 1, reason: expect.stringContaining('累计 3 次执行错误') },
      failures: [{ entrant: 0, message: '最终错误' }],
    });
  });

  it('无合法落点自动 pass，同方连续行动；pass 不增手数且非法重试保留 passedSide', async () => {
    let retry = false;
    const observed: ReversiObservation[] = [];
    const choose = (obs: ReversiObservation) => {
      observed.push(obs);
      return retry ? { pass: true } : firstLegal(obs);
    };
    const game = reversiGamePackage.createInstance([entrant(0, choose), entrant(1, choose)]);
    const board = openingBoard();
    let side: 0 | 1 = 0;
    for (let moveCount = 1; moveCount <= 60; moveCount++) {
      const move = oracleMoves(board, side)[0]!;
      oracleApply(board, side, move);
      const enemy = side === 0 ? 1 : 0;
      const isPass = oracleMoves(board, enemy).length === 0 && oracleMoves(board, side).length > 0;
      const state = await stepState(game);
      expect(state.board).toEqual(board);
      expect(state.moveCount).toBe(moveCount);
      if (isPass) {
        expect(state).toMatchObject({ currentSide: side, passedSide: enemy });
        retry = true;
        expect(await stepState(game)).toEqual(state);
        retry = false;
        const next = await stepState(game);
        expect(observed.at(-1)).toMatchObject({ me: { side }, currentSide: side, moveCount });
        expect(next.moveCount).toBe(moveCount + 1);
        expect(next.lastMove).toEqual(oracleMoves(board, side)[0]!.place);
        oracleApply(board, side, oracleMoves(board, side)[0]!);
        expect(next.passedSide).toBe(oracleMoves(board, enemy).length === 0 ? enemy : null);
        // 这个合法序列会连续跳过黑方；继续直到黑方重新获得合法落点。
        for (let extra = 0; extra < 60; extra++) {
          const later = await stepState(game);
          if (later.passedSide === null) {
            expect(later.currentSide).toBe(enemy);
            return;
          }
        }
        throw new Error('fixture 未恢复对方行动');
      }
      side = enemy;
    }
    throw new Error('fixture 未遇到自动 pass');
  });
  it('三次错误跨合法手累计、双方独立；非法尝试不改局面但递增 tick', async () => {
    let blackAttempts = 0;
    let whiteAttempts = 0;
    const game = reversiGamePackage.createInstance([
      entrant(0, (obs) => ++blackAttempts % 2 ? { place: [0, 0] } : firstLegal(obs)),
      entrant(1, (obs) => ++whiteAttempts === 1 ? { place: [-1, 0] } : firstLegal(obs)),
    ]);
    const states: ReversiGameState[] = [];
    for (let tick = 1; tick <= 8; tick++) {
      expect(game.isOver()).toBe(false);
      const frame = (await game.step())!;
      expect(frame.tick).toBe(tick);
      states.push(frame.state as ReversiGameState);
    }
    expect(states.map((state) => state.moveCount)).toEqual([0, 1, 1, 2, 2, 3, 4, 4]);
    expect(states[2]).toEqual(states[1]);
    expect(states[4]).toEqual(states[3]);
    expect(states[7]).toEqual(states[6]);
    expect(game.isOver()).toBe(true);
    expect(game.result()).toEqual({
      outcome: { kind: 'win', winner: 1, reason: expect.stringContaining('累计 3 次执行错误') },
      failures: [{ entrant: 0, message: expect.stringContaining('翻转') }],
    });
    expect(await game.step()).toBeNull();
  });

  it('预校验独立检查格式、边界、占用和夹子，不信任 legalMoves', async () => {
    let observation!: ReversiObservation;
    const game = reversiGamePackage.createInstance([
      entrant(0, (obs) => { observation = obs; return firstLegal(obs); }), entrant(1, firstLegal),
    ]);
    await game.step();
    const validate = reversiGamePackage.validateAction!;
    for (const action of [null, {}, { pass: true }, { place: [3] }, { place: [3, 2, 0] },
      { place: ['3', 2] }, { place: [3.5, 2] }, { place: [NaN, 2] }, { place: [Infinity, 2] }, { place: Array(2) }]) {
      expect(validate(action, observation)).toContain('格式错误');
    }
    for (const place of [[-1, 2], [8, 2], [3, -1], [3, 8]]) {
      expect(validate({ place }, observation)).toContain('越界');
    }
    expect(validate({ place: [3, 3] }, observation)).toContain('已被占用');
    observation.legalMoves = [[0, 0]];
    expect(validate({ place: [0, 0] }, observation)).toContain('翻转');
    expect(validate({ place: [3, 2] }, observation)).toBeNull();
  });
  it('仅表演赛：标准中央四子、黑先手、完整观察与合法落子翻转帧', async () => {
    expect(reversiGamePackage.definition).toEqual({
      id: 'reversi', name: '黑白棋', pacing: 'turn-based', actionNames: ['place'],
      exhibitionEligible: true, exhibitionOnly: true,
    });
    const observations: ReversiObservation[] = [];
    const game = reversiGamePackage.createInstance([
      entrant(0, (obs) => { observations.push(obs); return { place: [3, 2] }; }),
      entrant(1, (obs) => { observations.push(obs); return { place: [2, 2] }; }),
    ], { seed: 42 });
    expect(game.isOver()).toBe(false);
    expect(game.result()).toBeNull();
    const frame = (await game.step())!;
    expect(observations[0]).toEqual({
      board: openingBoard(), currentSide: 0, lastMove: null, moveCount: 0,
      counts: [2, 2], lastFlipped: [], passedSide: null, me: { side: 0 },
      legalMoves: [[3, 2], [2, 3], [5, 4], [4, 5]],
    });
    const board = openingBoard();
    board[2]![3] = board[3]![3] = 0;
    expect(frame).toEqual({ tick: 1, state: {
      board, currentSide: 1, lastMove: [3, 2], moveCount: 1,
      counts: [4, 1], lastFlipped: [[3, 3]], passedSide: null,
    } });
    const state = await stepState(game);
    expect(observations[1]).toEqual({
      ...(frame.state as ReversiGameState), me: { side: 1 }, legalMoves: [[2, 2], [4, 2], [2, 4]],
    });
    expect(state).toMatchObject({ currentSide: 0, moveCount: 2, counts: [3, 3], lastFlipped: [[3, 3]] });
    expect(state.board[2]![2]).toBe(1);
  });
});
