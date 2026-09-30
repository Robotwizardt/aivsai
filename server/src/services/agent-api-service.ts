/**
 * Agent 工作流服务：给外部 AI Agent 用的试跑（simulate）。
 *
 * - 同步运行一场坦克对局：不创建 MatchRecord、不进排行榜、不产生策略版本；
 * - self 为请求体中的候选代码，opponent 为内置 bot 或该参赛对象已发布版本；
 * - 沙箱错误语义与正式对局一致（策略故障由 tank 引擎错误计数自然判负），
 *   平台侧异常以 invalid 结果返回而不是 500。
 */

import { randomUUID } from 'node:crypto';
import type { FrameSnapshot, GamePackage, MatchResult } from '../games/contracts.js';
import { deriveSeedFromMatchId } from '../games/tank/tank-game.js';
import { tankBots } from '../games/tank/bots.js';
import type { SandboxFactory, StrategySandbox } from '../engine/sandbox-contracts.js';
import { DEFAULT_STRATEGY_BUDGET } from '../engine/sandbox-contracts.js';

const MAX_CODE_BYTES = 200 * 1024;

export { MAX_CODE_BYTES };

export interface SimulateInput {
  /** 我方候选策略源码。 */
  readonly code: string;
  /** 受冷却限制的主体（参赛对象 id）。 */
  readonly entrantId: string;
}

export interface SimulateStats {
  hp: number | null;
  stars: number | null;
  errors: number;
}

export interface SimulateOutcome {
  kind: 'win' | 'draw' | 'invalid';
  winner?: 'self' | 'opponent';
  reason: string;
}

export interface SimulateResult {
  outcome: SimulateOutcome;
  ticks: number;
  frames: FrameSnapshot[];
  selfStats: SimulateStats;
  opponentStats: SimulateStats;
  selfName: string;
  opponentName: string;
  logs: { self: string[]; opponent: string[] };
}

type SideStatsSource = { hp?: unknown; stars?: unknown };

function readSideStats(side: unknown): SimulateStats {
  let hp: number | null = null;
  let stars: number | null = null;
  const s = side as SideStatsSource | null | undefined;
  if (s && typeof s === 'object') {
    if (typeof s.hp === 'number') hp = s.hp;
    else if (s.hp && typeof s.hp === 'object' && 'current' in s.hp) {
      const cur = (s.hp as { current?: unknown }).current;
      if (typeof cur === 'number') hp = cur;
    }
    if (typeof s.stars === 'number') stars = s.stars;
  }
  return { hp, stars, errors: 0 };
}

function readFinalState(frames: readonly FrameSnapshot[]): { self: unknown; opponent: unknown } {
  for (let i = frames.length - 1; i >= 0; i--) {
    const state = frames[i]!.state as Record<string, unknown> | null;
    if (!state || typeof state !== 'object') continue;
    const tanks = state.tanks;
    if (Array.isArray(tanks) && tanks.length === 2) {
      return { self: tanks[0], opponent: tanks[1] };
    }
  }
  return { self: null, opponent: null };
}

/** outcome.winner: 引擎 0|1（0=self）→ 'self'|'opponent'。 */
function mapOutcome(result: MatchResult): SimulateOutcome {
  const o = result.outcome;
  if (o.kind === 'win') {
    return { kind: 'win', winner: o.winner === 0 ? 'self' : 'opponent', reason: o.reason };
  }
  if (o.kind === 'draw') return { kind: 'draw', reason: o.reason };
  return { kind: 'invalid', reason: o.reason };
}

async function disposeQuietly(sandbox: StrategySandbox | undefined): Promise<void> {
  if (!sandbox) return;
  try {
    await sandbox.dispose();
  } catch (err) {
    // 释放失败不影响本场结果，但要留痕：静默吞掉会让沙箱泄漏长期不可见。
    console.warn('[sandbox] dispose failed:', err);
  }
}

export class AgentApiService {
  /** entrantId -> 上次试跑**结束**时间（每参赛对象 2 秒 1 次）。 */
  private readonly lastSimulateAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      sandboxes: SandboxFactory;
      tankGame: GamePackage;
      /** simulate 冷却窗口（毫秒），默认 2000。 */
      cooldownMs?: number;
      /** 注入时钟，测试用。 */
      now?: () => number;
    },
  ) {}

  /**
   * 超限返回 true（应答 429）。
   *
   * 注意：窗口从**上一次试跑结束**计时，不是本次请求开始——否则一场 1 秒的试跑
   * 结束后只需 1 秒就能再次触发，实际冷却短于配置值。
   */
  isRateLimited(entrantId: string): boolean {
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastSimulateAt.get(entrantId);
    return last !== undefined && now - last < (this.deps.cooldownMs ?? 2000);
  }

  /** 试跑结束后提交冷却窗口，顺带回收过期条目（避免 Map 无界增长）。 */
  private commitRateLimit(entrantId: string): void {
    const now = this.deps.now?.() ?? Date.now();
    const cooldown = this.deps.cooldownMs ?? 2000;
    for (const [id, at] of this.lastSimulateAt) {
      if (now - at >= cooldown) this.lastSimulateAt.delete(id);
    }
    this.lastSimulateAt.set(entrantId, now);
  }

  /** 构造 invalid 结果（平台侧异常 / 双方 load 失败）。 */
  private invalidResult(
    opponentName: string,
    selfLogs: string[],
    oppLogs: string[],
    reason: string,
    frames: FrameSnapshot[] = [],
    errorCounts: [number, number] = [0, 0],
  ): SimulateResult {
    return {
      outcome: { kind: 'invalid', reason },
      ticks: frames.length > 0 ? frames[frames.length - 1]!.tick : 0,
      frames,
      selfStats: { hp: null, stars: null, errors: errorCounts[0] },
      opponentStats: { hp: null, stars: null, errors: errorCounts[1] },
      selfName: 'self',
      opponentName,
      logs: { self: selfLogs, opponent: oppLogs },
    };
  }

  /**
   * @param opponentSource 对手源码：API 层已把 bot / 策略版本解析成源码（见 app.ts），
   *   service 层不再重复解析，也不知道“版本属于谁”这类权限问题。
   */
  async run(input: SimulateInput, opponentName: string, opponentSource: string): Promise<SimulateResult> {
    const simId = `sim-${Date.now()}-${randomUUID()}`;
    const seed = deriveSeedFromMatchId(simId);

    const selfSandbox = this.deps.sandboxes.create();
    const oppSandbox = this.deps.sandboxes.create();
    const selfLogs: string[] = [];
    const oppLogs: string[] = [];
    const errorCounts: [number, number] = [0, 0];

    // makeEntrant：与 MatchRunner.makeEntrant 同构的错误包装（带方序号），
    // envelope 直接作为 act 返回值交给引擎；此处日志顺带汇总（每方 cap 100）。
    const makeEntrant = (
      index: 0 | 1,
      entrantId: string,
      sandbox: StrategySandbox,
      logs: string[],
    ) => ({
      entrantId,
      act: (observation: unknown) =>
        sandbox.act(observation).then((step) => {
          if (step.kind === 'error') {
            errorCounts[index] += 1;
            const e = new Error(step.message);
            (e as Error & { entrant: 0 | 1 }).entrant = index;
            throw e;
          }
          for (const line of step.action.logs) {
            if (logs.length < 100) logs.push(line);
          }
          return step.action;
        }),
    });

    // 与 MatchRunner 一致：load 失败的一方直接判负（对 simulate 映射为
    // winner=self/opponent）；双方都失败按 draw 处理。
    {
      const loads = await Promise.allSettled([
        selfSandbox.load(input.code, DEFAULT_STRATEGY_BUDGET),
        oppSandbox.load(opponentSource, DEFAULT_STRATEGY_BUDGET),
      ]);
      const selfFailed = loads[0]!.status === 'rejected';
      const oppFailed = loads[1]!.status === 'rejected';
      if (selfFailed || oppFailed) {
        const selfMsg = loads[0]!.status === 'rejected'
          ? String((loads[0] as PromiseRejectedResult).reason)
          : '';
        const oppMsg = loads[1]!.status === 'rejected'
          ? String((loads[1] as PromiseRejectedResult).reason)
          : '';
        await Promise.all([disposeQuietly(selfSandbox), disposeQuietly(oppSandbox)]);
        if (selfFailed && oppFailed) {
          return this.invalidResult(opponentName, selfLogs, oppLogs, '双方策略均载入失败');
        }
        if (selfFailed) {
          return {
            outcome: { kind: 'win', winner: 'opponent', reason: `我方策略载入失败: ${selfMsg}` },
            ticks: 0,
            frames: [],
            selfStats: { hp: null, stars: null, errors: 0 },
            opponentStats: { hp: null, stars: null, errors: 0 },
            selfName: 'self',
            opponentName,
            logs: { self: selfLogs, opponent: oppLogs },
          };
        }
        return {
          outcome: { kind: 'win', winner: 'self', reason: `对手策略载入失败: ${oppMsg}` },
          ticks: 0,
          frames: [],
          selfStats: { hp: null, stars: null, errors: 0 },
          opponentStats: { hp: null, stars: null, errors: 0 },
          selfName: 'self',
          opponentName,
          logs: { self: selfLogs, opponent: oppLogs },
        };
      }
    }

    // createInstance 必须在 try 之内：其抛错（地形/星位生成异常）同样属于平台故障，
    // 且此时两个沙箱已创建，只有 try/finally 能保证 dispose。
    const frames: FrameSnapshot[] = [];
    try {
      const game = this.deps.tankGame.createInstance(
        [
          makeEntrant(0, 'self', selfSandbox, selfLogs),
          makeEntrant(1, 'opponent', oppSandbox, oppLogs),
        ],
        { seed },
      );
      let guard = 0;
      while (!game.isOver()) {
        if (++guard > 100_000) {
          throw new Error('对局超过最大帧数上限（疑似死循环）');
        }
        const frame = await game.step();
        if (frame) frames.push(frame);
      }
      const result = game.result();
      if (!result) throw new Error('对局已结束但游戏未提供结果');
      const outcome = mapOutcome(result);
      const finalState = readFinalState(frames);
      return {
        outcome,
        ticks: frames.length > 0 ? frames[frames.length - 1]!.tick : 0,
        frames,
        selfStats: { ...readSideStats(finalState.self), errors: errorCounts[0] },
        opponentStats: { ...readSideStats(finalState.opponent), errors: errorCounts[1] },
        selfName: 'self',
        opponentName,
        logs: { self: selfLogs, opponent: oppLogs },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.invalidResult(opponentName, selfLogs, oppLogs, `平台执行故障: ${message}`, frames, errorCounts);
    } finally {
      await Promise.all([disposeQuietly(selfSandbox), disposeQuietly(oppSandbox)]);
      this.commitRateLimit(input.entrantId ?? '');
    }
  }
}
