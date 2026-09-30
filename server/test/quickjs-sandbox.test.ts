import { beforeAll, describe, expect, it } from 'vitest';
import type { StrategyBudget } from '../src/engine/sandbox-contracts.js';
import {
  getQuickJSEngine,
  QuickJsSandbox,
  QuickJsSandboxFactory,
} from '../src/engine/quickjs-sandbox.js';

const SMALL_BUDGET: StrategyBudget = {
  cpuMs: 100,
  memoryBytes: 8 * 1024 * 1024,
};

const OBSERVATION = {
  me: { x: 1, y: 2, hp: 100 },
  enemy: { x: 9, y: 8, hp: 90 },
  game: { tick: 3, width: 20, height: 20 },
};

/** tank 游戏包的真实观察形状（self/enemy + 顶层元信息）。 */
const TANK_OBSERVATION = {
  tick: 42,
  arena: { width: 20, height: 15 },
  self: { x: 1, y: 2, direction: 'right', hp: 100, cooldown: 0 },
  enemy: { x: 9, y: 8, direction: 'left', hp: 90 },
  hitEvents: [],
};

let engineReady = false;

beforeAll(async () => {
  // 预热引擎单例，避免首个测试承担 WASM 编译时间。
  await getQuickJSEngine();
  engineReady = true;
});

describe('QuickJsSandbox', () => {
  it('provides a factory creating usable sandboxes', async () => {
    expect(engineReady).toBe(true);
    const factory = new QuickJsSandboxFactory();
    const sandbox = factory.create();
    await sandbox.load('function onIdle(me, enemy, game) { return { move: "up" }; }', SMALL_BUDGET);
    const result = await sandbox.act(OBSERVATION);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.action.returned).toEqual({ move: 'up' });
      expect(result.action.commands).toEqual([]);
      expect(result.action.logs).toEqual([]);
    }
    await sandbox.dispose();
  });

  it('keeps strategy state across act calls', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      `
      let state = 0;
      function onIdle(me, enemy, game) {
        state += 1;
        return { type: 'move', dir: me.x < enemy.x ? 'right' : 'left', tick: game.tick, state };
      }
      `,
      SMALL_BUDGET,
    );
    const first = await sandbox.act(OBSERVATION);
    expect(first.kind).toBe('ok');
    if (first.kind === 'ok') {
      expect(first.action.returned).toEqual({
        type: 'move',
        dir: 'right',
        tick: 3,
        state: 1,
      });
    }
    // 跨 act 的状态保持。
    const second = await sandbox.act(OBSERVATION);
    expect(second.kind === 'ok').toBe(true);
    if (second.kind === 'ok') {
      expect((second.action.returned as { state: number }).state).toBe(2);
    }
    await sandbox.dispose();
  });

  it('normalizes tank-style observations (self → me, top-level merged into game)', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      `function onIdle(me, enemy, game) {
        return {
          selfX: me.x,
          selfHp: me.hp,
          enemyHp: enemy ? enemy.hp : null,
          gameTick: game.tick,
          arenaWidth: game.arena ? game.arena.width : null,
        };
      }`,
      SMALL_BUDGET,
    );
    const result = await sandbox.act(TANK_OBSERVATION);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.action.returned).toEqual({
        selfX: 1,
        selfHp: 100,
        enemyHp: 90,
        gameTick: 42,
        arenaWidth: 20,
      });
    }
    await sandbox.dispose();
  });

  it('collects queued commands from me.go/turn/fire/throwBomb/speak calls', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      `function onIdle(me, enemy, game) {
        me.go();
        me.go(2);
        me.turn('left');
        me.fire();
        me.throwBomb();
        me.speak('冲啊');
        me.turn('up'); // 非法方向：忽略
      }`,
      SMALL_BUDGET,
    );
    const result = await sandbox.act(TANK_OBSERVATION);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.action.commands).toEqual([
        { type: 'go' },
        { type: 'go' },
        { type: 'go' },
        { type: 'turn', dir: 'left' },
        { type: 'fire' },
        { type: 'bomb' },
        { type: 'speak', text: '冲啊' },
      ]);
    }
    await sandbox.dispose();
  });

  it('collects me.place commands for turn-based games', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      `function onIdle(me, enemy, game) {
        me.place(7, 8);
        me.place(1.5, 2); // 非整数：忽略
      }`,
      SMALL_BUDGET,
    );
    const result = await sandbox.act({ me: {}, enemy: null, game: {} });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.action.commands).toEqual([{ type: 'place', x: 7, y: 8 }]);
    }
    await sandbox.dispose();
  });

  it('collects print() logs and caps speak text at 40 chars', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      `function onIdle(me, enemy, game) {
        print('hello', { a: 1 });
        me.speak('x'.repeat(60));
      }`,
      SMALL_BUDGET,
    );
    const result = await sandbox.act(OBSERVATION);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.action.logs).toEqual(['hello {"a":1}']);
      const speak = result.action.commands.find((c) => c.type === 'speak');
      expect(speak && speak.type === 'speak' ? speak.text.length : 0).toBe(40);
    }
    await sandbox.dispose();
  });

  it('returns error with the thrown message when the strategy throws', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      'function onIdle() { throw new Error("boom from strategy"); }',
      SMALL_BUDGET,
    );
    const result = await sandbox.act(OBSERVATION);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('boom from strategy');
    }
    await sandbox.dispose();
  });

  it('returns error within the timeout for an infinite-loop strategy', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      'function onIdle() { while (true) {} }',
      { cpuMs: 100, memoryBytes: SMALL_BUDGET.memoryBytes },
    );
    const started = Date.now();
    const result = await sandbox.act(OBSERVATION);
    const elapsed = Date.now() - started;
    expect(result.kind).toBe('error');
    // 每帧份额 = 100/600 上限 50ms，加上开销给足余量。
    expect(elapsed).toBeLessThan(2000);
    await sandbox.dispose();
  }, 10_000);

  it('returns error for a strategy exceeding the memory limit', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      'function onIdle() { const a = []; while (true) { a.push(new Array(10000).fill(1)); } return {}; }',
      { cpuMs: 60_000, memoryBytes: 8 * 1024 * 1024 },
    );
    const result = await sandbox.act(OBSERVATION);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      // QuickJS 内存超限错误信息。
      expect(result.message.length).toBeGreaterThan(0);
    }
    await sandbox.dispose();
  }, 20_000);

  it('returns error (not throw) when act is called after dispose', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load('function onIdle() { return { ok: true }; }', SMALL_BUDGET);
    await sandbox.dispose();
    const result = await sandbox.act(OBSERVATION);
    expect(result.kind).toBe('error');
    // 幂等 dispose。
    await sandbox.dispose();
    await sandbox.dispose();
  });

  it('rejects load when compilation fails, without leaking', async () => {
    const sandbox = new QuickJsSandbox();
    await expect(
      sandbox.load('function onIdle( {', SMALL_BUDGET),
    ).rejects.toThrow();
    await sandbox.dispose();
  });

  it('rejects load when onIdle is not defined', async () => {
    const sandbox = new QuickJsSandbox();
    await expect(sandbox.load('var x = 1;', SMALL_BUDGET)).rejects.toThrow(
      /onIdle/,
    );
  });

  it('tolerates non-serializable return values (returned → null, commands kept)', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      `function onIdle(me) {
        me.go();
        return () => 1;
      }`,
      SMALL_BUDGET,
    );
    const result = await sandbox.act(OBSERVATION);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.action.returned).toBeNull();
      expect(result.action.commands).toEqual([{ type: 'go' }]);
    }
    await sandbox.dispose();
  });
});
