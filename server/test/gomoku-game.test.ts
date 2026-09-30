/**
 * 最小五子棋游戏包测试（ADR 0001：验证新增回合制游戏不改平台核心）。
 *
 * 语义提示：非法落子/策略错误不切换行动方（当前行动方错误计数 +1），
 * 因此连续犯错的一方会被连续质询，累计 3 次即判负、对局结束。
 */

import { describe, expect, it } from 'vitest';
import type { EntrantHandle, GameInstance } from '../src/games/contracts.js';
import {
  buildGomokuObservation,
  gomokuGamePackage,
} from '../src/games/gomoku/gomoku-game.js';
import type { GomokuGameState, GomokuObservation } from '../src/games/gomoku/gomoku-game.js';

const SIZE = 15;

// ---------------------------------------------------------------- fakes

/** 脚本化假策略：按序返回行动列表，取尽后返回 null（非法，供"不抵抗"方使用）。 */
function scriptedEntrant(
  entrantId: string,
  actions: Array<Record<string, unknown>>,
): EntrantHandle & { calls: number; observations: unknown[] } {
  const handle = {
    entrantId,
    calls: 0,
    observations: [] as unknown[],
    act(observation: unknown): Promise<unknown> {
      handle.calls += 1;
      handle.observations.push(observation);
      return Promise.resolve(actions[handle.calls - 1] ?? null);
    },
  };
  return handle;
}

/** 依次按坐标序列落子的假策略（序列取尽后返回非法 null）。 */
function sequenceEntrant(entrantId: string, moves: Array<[number, number]>): EntrantHandle & { calls: number; observations: unknown[] } {
  let idx = 0;
  const handle = {
    entrantId,
    calls: 0,
    observations: [] as unknown[],
    act(observation: unknown): Promise<unknown> {
      handle.calls += 1;
      handle.observations.push(observation);
      return Promise.resolve(idx < moves.length ? { place: moves[idx++] } : null);
    },
  };
  return handle;
}

/** 每次都返回同一行动的假策略。 */
function fixedEntrant(entrantId: string, action: unknown): EntrantHandle {
  return { entrantId, act: () => Promise.resolve(action) };
}

function makeInstance(a: EntrantHandle, b: EntrantHandle, seed = 12345): GameInstance {
  return gomokuGamePackage.createInstance([a, b], { seed });
}

/** 跑到结束，返回全部帧与结果。 */
async function runToCompletion(game: GameInstance) {
  const frames = [];
  while (!game.isOver()) {
    const frame = await game.step();
    if (frame) frames.push(frame);
  }
  return { frames, result: game.result() };
}

function emptyBoard(): (0 | 1 | null)[][] {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
}

/** 落子序列生成器：按 (x,y) 顺序收集满足条件的格。 */
function cellsWhere(pred: (x: number, y: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (pred(x, y)) out.push([x, y]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- tests

describe('gomokuGamePackage', () => {
  it('definition 元信息正确', () => {
    expect(gomokuGamePackage.definition).toEqual({
      id: 'gomoku',
      name: '五子棋',
      pacing: 'turn-based',
      actionNames: ['place'],
    });
  });

  it('首手观察：空 15x15 棋盘、side 0 视角、无对方上一步', async () => {
    const a = scriptedEntrant('a', [{ place: [7, 7] }]);
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);

    await game.step();

    const obs = a.observations[0] as GomokuObservation;
    expect(obs.me).toEqual({ side: 0 });
    expect(obs.board).toEqual(emptyBoard());
    expect(obs.board).toHaveLength(15);
    expect(obs.board[0]).toHaveLength(15);
    expect(obs.lastEnemyMove).toBeNull();
    expect(obs.moveCount).toBe(0);
  });

  it('脚本化策略跑几步：先手中央横三、后手堵延长线，棋盘/行动方/观察正确', async () => {
    // side 0（黑）：(7,7) (8,7) (9,7)——中央横向三连
    // side 1（白）：(10,7) (11,7) (12,7)——堵住右端延长线
    const a = sequenceEntrant('a', [
      [7, 7],
      [8, 7],
      [9, 7],
    ]);
    const b = sequenceEntrant('b', [
      [10, 7],
      [11, 7],
      [12, 7],
    ]);
    const game = makeInstance(a, b);

    // 第 1 手：黑落 (7,7)，轮到白
    const frame1 = (await game.step())!;
    const state1 = frame1.state as GomokuGameState;
    expect(frame1.tick).toBe(1);
    expect(state1.board[7]![7]).toBe(0);
    expect(state1.currentSide).toBe(1);
    expect(state1.lastMove).toEqual([7, 7]);

    // 第 2 手：白落 (10,7)，轮到黑
    await game.step();

    // 第 3 手：黑落 (8,7)，轮到白
    const frame3 = (await game.step())!;
    const state3 = frame3.state as GomokuGameState;
    expect(frame3.tick).toBe(3);
    expect(state3.board[7]!.slice(7, 11)).toEqual([0, 0, null, 1]);
    expect(state3.currentSide).toBe(1); // 黑已落第 3 手 → 轮白
    expect(state3.lastMove).toEqual([8, 7]);
    expect(game.isOver()).toBe(false);

    // 回合制：每个决策点只调用当前行动方（3 步后黑 2 次、白 1 次）
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(1);

    // 跑完 6 手：黑 x7..x9 三连，白 x10..x12 三连堵住右侧
    await game.step();
    await game.step();
    const frame6 = (await game.step())!;
    const state6 = frame6.state as GomokuGameState;
    expect(frame6.tick).toBe(6);
    expect(state6.board[7]!.slice(7, 13)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(state6.lastMove).toEqual([12, 7]);
    expect(state6.currentSide).toBe(0);
    expect(game.isOver()).toBe(false);

    // 白方第 3 次决策的观察：明棋完整棋盘 + 黑的上一手
    const obsB = b.observations[2] as GomokuObservation;
    expect(obsB.me).toEqual({ side: 1 });
    expect(obsB.lastEnemyMove).toEqual([9, 7]);
    expect(obsB.moveCount).toBe(5);
    expect(obsB.board[7]!.slice(7, 13)).toEqual([0, 0, 0, 1, 1, null]);
  });

  it('观察给到的是棋盘副本，策略篡改观察不影响内部状态', async () => {
    const tamper: EntrantHandle = {
      entrantId: 'a',
      act(observation: unknown) {
        (observation as GomokuObservation).board[0]![0] = 1;
        return Promise.resolve({ place: [7, 7] });
      },
    };
    const b = scriptedEntrant('b', []);
    const game = makeInstance(tamper, b);
    const frame = (await game.step())!;
    expect((frame.state as GomokuGameState).board[0]![0]).toBeNull();
  });

  it('非法落子（越界）累计 3 次判负，对方 win，对方未被调用', async () => {
    const a = fixedEntrant('a', { place: [-1, 99] });
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);

    const { frames, result } = await runToCompletion(game);

    // 连续 3 个决策点都是黑方且全部非法，第 3 次判负
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.tick)).toEqual([1, 2, 3]);
    const finalState = frames[2]!.state as GomokuGameState;
    expect(finalState.board.every((row) => row.every((c) => c === null))).toBe(true);
    expect(result!.outcome).toEqual({
      kind: 'win',
      winner: 1,
      reason: expect.stringContaining('累计 3 次执行错误'),
    });
    expect(result!.failures).toEqual([
      { entrant: 0, message: expect.stringContaining('越界') },
    ]);
    // 黑方持续非法 → 白方从未行动
    expect(b.calls).toBe(0);
    expect(await game.step()).toBeNull();
  });

  it('非法落子（已占）累计 3 次判负', async () => {
    const a = scriptedEntrant('a', [{ place: [7, 7] }]);
    const b = fixedEntrant('b', { place: [7, 7] }); // 黑已落 (7,7)，之后全为已占
    const game = makeInstance(a, b);

    const { frames, result } = await runToCompletion(game);

    // 决策点：1 黑合法 (7,7)；2/3/4 白三次落已占格 → 判负
    expect(frames).toHaveLength(4);
    const finalState = frames[3]!.state as GomokuGameState;
    expect(finalState.board[7]![7]).toBe(0);
    expect(result!.outcome).toEqual({
      kind: 'win',
      winner: 0,
      reason: expect.stringContaining('累计 3 次执行错误'),
    });
    expect(result!.failures).toEqual([
      { entrant: 1, message: expect.stringContaining('已被占用') },
    ]);
  });

  it('行动格式错误同样计入错误计数', async () => {
    const a = fixedEntrant('a', { place: 'center' });
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);
    const { frames, result } = await runToCompletion(game);
    expect(result!.outcome).toEqual({
      kind: 'win',
      winner: 1,
      reason: expect.stringContaining('累计 3 次执行错误'),
    });
    expect(result!.failures[0]!.message).toContain('格式错误');
    expect(frames).toHaveLength(3);
  });

  it('act 抛错的策略累计 3 次判负，错误消息被记录', async () => {
    const a: EntrantHandle = {
      entrantId: 'a',
      act: () => Promise.reject(new Error('策略崩溃')),
    };
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);
    const { frames, result } = await runToCompletion(game);
    expect(result!.outcome).toEqual({
      kind: 'win',
      winner: 1,
      reason: expect.stringContaining('累计 3 次执行错误'),
    });
    expect(result!.failures).toEqual([{ entrant: 0, message: '策略崩溃' }]);
    expect(frames).toHaveLength(3);
  });

  it('先手横向连五 → win 且 winner 为 0', async () => {
    const a = sequenceEntrant('a', [
      [3, 3],
      [4, 3],
      [5, 3],
      [6, 3],
      [7, 3],
    ]);
    const b = sequenceEntrant('b', [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    const game = makeInstance(a, b);

    const { frames, result } = await runToCompletion(game);

    // 第 9 手（黑 5 + 白 4）黑连五，立即终局
    expect(frames).toHaveLength(9);
    const finalState = frames[8]!.state as GomokuGameState;
    expect(finalState.board[3]!.slice(3, 8)).toEqual([0, 0, 0, 0, 0]);
    expect(finalState.lastMove).toEqual([7, 3]);
    expect(result!.outcome).toEqual({
      kind: 'win',
      winner: 0,
      reason: expect.stringContaining('连成五子'),
    });
    expect(result!.failures).toEqual([]);
    expect(await game.step()).toBeNull();
  });

  it('竖向与斜向五连同样获胜（各方向检测）', async () => {
    // 竖向：黑沿 x=2 列连五，白在远处
    const game1 = makeInstance(
      sequenceEntrant('a', [
        [2, 2],
        [2, 3],
        [2, 4],
        [2, 5],
        [2, 6],
      ]),
      sequenceEntrant('b', [
        [12, 12],
        [12, 13],
        [12, 11],
        [12, 10],
      ]),
    );
    const r1 = (await runToCompletion(game1)).result!;
    expect(r1.outcome).toEqual({ kind: 'win', winner: 0, reason: expect.any(String) });

    // 斜向：黑沿主对角线连五
    const game2 = makeInstance(
      sequenceEntrant('a', [
        [5, 5],
        [6, 6],
        [7, 7],
        [8, 8],
        [9, 9],
      ]),
      sequenceEntrant('b', [
        [0, 14],
        [1, 14],
        [2, 14],
        [3, 14],
      ]),
    );
    const r2 = (await runToCompletion(game2)).result!;
    expect(r2.outcome).toEqual({ kind: 'win', winner: 0, reason: expect.any(String) });
  });

  it('后手连五：winner 为 1', async () => {
    // 黑的 5 手零散不连五（x=0..8 隔一列一子），白沿 x=10 列竖向连五
    const a = sequenceEntrant('a', [
      [0, 0],
      [2, 0],
      [4, 0],
      [6, 0],
      [8, 0],
    ]);
    const b = sequenceEntrant('b', [
      [10, 10],
      [10, 11],
      [10, 12],
      [10, 13],
      [10, 14],
    ]);
    const game = makeInstance(a, b);
    const { frames, result } = await runToCompletion(game);
    // 第 10 手（黑 5 + 白 5）白连五
    expect(frames).toHaveLength(10);
    expect(result!.outcome).toEqual({ kind: 'win', winner: 1, reason: expect.any(String) });
  });

  it('满盘无五连 → draw（周期染色铺满棋盘，任何方向同色连续 ≤2）', async () => {
    // 染色 f(x,y) = ((x + 2y) mod 4) < 2：横/斜同色至多连 2，竖向至多连 1，
    // 保证双方均无法连五；黑 113 格、白 112 格，恰好铺满 225 手。
    const blackCells = cellsWhere((x, y) => (x + 2 * y) % 4 < 2);
    const whiteCells = cellsWhere((x, y) => (x + 2 * y) % 4 >= 2);
    expect(blackCells).toHaveLength(113);
    expect(whiteCells).toHaveLength(112);

    const game = makeInstance(sequenceEntrant('a', blackCells), sequenceEntrant('b', whiteCells));
    const { frames, result } = await runToCompletion(game);

    expect(frames).toHaveLength(225);
    expect(frames.map((f) => f.tick)).toEqual(Array.from({ length: 225 }, (_, i) => i + 1));
    expect(result!.outcome).toEqual({
      kind: 'draw',
      reason: expect.stringContaining('下满棋盘'),
    });
    const finalState = frames[224]!.state as GomokuGameState;
    expect(finalState.board.every((row) => row.every((c) => c !== null))).toBe(true);
    expect(await game.step()).toBeNull();
  }, 10_000);

  it('buildGomokuObservation：明棋视角、enemy 一手可读、返回副本', () => {
    const state: GomokuGameState = {
      board: emptyBoard(),
      currentSide: 1,
      lastMove: [7, 7],
    };
    state.board[7]![7] = 0;
    const obs = buildGomokuObservation(state, 1) as GomokuObservation;
    expect(obs.me).toEqual({ side: 1 });
    expect(obs.board[7]![7]).toBe(0);
    expect(obs.lastEnemyMove).toEqual([7, 7]);
    expect(obs.moveCount).toBe(1);
    // 副本：改动观察棋盘不影响原 state
    obs.board[0]![0] = 1;
    expect(state.board[0]![0]).toBeNull();
  });
});
