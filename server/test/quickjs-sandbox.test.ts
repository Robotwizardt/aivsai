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
    expect(result).toEqual({ kind: 'ok', action: { move: 'up' } });
    await sandbox.dispose();
  });

  it('returns ok with the action object for a normal strategy', async () => {
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
      expect(first.action).toEqual({
        type: 'move',
        dir: 'right',
        tick: 3,
        state: 1,
      });
    }
    // 跨 act 的状态保持。
    const second = await sandbox.act(OBSERVATION);
    expect(second.kind).toBe('ok');
    if (second.kind === 'ok') {
      expect((second.action as { state: number }).state).toBe(2);
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
    await sandbox.dispose();
  });

  it('returns error for non-serializable return values', async () => {
    const sandbox = new QuickJsSandbox();
    await sandbox.load(
      'function onIdle() { return () => 1; }',
      SMALL_BUDGET,
    );
    const result = await sandbox.act(OBSERVATION);
    expect(result.kind).toBe('error');
    await sandbox.dispose();
  });
});
