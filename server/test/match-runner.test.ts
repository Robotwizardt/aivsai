import { describe, expect, it } from 'vitest';
import type {
  EntrantHandle,
  FrameSnapshot,
  GameDefinition,
  GameInstance,
  GamePackage,
} from '../src/games/contracts.js';
import type {
  SandboxFactory,
  StrategySandbox,
  StrategyStepResult,
} from '../src/engine/sandbox-contracts.js';
import { MatchRunner } from '../src/engine/match-runner.js';
import { SQLiteMatchStore } from '../src/engine/match-store.js';
import { initDatabase } from '../src/db/database.js';
import { LiveHub } from '../src/engine/live-hub.js';
import { Scheduler } from '../src/engine/scheduler.js';

// ---------------------------------------------------------------- fakes

const TEST_GAME_DEF: GameDefinition = {
  id: 'test-game',
  name: '测试游戏',
  pacing: 'turn-based',
  actionNames: ['move'],
};

/** 3 tick 结束的假游戏；帧内容可预测（含 tick 号）。 */
class FakeGame implements GameInstance {
  readonly definition = TEST_GAME_DEF;
  private tick = 0;
  private lastAction: unknown = null;
  constructor(private readonly entrants: [EntrantHandle, EntrantHandle]) {}

  async step(): Promise<FrameSnapshot | null> {
    if (this.isOver()) return null;
    this.tick++;
    const side = (this.tick - 1) % 2;
    this.lastAction = await this.entrants[side].act({ tick: this.tick, side });
    return { tick: this.tick, state: { tick: this.tick, action: this.lastAction } };
  }

  isOver(): boolean {
    return this.tick >= 3;
  }

  result() {
    return this.isOver()
      ? {
          outcome: { kind: 'win' as const, winner: 0 as const, reason: `ticked ${this.tick}` },
          failures: [],
        }
      : null;
  }
}

/** step() 可注入平台异常的包装。 */
function fakeGamePackage(overrides?: { stepThrows?: boolean }): GamePackage {
  return {
    definition: TEST_GAME_DEF,
    createInstance(entrants: [EntrantHandle, EntrantHandle]): GameInstance {
      const base = new FakeGame(entrants);
      if (!overrides?.stepThrows) return base;
      return {
        definition: base.definition,
        step: async () => {
          await base.step(); // 确认沙箱路径正常
          throw new Error('引擎内部崩溃');
        },
        isOver: () => false, // 永不正常结束
        result: () => null,
      };
    },
  };
}

/** 假沙箱：load 可按 source 标记失败；act 同步返回固定行动。 */
class FakeSandbox implements StrategySandbox {
  static created = 0;
  static disposed = 0;
  readonly id = ++FakeSandbox.created;
  loaded = false;

  async load(source: string): Promise<void> {
    if (source === 'BAD') throw new Error('syntax error in source');
    this.loaded = true;
  }

  async act(observation: unknown): Promise<StrategyStepResult> {
    if (!this.loaded) throw new Error('not loaded');
    return { kind: 'ok', action: { move: (observation as { tick: number }).tick } };
  }

  async dispose(): Promise<void> {
    FakeSandbox.disposed++;
  }
}

function fakeSandboxFactory(): SandboxFactory {
  return { create: () => new FakeSandbox() };
}

function makeRunner(opts?: { officialTickDelayMs?: number }) {
  const games = new Map<string, GamePackage>([['test-game', fakeGamePackage()]]);
  const store = new SQLiteMatchStore(initDatabase(':memory:'));
  const liveHub = new LiveHub();
  const runner = new MatchRunner({
    games,
    sandboxes: fakeSandboxFactory(),
    store,
    liveHub,
    officialTickDelayMs: opts?.officialTickDelayMs,
  });
  return { runner, store, liveHub };
}

const baseInput = {
  gameId: 'test-game',
  entrants: [
    { entrantId: 'e0', strategyVersionId: 'sv0', source: 'strategy-0' },
    { entrantId: 'e1', strategyVersionId: 'sv1', source: 'strategy-1' },
  ],
} as const;

// ---------------------------------------------------------------- tests

describe('MatchRunner', () => {
  it('official 模式跑完：phase=finished，帧数与结果正确，沙箱被释放', async () => {
    const { runner, store } = makeRunner({ officialTickDelayMs: 1 });
    FakeSandbox.created = 0;
    FakeSandbox.disposed = 0;
    const before = FakeSandbox.created;

    const record = await runner.run({ ...baseInput, matchId: 'm1', kind: 'official' });

    expect(FakeSandbox.created).toBe(before + 2);
    expect(FakeSandbox.disposed).toBeGreaterThanOrEqual(2); // finally 释放
    expect(record.phase).toBe('finished');
    expect(record.frames).toHaveLength(3);
    expect(record.frames.map((f) => f.tick)).toEqual([1, 2, 3]);
    expect(record.frames[2]?.state).toEqual({ tick: 3, action: { move: 3 } });
    expect(record.result).toEqual({
      outcome: { kind: 'win', winner: 0, reason: 'ticked 3' },
      failures: [],
    });
    // store 与 record 是同一对象（内存实现）
    expect(store.get('m1')?.phase).toBe('finished');
  });

  it('一方 load 失败 → 该方判负，原因被记录', async () => {
    const { runner } = makeRunner();
    const record = await runner.run({
      ...baseInput,
      matchId: 'm2',
      kind: 'training',
      entrants: [
        { entrantId: 'e0', strategyVersionId: 'sv0', source: 'strategy-0' },
        { entrantId: 'e1', strategyVersionId: 'sv1', source: 'BAD' },
      ],
    });

    expect(record.phase).toBe('finished');
    expect(record.frames).toHaveLength(0);
    expect(record.result?.outcome.kind).toBe('win');
    expect(record.result?.outcome).toEqual({ kind: 'win', winner: 0, reason: '参赛方 1 策略载入失败' });
    expect(record.result?.failures).toEqual([{ entrant: 1, message: expect.stringContaining('载入失败') }]);
  });

  it('game.step() 抛平台异常 → phase=invalid，outcome kind=invalid', async () => {
    const store = new SQLiteMatchStore(initDatabase(':memory:'));
    const runner = new MatchRunner({
      games: new Map([['test-game', fakeGamePackage({ stepThrows: true })]]),
      sandboxes: fakeSandboxFactory(),
      store,
      liveHub: new LiveHub(),
    });

    const record = await runner.run({ ...baseInput, matchId: 'm3', kind: 'training' });

    expect(record.phase).toBe('invalid');
    expect(record.result?.outcome).toEqual({
      kind: 'invalid',
      reason: expect.stringContaining('平台执行故障'),
    });
  });

  it('training 模式无直播延迟：耗时显著小于 official 模式', async () => {
    const officialRunner = makeRunner({ officialTickDelayMs: 40 });
    const trainingRunner = makeRunner();

    const t0 = Date.now();
    await officialRunner.runner.run({ ...baseInput, matchId: 'm-official', kind: 'official' });
    const officialDur = Date.now() - t0;

    const t1 = Date.now();
    await trainingRunner.runner.run({ ...baseInput, matchId: 'm-training', kind: 'training' });
    const trainingDur = Date.now() - t1;

    // official: 3 帧之间 2 次 40ms 延迟 ≥ 70ms；training 应几乎瞬时
    expect(officialDur).toBeGreaterThanOrEqual(70);
    expect(trainingDur).toBeLessThan(officialDur);
    expect(trainingDur).toBeLessThan(50);
  });
});

describe('LiveHub', () => {
  it('subscribe 时同步重放历史帧，随后收到增量帧与结束信号', async () => {
    const { runner, liveHub } = makeRunner({ officialTickDelayMs: 20 });
    const runPromise = runner.run({ ...baseInput, matchId: 'm-live', kind: 'official' });

    // tick1 立即产生；20ms 延迟后才有 tick2，此时订阅只能追到历史
    await new Promise((r) => setTimeout(r, 5));

    const received: number[] = [];
    let endResult: unknown = 'not-ended';
    let replayedCount = 0;
    liveHub.subscribe(
      'm-live',
      1,
      (f) => {
        received.push(f.tick);
        replayedCount++; // 简单计数：回放+增量同走此回调
      },
      (result) => {
        endResult = result;
      },
    );

    // backstop：订阅时同步追回 tick=1
    expect(received).toEqual([1]);
    const synced = received.length;
    expect(synced).toBe(1);

    await runPromise;

    // 之后通过 publish 收到增量 tick=2、3
    expect(received).toEqual([1, 2, 3]);
    expect(replayedCount).toBe(3);
    expect((endResult as { outcome: { kind: string } }).outcome.kind).toBe('win');
  });

  it('重启后未 attach 的 LiveHub 也能回放已结束对局（持久化记录直接从 store 读）', async () => {
    // 模拟重启：新建一个 LiveHub，但 store 里已有持久化的已结束对局
    const store = new SQLiteMatchStore(initDatabase(':memory:'));
    const runner = new MatchRunner({
      games: new Map<string, GamePackage>([['test-game', fakeGamePackage()]]),
      sandboxes: fakeSandboxFactory(),
      store,
      liveHub: new LiveHub(), // 这个 LiveHub 在 runner.run 里被 attach
    });
    await runner.run({ ...baseInput, matchId: 'm-persist', kind: 'official' });

    // 新建一个从未 attach 过的 LiveHub（模拟服务重启后新创建的实例）
    const freshHub = new LiveHub({ getRecord: (id) => store.get(id) });

    const received: number[] = [];
    let endResult: unknown = 'not-ended';
    freshHub.subscribe(
      'm-persist',
      0,
      (f) => received.push(f.tick),
      (result) => {
        endResult = result;
      },
    );

    // 必须能回放全部帧并收到结束信号——不依赖 attach
    expect(received).toEqual([1, 2, 3]);
    expect((endResult as { outcome: { kind: string } }).outcome.kind).toBe('win');
  });
});

describe('Scheduler', () => {
  it('maxConcurrent=1 时两个任务串行执行', async () => {
    const scheduler = new Scheduler({ maxConcurrent: 1, pollMs: 0 });
    const events: string[] = [];
    const makeTask = (name: string) => async () => {
      events.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end:${name}`);
    };

    const p1 = scheduler.enqueue({ kind: 'training', workspaceId: 'w1', run: makeTask('a') });
    const p2 = scheduler.enqueue({ kind: 'training', workspaceId: 'w1', run: makeTask('b') });
    await Promise.all([p1, p2]);
    scheduler.stop();

    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('official 插队排在 training 之前（开始顺序）', async () => {
    const scheduler = new Scheduler({ maxConcurrent: 1, pollMs: 0 });
    const order: string[] = [];
    const makeTask = (name: string) => async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, 20));
    };

    // a 先入队并立刻占满唯一名额，随后 b(training)、c(official) 排队
    const pa = scheduler.enqueue({ kind: 'training', workspaceId: 'w1', run: makeTask('a') });
    const pb = scheduler.enqueue({ kind: 'training', workspaceId: 'w1', run: makeTask('b') });
    const pc = scheduler.enqueue({ kind: 'official', workspaceId: 'w2', run: makeTask('c') });
    await Promise.all([pa, pb, pc]);
    scheduler.stop();

    expect(order).toEqual(['a', 'c', 'b']);
  });
});
