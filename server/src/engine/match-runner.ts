/**
 * 对局运行器（ADR 0003：直播推进 + 训练快速计算，两者共用执行语义）。
 *
 * 职责：
 * - 为双方各创建沙箱并载入策略源码；load 失败的一方直接判负；
 * - 驱动 GameInstance 的 step 循环，帧追加到 MatchRecord.frames，
 *   并通过 LiveHub 向观众直播；
 * - 区分两类故障（ADR 0003）：策略自身失败（sandbox.act 返回 error / 抛错）
 *   判该方负；平台侧异常（游戏引擎、存储等抛出）→ phase 'invalid'；
 * - official 模式按 officialTickDelayMs 节拍模拟直播节奏，
 *   training 模式跳过等待立即跑完——两种模式使用同一 step 循环。
 */

import type {
  EntrantHandle,
  FrameSnapshot,
  GameInstance,
  GamePackage,
  MatchResult,
} from '../games/contracts.js';
import type { SandboxFactory, StrategySandbox } from './sandbox-contracts.js';
import { DEFAULT_STRATEGY_BUDGET } from './sandbox-contracts.js';
import type { MatchRecord } from './match-contracts.js';
import type { MatchStore } from './match-store.js';
import type { LiveHub } from './live-hub.js';

export interface RunMatchInput {
  readonly matchId: string;
  readonly gameId: string;
  readonly kind: 'official' | 'training';
  readonly entrants: readonly [
    { entrantId: string; strategyVersionId: string; source: string },
    { entrantId: string; strategyVersionId: string; source: string },
  ];
  readonly seed?: number;
}

/** 载入策略失败的一方的判负结果。 */
function forfeitResult(loser: 0 | 1, message: string): MatchResult {
  return {
    outcome: { kind: 'win', winner: loser === 0 ? 1 : 0, reason: `参赛方 ${loser} 策略载入失败` },
    failures: [{ entrant: loser, message }],
  };
}

/** 安全释放沙箱：dispose 异常不应掩盖对局结果。 */
async function disposeQuietly(sandbox: StrategySandbox | undefined): Promise<void> {
  if (!sandbox) return;
  try {
    await sandbox.dispose();
  } catch {
    // 忽略释放失败
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class MatchRunner {
  private readonly games: Map<string, GamePackage>;
  private readonly sandboxes: SandboxFactory;
  private readonly store: MatchStore;
  private readonly liveHub: LiveHub;
  private readonly officialTickDelayMs: number;

  constructor(options: {
    games: Map<string, GamePackage>;
    sandboxes: SandboxFactory;
    store: MatchStore;
    liveHub: LiveHub;
    /** official 模式每帧间隔（模拟直播节奏），默认 50ms。 */
    officialTickDelayMs?: number;
  }) {
    this.games = options.games;
    this.sandboxes = options.sandboxes;
    this.store = options.store;
    this.liveHub = options.liveHub;
    this.officialTickDelayMs = options.officialTickDelayMs ?? 50;
  }

  async run(input: RunMatchInput): Promise<MatchRecord> {
    const record = this.store.create({
      matchId: input.matchId,
      gameId: input.gameId,
      entrants: [
        { entrantId: input.entrants[0].entrantId, strategyVersionId: input.entrants[0].strategyVersionId },
        { entrantId: input.entrants[1].entrantId, strategyVersionId: input.entrants[1].strategyVersionId },
      ],
      kind: input.kind,
    });
    this.liveHub.attach(record.matchId, this.store);

    // 沙箱与游戏实例在 finally 中统一清理/结算
    const sandbox0 = this.sandboxes.create();
    const sandbox1 = this.sandboxes.create();
    let game: GameInstance | null = null;

    try {
      // 1) 载入双方策略；失败方直接判负
      const loadResults = await Promise.allSettled([
        sandbox0.load(input.entrants[0].source, DEFAULT_STRATEGY_BUDGET),
        sandbox1.load(input.entrants[1].source, DEFAULT_STRATEGY_BUDGET),
      ]);

      const loadFailure = ([0, 1] as const)
        .map((i) => ({ i, r: loadResults[i] }))
        .find(({ r }) => r.status === 'rejected');
      if (loadFailure) {
        const message = `策略载入失败: ${
          loadFailure.r.status === 'rejected' ? String(loadFailure.r.reason) : ''
        }`;
        this.store.finish(record.matchId, forfeitResult(loadFailure.i, message), 'finished');
        return record;
      }

      // 2) 构造游戏实例（注入 EntrantHandle，包一层 act 返回值）
      const gamePackage = this.games.get(input.gameId);
      if (!gamePackage) {
        throw new Error(`游戏不存在: ${input.gameId}`);
      }
      game = gamePackage.createInstance(
        [
          this.makeEntrant(0, input.entrants[0].entrantId, sandbox0),
          this.makeEntrant(1, input.entrants[1].entrantId, sandbox1),
        ],
        input.seed !== undefined ? { seed: input.seed } : undefined,
      );

      // 3) step 循环：official 与 training 共用，只是节拍不同
      let guard = 0;
      while (!game.isOver()) {
        if (++guard > 100_000) {
          throw new Error('对局超过最大帧数上限（疑似死循环）');
        }
        const frame = await game.step();
        if (frame) {
          this.store.updateFrame(record.matchId, frame);
          this.liveHub.publish(record.matchId, frame);
        }
        if (input.kind === 'official' && this.officialTickDelayMs > 0 && !game.isOver()) {
          await sleep(this.officialTickDelayMs);
        }
      }

      // 4) 正常结束
      const result = game.result();
      if (!result) {
        throw new Error('对局已结束但游戏未提供结果');
      }
      this.store.finish(record.matchId, result, 'finished');
      return record;
    } catch (err) {
      if (err instanceof StrategyFailureError) {
        // 策略自身故障（sandbox.act 返回/抛出 error）→ 判该方负（ADR 0003）
        this.store.finish(
          record.matchId,
          forfeitResult(err.entrant, `策略执行失败: ${err.message}`),
          'finished',
        );
      } else {
        // 平台侧异常（非策略 error）→ invalid，不计成绩（ADR 0003）
        const message = err instanceof Error ? err.message : String(err);
        this.store.finish(
          record.matchId,
          { outcome: { kind: 'invalid', reason: `平台执行故障: ${message}` }, failures: [] },
          'invalid',
        );
      }
      return record;
    } finally {
      this.liveHub.publishEnd(record.matchId, record.result);
      await Promise.all([disposeQuietly(sandbox0), disposeQuietly(sandbox1)]);
    }
  }

  /**
   * 将沙箱包装为 EntrantHandle，标记所属方（0/1）。
   * sandbox.act 返回 { kind: 'error' } 或自身抛错均属策略故障，
   * 以 StrategyFailureError 上抛（附带 entrant 序号），由 runner 判该方负；
   * 若 GameInstance 按规则自行消化了该错误则不触发判负。
   */
  private makeEntrant(
    index: 0 | 1,
    entrantId: string,
    sandbox: StrategySandbox,
  ): EntrantHandle {
    return {
      entrantId,
      act: (observation: unknown) =>
        sandbox.act(observation).then(
          (step) => {
            if (step.kind === 'error') {
              throw new StrategyFailureError(index, step.message);
            }
            return step.action;
          },
          (err: unknown) => {
            throw new StrategyFailureError(
              index,
              err instanceof Error ? err.message : String(err),
            );
          },
        ),
    };
  }
}

/** 策略自身故障（区别于平台故障）——携带出错方序号。 */
export class StrategyFailureError extends Error {
  readonly entrant: 0 | 1;
  constructor(entrant: 0 | 1, message: string) {
    super(message);
    this.name = 'StrategyFailureError';
    this.entrant = entrant;
  }
}
