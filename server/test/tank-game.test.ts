import { describe, expect, it } from 'vitest';
import type { EntrantHandle, GameInstance } from '../src/games/contracts.js';
import {
  buildTankObservation,
  deriveSeedFromMatchId,
  tankGamePackage,
} from '../src/games/tank/tank-game.js';
import type { TankGameState, TankObservation } from '../src/games/tank/tank-game.js';

// ---------------------------------------------------------------- fakes

/** 脚本化假策略：按 tick 依次返回行动列表，列表取尽后返回 none。 */
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
      const action = actions[handle.calls - 1] ?? { move: 'none' };
      return Promise.resolve(action);
    },
  };
  return handle;
}

/** 每次 act 都抛错的假策略。 */
function throwingEntrant(entrantId: string, message = '策略崩溃'): EntrantHandle {
  return {
    entrantId,
    act: () => Promise.reject(new Error(message)),
  };
}

function makeInstance(
  a: EntrantHandle,
  b: EntrantHandle,
  seed = 12345,
): GameInstance {
  return tankGamePackage.createInstance([a, b], { seed });
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

// ---------------------------------------------------------------- tests

describe('tankGamePackage', () => {
  it('definition 元信息正确', () => {
    expect(tankGamePackage.definition).toEqual({
      id: 'tank',
      name: '坦克大战',
      pacing: 'instant',
      actionNames: ['move', 'turn', 'fire'],
    });
  });

  it('同 seed 生成完全相同的对称地图（可复现）', async () => {
    const mk = () => {
      const game = makeInstance(
        scriptedEntrant('a', []),
        scriptedEntrant('b', []),
        42,
      );
      return game.step().then((f) => (f!.state as TankGameState).walls);
    };
    const walls1 = await mk();
    const walls2 = await mk();
    expect(walls1).toEqual(walls2);
    // 对称性：墙 (x,y) 存在 ⇔ (19-x,y) 存在
    const set = new Set(walls1);
    for (const w of walls1) {
      const [x, y] = w.split(',').map(Number);
      expect(set.has(`${19 - x},${y}`)).toBe(true);
    }
    // 出生点与中央走廊无墙
    expect(set.has('2,7')).toBe(false);
    expect(set.has('17,7')).toBe(false);
    expect([...set].every((w) => !w.endsWith(',7'))).toBe(true);
  });

  it('面对面开火：命中扣 34 HP，击毁后得到 win 结果', async () => {
    // 出生面对面（中央走廊无墙，0 号朝东、1 号朝西）；0 号持续开火，1 号不动
    const a = scriptedEntrant('a', Array.from({ length: 60 }, () => ({ fire: true })));
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);

    const { frames, result } = await runToCompletion(game);

    // 伤害 100 = 34*3：第 3 次命中后结束，帧数远小于 300
    expect(frames.length).toBeLessThan(300);
    const finalState = frames[frames.length - 1]!.state as TankGameState;
    expect(finalState.tanks[1].hp).toBeLessThanOrEqual(0);
    expect(finalState.tanks[0].hp).toBe(100);
    expect(finalState.events.length).toBeGreaterThan(0);
    expect(finalState.events.every((e) => e.damage === 34)).toBe(true);

    expect(result).not.toBeNull();
    expect(result!.outcome).toEqual({
      kind: 'win',
      winner: 0,
      reason: '参赛方 1 坦克被击毁',
    });
    expect(result!.failures).toEqual([]);
    // 冷却 8 tick：命中事件恰为击毁所需的 3 次
    expect(finalState.events.filter((e) => e.target === 1)).toHaveLength(3);
  });

  it('非法行动 move:"teleport" 被当 no-op，不崩溃、不判负', async () => {
    const a = scriptedEntrant('a', [
      { move: 'teleport' },
      { move: 'teleport', turn: 9, fire: 'yes' },
      { move: 42 },
      null as unknown as Record<string, unknown>,
      'garbage' as unknown as Record<string, unknown>,
    ]);
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);

    const { frames, result } = await runToCompletion(game);

    // 正常跑满 300 tick，双方不动 → draw，非法行动未触发任何错误判负
    expect(frames).toHaveLength(300);
    expect(result!.outcome.kind).toBe('draw');
    expect(result!.failures).toEqual([]);
    const state0 = frames[0]!.state as TankGameState;
    const stateFinal = frames[299]!.state as TankGameState;
    expect(stateFinal.tanks[0]).toEqual({ ...state0.tanks[0], cooldown: 0 });
  });

  it('act 抛错的策略累计 3 次后判负，fault message 被截断记录', async () => {
    const a = scriptedEntrant('a', []);
    const longMessage = 'x'.repeat(500);
    const b = throwingEntrant('b', longMessage);
    const game = makeInstance(a, b);

    const { frames, result } = await runToCompletion(game);

    expect(frames.length).toBe(3); // 第 3 个 tick 达到错误上限
    expect(result!.outcome).toEqual({
      kind: 'win',
      winner: 0,
      reason: expect.stringContaining('累计 3 次执行错误'),
    });
    expect(result!.failures).toEqual([{ entrant: 1, message: 'x'.repeat(200) }]);
  });

  it('act 返回 { kind: "error" } 同样计入策略错误', async () => {
    const a = scriptedEntrant('a', []);
    const b: EntrantHandle = {
      entrantId: 'b',
      act: () => Promise.resolve({ kind: 'error', message: '沙箱报错' }),
    };
    const game = makeInstance(a, b);
    const { frames, result } = await runToCompletion(game);
    expect(frames.length).toBe(3);
    expect(result!.outcome).toEqual({
      kind: 'win',
      winner: 0,
      reason: expect.stringContaining('累计 3 次执行错误'),
    });
    expect(result!.failures).toEqual([{ entrant: 1, message: '沙箱报错' }]);
  });

  it('300 tick 上限：双方不动 → 超时 HP 相同 → draw', async () => {
    const a = scriptedEntrant('a', []);
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);

    const { frames, result } = await runToCompletion(game);

    expect(frames).toHaveLength(300);
    expect(frames.map((f) => f.tick)).toEqual(
      Array.from({ length: 300 }, (_, i) => i + 1),
    );
    const finalState = frames[299]!.state as TankGameState;
    expect(finalState.tanks[0].hp).toBe(100);
    expect(finalState.tanks[1].hp).toBe(100);
    expect(result!.outcome).toEqual({
      kind: 'draw',
      reason: expect.stringContaining('300 tick 上限'),
    });
    // 结束后 step 返回 null
    expect(await game.step()).toBeNull();
  });

  it('观众帧包含完整双方信息（不隐藏）', async () => {
    const a = scriptedEntrant('a', [
      { move: 'forward' },
      { fire: true },
      { move: 'forward', turn: 2 },
    ]);
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);

    const frame0 = (await game.step())!;
    const state0 = frame0.state as TankGameState;
    expect(state0.arena).toEqual({ width: 20, height: 15 });
    expect(state0.tanks).toHaveLength(2);
    for (const t of state0.tanks) {
      expect(t).toEqual(
        expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          direction: expect.any(Number),
          hp: 100,
          cooldown: 0,
        }),
      );
    }
    expect(Array.isArray(state0.walls)).toBe(true);
    expect(Array.isArray(state0.bullets)).toBe(true);
    expect(state0.tanks[0]).toEqual({ x: 3, y: 7, direction: 1, hp: 100, cooldown: 0 });
    expect(state0.tanks[1]).toEqual({ x: 17, y: 7, direction: 3, hp: 100, cooldown: 0 });

    const frame1 = (await game.step())!;
    const state1 = frame1.state as TankGameState;
    // 观众帧能看到双方子弹（即使策略视角互相看不到）；子弹生成当 tick 即推进一格
    expect(state1.bullets).toEqual([{ x: 4, y: 7, direction: 1, owner: 0 }]);

    const frame2 = (await game.step())!;
    const state2 = frame2.state as TankGameState;
    // 移动与转向（1→2 顺时针一步）
    expect(state2.tanks[0]).toEqual({ x: 4, y: 7, direction: 2, hp: 100, cooldown: 6 });
  });

  it('观察只含自己视角：无视线时 enemy 为 null，出生面对面时可见', async () => {
    const a = scriptedEntrant('a', []);
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);

    await game.step(); // 产生一个初始帧，拿到 state
    const state = (await game.step())!.state as TankGameState;

    // 出生点 (2,7) 与 (17,7) 同行且中央走廊无墙 → 面对面可见
    const obs0 = buildTankObservation(state, 0) as TankObservation;
    expect(obs0.self.x).toBe(2);
    expect(obs0.enemy).toEqual({ x: 17, y: 7, direction: 3, hp: 100 });

    // 用一堵假墙挡住走廊 → enemy 隐藏
    const blocked: TankGameState = {
      ...state,
      walls: [...state.walls, '10,7'].sort(),
    };
    const obsBlocked = buildTankObservation(blocked, 0) as TankObservation;
    expect(obsBlocked.enemy).toBeNull();
    // 非同行/列/对角线（如斜两格）同样不可见
    const offAxis: TankGameState = {
      ...state,
      tanks: [
        { ...state.tanks[0] },
        { ...state.tanks[1], x: 16, y: 5 },
      ],
    };
    expect((buildTankObservation(offAxis, 0) as TankObservation).enemy).toBeNull();
  });

  it('双方策略每 tick 被并行调用且收到各自视角观察', async () => {
    const a = scriptedEntrant('a', []);
    const b = scriptedEntrant('b', []);
    const game = makeInstance(a, b);
    await runToCompletion(game);
    expect(a.calls).toBe(300);
    expect(b.calls).toBe(300);
    const obsA = a.observations[0] as TankObservation;
    const obsB = b.observations[0] as TankObservation;
    expect(obsA.self.x).toBe(2);
    expect(obsB.self.x).toBe(17);
  });

  it('deriveSeedFromMatchId：不同 matchId 派生不同种子（多数情况下）', () => {
    const seeds = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seeds.add(String(deriveSeedFromMatchId(`match-${i}`)));
    }
    expect(seeds.size).toBeGreaterThan(40);
  });
});
