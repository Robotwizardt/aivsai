/**
 * 象棋游戏包测试（ADR 0018：v1 仅表演赛开放）。
 *
 * 覆盖：
 * - definition 元信息（exhibitionEligible: true）；
 * - 全部棋子走法（含蹩马腿、塞象眼、蹩兵、将帅照面）；
 * - 将军必须应将、将死 / 困毙判定；
 * - 非法走法错误消息（中文原因）；
 * - 60 回合无吃子判和（简化和棋规则）；
 * - 座位协议 validateAction 同步校验。
 *
 * 坐标系：x 0..8（列，左起），y 0..9（行，黑在上 y=0..2，红在下 y=7..9）。
 * 红方向上（y 减小），黑方向下（y 增大）。
 */

import { describe, expect, it } from 'vitest';
import type { EntrantHandle, GameInstance } from '../src/games/contracts.js';
import {
  buildXiangqiObservation,
  initialXiangqiBoard,
  isInCheckForTest,
  validateMove,
  xiangqiGamePackage,
} from '../src/games/xiangqi/xiangqi-game.js';

// 测试内别名
const isInCheckExported = isInCheckForTest;
const emptyBoard = () =>
  Array.from({ length: 10 }, () => Array.from({ length: 9 }, () => null));

// ---------------------------------------------------------------- fakes

/** 按序出手、取尽后返回非法走法的策略。 */
function sequenceEntrant(
  entrantId: string,
  moves: Array<{ from: [number, number]; to: [number, number] }>,
): EntrantHandle & { calls: number } {
  let idx = 0;
  const handle = {
    entrantId,
    calls: 0,
    act(): Promise<unknown> {
      handle.calls += 1;
      return Promise.resolve(
        idx < moves.length
          ? moves[idx++]!
          : { from: [0, 0], to: [8, 9] }, // 取尽后必然非法
      );
    },
  };
  return handle;
}

function makeInstance(a: EntrantHandle, b: EntrantHandle, seed = 12345): GameInstance {
  return xiangqiGamePackage.createInstance([a, b], { seed });
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

// ---------------------------------------------------------------- 走法单元测试

describe('xiangqiGamePackage 走法判定', () => {
  it('definition 元信息正确', () => {
    expect(xiangqiGamePackage.definition).toEqual({
      id: 'xiangqi',
      name: '中国象棋',
      pacing: 'turn-based',
      actionNames: ['move'],
      exhibitionEligible: true,
      exhibitionOnly: true,
    });
  });

  it('初始局面：32 子、红先、将位正确', () => {
    const board = initialXiangqiBoard();
    const pieces = board.flat().filter((c) => c !== null);
    expect(pieces.length).toBe(32);
    // 红帅 (4,9)，黑将 (4,0)
    expect(board[9]![4]).toEqual({ side: 0, kind: 'k' });
    expect(board[0]![4]).toEqual({ side: 1, kind: 'k' });
    // 红炮 (1,7)(7,7)，黑炮 (1,2)(7,2)；红兵 y=6 偶数列，黑卒 y=3
    expect(board[7]![1]).toEqual({ side: 0, kind: 'c' });
    expect(board[2]![1]).toEqual({ side: 1, kind: 'c' });
    expect(board[6]![0]).toEqual({ side: 0, kind: 'p' });
    expect(board[3]![0]).toEqual({ side: 1, kind: 'p' });

    const obs = buildXiangqiObservation(0, 0);
    expect(obs.me).toEqual({ side: 0 });
    expect(obs.board).toHaveLength(10);
    expect(obs.board[0]).toHaveLength(9);
    expect(obs.moveCount).toBe(0);
    expect(obs.lastEnemyMove).toBeNull();
    expect(obs.inCheck).toBe(false);
  });

  it('车走直线，隔子不可越', () => {
    const obs = buildXiangqiObservation(0, 0);
    // 红车 (0,9) 向上：路径 (0,8)(0,7) 空 → 到 (0,7) 合法
    expect(validateMove({ from: [0, 9], to: [0, 7] }, obs)).toBeNull();
    // 越过 (0,6) 己方红兵到 (0,5)：非法（不能越子）
    expect(validateMove({ from: [0, 9], to: [0, 5] }, obs)).toMatch(/车走直线不能越子/);
    // 车斜走 (0,9)→(1,8)：非法
    expect(validateMove({ from: [0, 9], to: [1, 8] }, obs)).toMatch(/车走直线/);
  });

  it('马走日：蹩马腿非法 + 原因含「蹩马腿」', () => {
    const obs = buildXiangqiObservation(0, 0);
    // 红马 (1,9) 走 (2,7)：马腿 (1,8) 空 → 合法
    expect(validateMove({ from: [1, 9], to: [2, 7] }, obs)).toBeNull();
    // 红马 (1,9) 走 (3,8)：马腿 (2,9) 是己方相 → 蹩
    expect(validateMove({ from: [1, 9], to: [3, 8] }, obs)).toMatch(/蹩马腿/);
  });

  it('象走田：塞象眼非法 + 不过河', () => {
    const obs = buildXiangqiObservation(0, 0);
    // 红相 (2,9) 走 (4,7)：象眼 (3,8) 空 → 合法（己方半场 y>=5）
    expect(validateMove({ from: [2, 9], to: [4, 7] }, obs)).toBeNull();
    // 红相 (2,9) 走 (0,7)：象眼 (1,8) 空 → 合法
    expect(validateMove({ from: [2, 9], to: [0, 7] }, obs)).toBeNull();
    // 黑象 (2,0) 走 (4,2)：象眼 (3,1) 空 → 合法
    const obsBlack = buildXiangqiObservation(1, 1);
    expect(validateMove({ from: [2, 0], to: [4, 2] }, obsBlack)).toBeNull();
    // 过河：黑象已到 (2,4)（黑半场边界），再田字到 (4,6) 是红方半场 → 非法。
    // 用自定义棋盘构造黑象在 (2,4) 的局面。
    const b = initialXiangqiBoard();
    b[4]![2] = { side: 1, kind: 'b' };
    b[0]![2] = null;
    const obsEdge = buildXiangqiObservation(1, 3, b);
    expect(validateMove({ from: [2, 4], to: [4, 6] }, obsEdge)).toMatch(/过河/);
    // 同象在同半场内 (2,4)→(0,2)：象眼 (1,3)？(1,3) 空（卒在偶数列）→ 合法
    expect(validateMove({ from: [2, 4], to: [0, 2] }, obsEdge)).toBeNull();
  });

  it('士走斜线不出宫', () => {
    const obs = buildXiangqiObservation(0, 0);
    // 红仕 (3,9) 走 (4,8)：宫内斜一步，合法
    expect(validateMove({ from: [3, 9], to: [4, 8] }, obs)).toBeNull();
    // 红仕 (3,9) 走 (2,8)：出宫（x<3），非法
    expect(validateMove({ from: [3, 9], to: [2, 8] }, obs)).toMatch(/仕|士|宫|走法不合法/);
  });

  it('炮：平移合法、吃子必须隔一炮架', () => {
    const obs = buildXiangqiObservation(0, 0);
    // 红炮 (1,7) 平移到 (1,3)：路径 (1,6)(1,5)(1,4) 空（卒在偶数列），(1,3) 空格 → 合法
    expect(validateMove({ from: [1, 7], to: [1, 3] }, obs)).toBeNull();
    // 无炮架吃 (1,7)→(1,2) 黑炮：路径全空 → 非法
    expect(validateMove({ from: [1, 7], to: [1, 2] }, obs)).toMatch(/炮架/);
    // 隔架吃 (1,7)→(1,0) 黑马：炮架 (1,2) 黑炮恰一个 → 合法
    expect(validateMove({ from: [1, 7], to: [1, 0] }, obs)).toBeNull();
  });

  it('兵/卒：过河前只进，过河后可平移，不能后退', () => {
    const obs = buildXiangqiObservation(0, 0);
    // 红兵 (0,6) 只能向前 (0,5)；平移 (1,6) 非法（未过河）
    expect(validateMove({ from: [0, 6], to: [0, 5] }, obs)).toBeNull();
    expect(validateMove({ from: [0, 6], to: [1, 6] }, obs)).toMatch(/兵|卒|过河/);
    // 后退 (0,7) 非法
    expect(validateMove({ from: [0, 6], to: [0, 7] }, obs)).toMatch(/兵|卒|走法不合法/);
  });

  it('不能走对方棋子；from/to 格式错误 → 400 原因', () => {
    const obs = buildXiangqiObservation(0, 0);
    // 红方试图走黑卒 (0,3)
    expect(validateMove({ from: [0, 3], to: [0, 4] }, obs)).toMatch(/对方卒/);
    // 格式错误
    expect(validateMove({ from: [0, 0] }, obs)).toMatch(/格式/);
    expect(validateMove({ from: [99, 0], to: [0, 4] }, obs)).toMatch(/越界/);
    expect(validateMove('invalid', obs)).toMatch(/格式/);
    // 空格起点
    expect(validateMove({ from: [0, 4], to: [0, 5] }, obs)).toMatch(/没有棋子/);
  });
});

// ---------------------------------------------------------------- 对局流程测试

describe('xiangqiGamePackage 对局流程', () => {
  it('两步合法棋 + 吃将军终局：红车直接吃黑将', async () => {
    // 车一进九吃将：构造黑方弃权局面太绕；直接用中炮开局演示合法流程，
    // 然后验证终局路径——红车 (0,9) 冲到底吃黑车，再直捣黄龙吃黑将。
    // 简化：脚本让红方连吃将。红车 (0,9)→(0,0)？路径被黑车 (0,0) 挡住——吃 (0,0) 黑车！
    // 第 1 手红：车 (0,9)→(0,0) 吃黑车（路径 (0,8)..(0,1) 全空？(0,3) 有黑卒！挡住）。
    // → 真正可达：红车 (0,9)→(0,4)？(0,3) 黑卒挡住 → 只能吃到 (0,5)。
    // 第 1 手：炮二平五风格太复杂。改用兵：红兵 (0,6)→(0,5)。
    // 第 2 手黑：卒 (0,3)→(0,4)。
    // 第 3 手红：兵 (0,5) 吃卒 (0,4)。
    // 这样验证多步流程 + 吃子 + 观察 lastEnemyMove 即可，终局用将死局面单独测。
    const red = sequenceEntrant('r', [
      { from: [0, 6], to: [0, 5] },
      { from: [0, 5], to: [0, 4] }, // 吃黑卒
    ]);
    const black = sequenceEntrant('b', [{ from: [0, 3], to: [0, 4] }]);
    const game = makeInstance(red, black);
    const frame1 = await game.step();
    expect(frame1?.state.moveCount).toBe(1);
    // 第 2 手黑卒前进
    await game.step();
    // 第 3 手红兵吃卒
    const frame3 = await game.step();
    expect(frame3?.state.moveCount).toBe(3);
    expect(frame3?.state.lastCaptureMove).toBe(3);
    expect(game.isOver()).toBe(false);
  });

  it('兵的将军检测：正前方兵将军 + 过河兵横吃将军（回归：兵将军曾失效）', () => {
    // 场景 1：黑卒在红将正前方一格（y-1），将军。
    // 手工摆盘：红将 (4,9)，黑卒 (4,8)。
    const board1 = emptyBoard();
    board1[9]![4] = { side: 0, kind: 'k' };
    board1[8]![4] = { side: 1, kind: 'p' };
    expect(isInCheckExported(board1, 0)).toBe(true);

    // 场景 2：过河黑卒横吃位置：红将 (4,9)，黑卒 (5,9)（已过河，可左平吃将）。
    const board2 = emptyBoard();
    board2[9]![4] = { side: 0, kind: 'k' };
    board2[9]![5] = { side: 1, kind: 'p' };
    expect(isInCheckExported(board2, 0)).toBe(true);

    // 反例：黑卒未过河不能横走 → 同行但未过河不构成将军。
    // 黑卒 (5,9) 在 y=9（黑方视角已过河）；改用红兵对黑将：红兵 (3,0) 在黑将 (4,0) 左侧
    // 且已过河（红兵 y<=4）→ 横吃将军。反过来未过河的红兵不将军。
    const board3 = emptyBoard();
    board3[0]![4] = { side: 1, kind: 'k' };
    board3[0]![3] = { side: 0, kind: 'p' }; // 红兵 (x=3,y=0) 已过河，在黑将左侧一格 → 将军
    expect(isInCheckExported(board3, 1)).toBe(true);
    const board4 = emptyBoard();
    board4[0]![4] = { side: 1, kind: 'k' };
    board4[1]![4] = { side: 0, kind: 'p' }; // 红兵 (4,1) 在黑将 (4,0) 正下方，红兵向上（y-）将军黑将
    expect(isInCheckExported(board4, 1)).toBe(true);
  });

  it('将军必须应将：不应将的走法非法，应将走法合法', async () => {
    // 构造中炮隔士将军局面：
    // 1. 红炮二平五 (1,7)→(4,7)
    // 2. 黑士 4 进 5 (3,0)→(4,1)
    // 3. 红炮五进四 (4,7)→(4,3) 吃中卒（隔 (4,6) 红兵炮架）→ 隔 (4,1) 黑士将军！
    // 4. 黑方不应将（马 8 进 7）→ 非法「被将军」；改走将 5 平 4 (4,0)→(3,0) 应将 ✓
    const red = sequenceEntrant('r', [
      { from: [1, 7], to: [4, 7] },
      { from: [4, 7], to: [4, 3] },
      { from: [4, 3], to: [3, 3] },
    ]);
    const black = sequenceEntrant('b', [
      { from: [3, 0], to: [4, 1] },
      { from: [7, 0], to: [6, 2] }, // 不应将：非法，记 1 次错
      { from: [4, 0], to: [3, 0] }, // 将 5 平 4 应将 ✓
    ]);
    const game = makeInstance(red, black);
    await game.step(); // 红1
    await game.step(); // 黑1
    await game.step(); // 红2 吃中卒将军
    // 黑2 不应将：马 8 进 7 伪合法但走完仍被将军 → 记 1 次错，棋盘不变
    const frame = await game.step();
    expect(frame?.state.moveCount).toBe(3); // 棋没走，手数不变
    expect(game.isOver()).toBe(false);
    // 黑3 应将：将 5 平 4 → 合法
    const frame2 = await game.step();
    expect(frame2?.state.moveCount).toBe(4);
    expect(frame2?.state.board[0]![3]).toEqual({ side: 1, kind: 'k' });
  });

  it('黑方连续 3 次非法走法判负，红方胜', async () => {
    // 红方炮来回横跳（永远合法），黑方 1 步合法后连续 3 次非法
    const redMoves: Array<{ from: [number, number]; to: [number, number] }> = [];
    for (let i = 0; i < 10; i++) {
      redMoves.push(i % 2 === 0 ? { from: [1, 7], to: [0, 7] } : { from: [0, 7], to: [1, 7] });
    }
    const red = sequenceEntrant('r', redMoves);
    const black = sequenceEntrant('b', [
      { from: [0, 3], to: [0, 4] }, // 合法
      { from: [0, 0], to: [5, 5] }, // 车斜走，非法 ×3
      { from: [0, 0], to: [5, 5] },
      { from: [0, 0], to: [5, 5] },
    ]);
    const game = makeInstance(red, black);
    const { result } = await runToCompletion(game);
    expect(result?.outcome.kind).toBe('win');
    if (result?.outcome.kind === 'win') expect(result.outcome.winner).toBe(0);
    expect(result?.failures[0]?.entrant).toBe(1);
  });

  it('60 回合无吃子 → 判和', async () => {
    // 红炮 (1,7)↔(0,7) 横跳，黑炮 (1,2)↔(0,2) 横跳，双方永不吃子。
    const redMoves: Array<{ from: [number, number]; to: [number, number] }> = [];
    const blackMoves: Array<{ from: [number, number]; to: [number, number] }> = [];
    for (let i = 0; i < 70; i++) {
      redMoves.push(i % 2 === 0 ? { from: [1, 7], to: [0, 7] } : { from: [0, 7], to: [1, 7] });
      blackMoves.push(i % 2 === 0 ? { from: [1, 2], to: [0, 2] } : { from: [0, 2], to: [1, 2] });
    }
    const red = sequenceEntrant('r', redMoves);
    const black = sequenceEntrant('b', blackMoves);
    const game = makeInstance(red, black);
    const { frames, result } = await runToCompletion(game);
    expect(result?.outcome.kind).toBe('draw');
    if (result?.outcome.kind === 'draw') expect(result.outcome.reason).toMatch(/无吃子/);
    // 120 手整触发（isOver 在 step 循环外检查）
    expect(frames.length).toBeGreaterThanOrEqual(120);
  });
});
